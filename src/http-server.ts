#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
  getDb,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "bulgarian-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "bg_comp_search_decisions",
    description:
      "Full-text search across CPC enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and ZZK articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'злоупотреба с господстващо положение, картел')" },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_comp_get_decision",
    description:
      "Get a specific CPC decision by case number (e.g., 'КЗК-1234/2023').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "Case number (e.g., 'КЗК-1234/2023, CPC-2023-001')" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "bg_comp_search_mergers",
    description:
      "Search CPC merger control decisions (concentrations).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'концентрация, придобиване')" },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_comp_get_merger",
    description:
      "Get a specific merger control decision by case number (e.g., 'КЗК-К-123/2023').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "Merger case number (e.g., 'КЗК-К-123/2023')" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "bg_comp_list_sectors",
    description:
      "List all sectors with CPC enforcement activity, including decision and merger counts.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "bg_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "bg_comp_list_sources",
    description:
      "List all data sources used by this MCP server with provenance metadata: authority name, URL, data type, coverage, license, and last-updated timestamp.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "bg_comp_check_data_freshness",
    description:
      "Check the freshness of the underlying database: when it was last updated, how many decisions and mergers are indexed, and whether an update is recommended.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const _meta = {
      disclaimer: "This tool is not regulatory or legal advice. Verify all references against primary sources before making compliance decisions.",
      source_url: "https://www.cpc.bg/",
      copyright: "Data sourced from CPC Bulgaria (Commission for Protection of Competition). Official publications are in the public domain.",
      data_age: "Periodic updates; check bg_comp_check_data_freshness for current index timestamp.",
    };

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...((data !== null && typeof data === "object") ? data as object : { value: data }), _meta }, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "bg_comp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "bg_comp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.case_number);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.case_number}`);
          }
          return textContent(decision);
        }

        case "bg_comp_search_mergers": {
          const parsed = SearchMergersArgs.parse(args);
          const results = searchMergers({
            query: parsed.query,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "bg_comp_get_merger": {
          const parsed = GetMergerArgs.parse(args);
          const merger = getMerger(parsed.case_number);
          if (!merger) {
            return errorContent(`Merger case not found: ${parsed.case_number}`);
          }
          return textContent(merger);
        }

        case "bg_comp_list_sectors": {
          const sectors = listSectors();
          return textContent({ sectors, count: sectors.length });
        }

        case "bg_comp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "CPC (Commission for Protection of Competition / Комисия за защита на конкуренцията) MCP server. Provides access to Bulgarian competition law enforcement decisions, merger control cases, and sector enforcement data under the ZZK (Zakon za Zashtita na Konkurentsiyata).",
            data_source: "CPC Bulgaria (https://www.cpc.bg/)",
            coverage: {
              decisions: "Abuse of dominance, cartel enforcement, and sector inquiries under ZZK",
              mergers: "Merger control decisions (concentrations) — Phase I and Phase II",
              sectors: "Telecommunications, energy, retail, financial services, healthcare, media, digital economy",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        case "bg_comp_list_sources": {
          return textContent({
            sources: [
              {
                id: "cpc-bg-decisions",
                authority: "CPC Bulgaria — Commission for Protection of Competition (Комисия за защита на конкуренцията)",
                url: "https://www.cpc.bg/",
                data_type: "enforcement_decisions",
                coverage: "Abuse of dominance, cartel, and sector inquiry decisions under ZZK",
                license: "Public domain — official government publications",
                jurisdiction: "BG",
                language: ["bg", "en"],
              },
              {
                id: "cpc-bg-mergers",
                authority: "CPC Bulgaria — Commission for Protection of Competition (Комисия за защита на конкуренцията)",
                url: "https://www.cpc.bg/",
                data_type: "merger_control",
                coverage: "Concentration notifications and decisions under ZZK Chapter VII",
                license: "Public domain — official government publications",
                jurisdiction: "BG",
                language: ["bg", "en"],
              },
            ],
          });
        }

        case "bg_comp_check_data_freshness": {
          const db = getDb();
          const decisionCount = (db.prepare("SELECT COUNT(*) as n FROM decisions").get() as { n: number }).n;
          const mergerCount = (db.prepare("SELECT COUNT(*) as n FROM mergers").get() as { n: number }).n;
          const latestDecision = (db.prepare("SELECT MAX(date) as d FROM decisions").get() as { d: string | null }).d;
          const latestMerger = (db.prepare("SELECT MAX(date) as d FROM mergers").get() as { d: string | null }).d;
          return textContent({
            index_counts: { decisions: decisionCount, mergers: mergerCount },
            latest_decision_date: latestDecision,
            latest_merger_date: latestMerger,
            update_recommended: decisionCount === 0,
            note: "Run the ingest script to refresh data from CPC Bulgaria.",
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
