#!/usr/bin/env node

/**
 * Bulgarian Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying CPC (Commission for Protection of Competition)
 * decisions, merger control cases, and sector enforcement activity under
 * Bulgarian competition law (ZZK — Zakon za Zashtita na Konkurentsiyata).
 *
 * Tool prefix: bg_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { searchDecisions, getDecision, searchMergers, getMerger, listSectors } from "./db.js";
import { buildCitation } from './citation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
  pkgVersion = pkg.version;
} catch { /* fallback */ }

const SERVER_NAME = "bulgarian-competition-mcp";

const TOOLS = [
  {
    name: "bg_comp_search_decisions",
    description: "Full-text search across CPC enforcement decisions (abuse of dominance, cartels, sector inquiries) under Bulgarian competition law (ZZK). Returns matching decisions with case number, parties, outcome, fine amount, and ZZK articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'злоупотреба с господстващо положение', 'картел', 'концентрация')" },
        type: { type: "string", enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"], description: "Filter by decision type. Optional." },
        sector: { type: "string", description: "Filter by sector ID (e.g., 'telecommunications', 'energy', 'retail'). Optional." },
        outcome: { type: "string", enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"], description: "Filter by outcome. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_comp_get_decision",
    description: "Get a specific CPC decision by case number (e.g., 'КЗК-1234/2023', 'CPC-2023-001').",
    inputSchema: {
      type: "object" as const,
      properties: { case_number: { type: "string", description: "CPC case number" } },
      required: ["case_number"],
    },
  },
  {
    name: "bg_comp_search_mergers",
    description: "Search CPC merger control decisions (concentrations). Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'концентрация', 'придобиване', 'телекомуникации')" },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: { type: "string", enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"], description: "Filter by merger outcome. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_comp_get_merger",
    description: "Get a specific CPC merger control decision by case number.",
    inputSchema: {
      type: "object" as const,
      properties: { case_number: { type: "string", description: "CPC merger case number" } },
      required: ["case_number"],
    },
  },
  {
    name: "bg_comp_list_sectors",
    description: "List all sectors with CPC enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "bg_comp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetDecisionArgs = z.object({ case_number: z.string().min(1) });
const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetMergerArgs = z.object({ case_number: z.string().min(1) });

function textContent(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }; }
function errorContent(message: string) { return { content: [{ type: "text" as const, text: message }], isError: true as const }; }

const server = new Server({ name: SERVER_NAME, version: pkgVersion }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "bg_comp_search_decisions": {
        const p = SearchDecisionsArgs.parse(args);
        const r = searchDecisions({ query: p.query, type: p.type, sector: p.sector, outcome: p.outcome, limit: p.limit });
        return textContent({ results: r, count: r.length });
      }
      case "bg_comp_get_decision": {
        const p = GetDecisionArgs.parse(args);
        const d = getDecision(p.case_number);
        if (!d) return errorContent(`Decision not found: ${p.case_number}`);
        return textContent({
          ...(typeof d === 'object' ? d : { data: d }),
          _citation: buildCitation(
            d.case_number || p.case_number,
            d.title || d.subject || p.case_number,
            'bg_comp_get_decision',
            { case_number: p.case_number },
            d.url || d.source_url || null,
          ),
        });
      }
      case "bg_comp_search_mergers": {
        const p = SearchMergersArgs.parse(args);
        const r = searchMergers({ query: p.query, sector: p.sector, outcome: p.outcome, limit: p.limit });
        return textContent({ results: r, count: r.length });
      }
      case "bg_comp_get_merger": {
        const p = GetMergerArgs.parse(args);
        const m = getMerger(p.case_number);
        if (!m) return errorContent(`Merger case not found: ${p.case_number}`);
        return textContent({
          ...(typeof m === 'object' ? m : { data: m }),
          _citation: buildCitation(
            m.case_number || p.case_number,
            m.title || m.subject || p.case_number,
            'bg_comp_get_merger',
            { case_number: p.case_number },
            m.url || m.source_url || null,
          ),
        });
      }
      case "bg_comp_list_sectors": {
        const s = listSectors();
        return textContent({ sectors: s, count: s.length });
      }
      case "bg_comp_about":
        return textContent({
          name: SERVER_NAME, version: pkgVersion,
          description: "CPC (Commission for Protection of Competition / Комисия за защита на конкуренцията) MCP server. Provides access to Bulgarian competition law enforcement decisions, merger control cases, and sector enforcement data under the ZZK (Zakon za Zashtita na Konkurentsiyata).",
          data_source: "CPC Bulgaria (https://www.cpc.bg/)",
          coverage: { decisions: "Abuse of dominance, cartel enforcement, and sector inquiries under ZZK", mergers: "Merger control decisions (concentrations) — Phase I and Phase II", sectors: "Telecommunications, energy, retail, financial services, healthcare, media, digital economy" },
          tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
        });
      default: return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) { return errorContent(`Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`); }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}
main().catch(err => { process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
