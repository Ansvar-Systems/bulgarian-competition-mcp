#!/usr/bin/env tsx
/**
 * Ingestion crawler for the CPC (Комисия за защита на конкуренцията) public register.
 *
 * Source: https://reg.cpc.bg
 *
 * Two-phase pipeline:
 *   Phase 1 (Index):   Crawl DepartmentDecisions.aspx by category (vp param) to
 *                      collect dossier IDs and decision metadata. Categories:
 *                        vp=3  — Концентрации (Mergers/Concentrations) — 668 entries
 *                        vp=10 — Забранени споразумения и злоупотреби (Cartels + Abuse) — 393 entries
 *                        vp=4  — Секторни анализи (Sector analyses) — ~50 entries
 *                        vp=6  — Нелоялна конкуренция (Unfair competition) — ~200 entries
 *                      Also crawls AllNewResolutions.aspx?dt=1&ot=2 for recent
 *                      ЗЗК decisions not yet categorised by department.
 *
 *   Phase 2 (Detail):  Fetch each Dossier.aspx?DossID=<id> page, extract full
 *                      case data (metadata, parties, outcome, decision text).
 *
 * The CPC register is an ASP.NET WebForms application with __doPostBack
 * pagination. We carry __VIEWSTATE / __EVENTVALIDATION between requests.
 *
 * Usage:
 *   npx tsx scripts/ingest-cpc.ts
 *   npx tsx scripts/ingest-cpc.ts --resume
 *   npx tsx scripts/ingest-cpc.ts --dry-run
 *   npx tsx scripts/ingest-cpc.ts --force
 *   npx tsx scripts/ingest-cpc.ts --limit 50
 *   npx tsx scripts/ingest-cpc.ts --category mergers
 *   npx tsx scripts/ingest-cpc.ts --resume --category abuse
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["CPC_BG_DB_PATH"] ?? "data/cpc-bg.db";
const STATE_FILE = resolve(__dirname, "../data/.ingest-state.json");

const BASE_URL = "https://reg.cpc.bg";
const DEPT_DECISIONS_PATH = "/DepartmentDecisions.aspx";
const NEW_RESOLUTIONS_PATH = "/AllNewResolutions.aspx";
const DOSSIER_PATH = "/Dossier.aspx";
const USER_AGENT =
  "AnsvarCPCCrawler/1.0 (legal-research; contact: hello@ansvar.ai)";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RESULTS_PER_PAGE = 5; // CPC shows 5 results per page

/**
 * CPC department category codes (vp parameter on DepartmentDecisions.aspx).
 * Mapped from the main site navigation at cpc.bg.
 */
const CATEGORIES = {
  mergers: { vp: 3, label: "Концентрации (Mergers)" },
  abuse: { vp: 10, pp: 2, label: "Злоупотреби (Abuse of dominance)" },
  cartels: { vp: 10, pp: 1, label: "Забранени споразумения (Cartels)" },
  sectors: { vp: 4, label: "Секторни анализи (Sector analyses)" },
  unfair: { vp: 6, label: "Нелоялна конкуренция (Unfair competition)" },
} as const;

type CategoryKey = keyof typeof CATEGORIES;
const ALL_CATEGORIES: CategoryKey[] = [
  "mergers",
  "abuse",
  "cartels",
  "sectors",
  "unfair",
];

// CPC register URL parameter: dt=1 -> ЗЗК (Law on Protection of Competition)
const DT_ZZK = 1;
// ot=2 -> Решения (Decisions)
const OT_DECISIONS = 2;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  limit: number;
  category: CategoryKey | "all" | "recent";
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    resume: false,
    dryRun: false,
    force: false,
    limit: 0,
    category: "all",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--resume":
        opts.resume = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--limit":
        opts.limit = parseInt(args[++i] ?? "0", 10);
        break;
      case "--category": {
        const val = args[++i] ?? "";
        if (
          val === "all" ||
          val === "recent" ||
          ALL_CATEGORIES.includes(val as CategoryKey)
        ) {
          opts.category = val as CliOptions["category"];
        } else {
          console.error(
            `Unknown category: ${val}. Valid: ${ALL_CATEGORIES.join(", ")}, all, recent`,
          );
          process.exit(1);
        }
        break;
      }
      case "--help":
        console.log(
          `Usage: npx tsx scripts/ingest-cpc.ts [options]

Options:
  --resume       Resume from last saved state
  --dry-run      Crawl and parse but do not write to database
  --force        Delete existing database before ingestion
  --limit N      Process at most N dossiers in phase 2
  --category X   Crawl only one category: ${ALL_CATEGORIES.join(", ")}, all, recent

Categories:
  mergers   — Концентрации (vp=3, ~668 decisions)
  abuse     — Злоупотреби с господстващо положение (vp=10, pp=2)
  cartels   — Забранени споразумения (vp=10, pp=1)
  sectors   — Секторни анализи (vp=4)
  unfair    — Нелоялна конкуренция (vp=6)
  recent    — AllNewResolutions.aspx (latest ЗЗК decisions)
  all       — All categories + recent (default)`,
        );
        process.exit(0);
        break;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

interface IngestState {
  /** Categories fully indexed (all pages crawled). */
  indexedCategories: string[];
  /** Dossier IDs already fetched and written to DB. */
  processedDossierIds: string[];
  /** Timestamp of last run. */
  lastRunAt: string;
}

function loadState(): IngestState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as IngestState;
  } catch {
    return null;
  }
}

function saveState(state: IngestState): void {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.lastRunAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Rate-limited HTTP fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        ...init,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "bg-BG,bg;q=0.9,en;q=0.5",
          ...(init?.headers as Record<string, string> | undefined),
        },
        redirect: "follow",
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }

      return resp;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const backoff = attempt * 2_000;
      console.warn(
        `  Retry ${attempt}/${MAX_RETRIES} for ${url} (waiting ${backoff}ms)`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw new Error(`Unreachable: failed to fetch ${url}`);
}

async function fetchHtml(url: string, init?: RequestInit): Promise<string> {
  const resp = await rateLimitedFetch(url, init);
  return resp.text();
}

// ---------------------------------------------------------------------------
// ASP.NET ViewState helpers
// ---------------------------------------------------------------------------

interface AspNetState {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
}

function extractAspNetState(html: string): AspNetState {
  const $ = cheerio.load(html);
  return {
    viewState: ($("#__VIEWSTATE").val() as string) ?? "",
    viewStateGenerator: ($("#__VIEWSTATEGENERATOR").val() as string) ?? "",
    eventValidation: ($("#__EVENTVALIDATION").val() as string) ?? "",
  };
}

function buildPostBackBody(
  aspState: AspNetState,
  eventTarget: string,
  eventArgument = "",
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("__VIEWSTATE", aspState.viewState);
  params.set("__VIEWSTATEGENERATOR", aspState.viewStateGenerator);
  params.set("__EVENTVALIDATION", aspState.eventValidation);
  params.set("__EVENTTARGET", eventTarget);
  params.set("__EVENTARGUMENT", eventArgument);
  return params;
}

// ---------------------------------------------------------------------------
// Phase 1: Crawl the department decisions index
// ---------------------------------------------------------------------------

interface IndexEntry {
  dossId: string;
  decisionNumber: string;
  decisionDate: string;
  outcome: string;
  caseNumber: string;
  proceedingType: string;
  subject: string;
  initiators: string;
  respondents: string;
  sourceCategory: string;
}

/**
 * Build the initial URL for a department category page.
 */
function buildCategoryUrl(category: CategoryKey): string {
  const cfg = CATEGORIES[category];
  let url = `${BASE_URL}${DEPT_DECISIONS_PATH}?vp=${cfg.vp}`;
  if ("pp" in cfg && cfg.pp !== undefined) {
    url += `&pp=${cfg.pp}`;
  }
  return url;
}

/**
 * Parse decision/resolution rows from a DepartmentDecisions grid page.
 *
 * The grid table (id containing "gvDecisions" or similar) has columns:
 *   0: Decision number (e.g. "АКТ-237-13.03.2026")
 *   1: Decision date
 *   2: Outcome text ("Произнасяне")
 *   3: Legal basis
 *   4: Case number (links to Dossier.aspx?DossID=NNNN)
 *   5: Proceeding type
 *   6: Subject
 *   7: Initiator(s) / Parties
 *   8: Respondent(s)
 *   9+: Appeal deadline, appeal status, publication date, PDF/ODF links
 */
function parseDecisionRows(
  html: string,
  sourceCategory: string,
): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  // Find the main data table — CPC uses GridView which renders as <table>.
  // Look for tables with dossier links inside.
  const tables = $("table").filter((_i, el) => {
    return $(el).find("a[href*='DossID']").length > 0;
  });

  const dataTable = tables.length > 0 ? tables.first() : $("table").last();

  dataTable.find("tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 7) return; // skip header / pager rows

    // Extract DossID from any link in the row
    let dossId = "";
    $(row)
      .find("a[href*='DossID']")
      .each((_j, link) => {
        const href = $(link).attr("href") ?? "";
        const match = href.match(/DossID=(\d+)/);
        if (match?.[1] && !dossId) {
          dossId = match[1];
        }
      });

    // Also check for __doPostBack links that may contain the dossier nav
    if (!dossId) {
      $(row)
        .find("a[href*='doPostBack']")
        .each((_j, link) => {
          const href = $(link).attr("href") ?? "";
          // Some pages use postback for dossier links; capture the case number
          // but flag dossId as missing — we will try the search endpoint later.
          void href;
        });
    }

    const decisionNumber = cells.eq(0).text().trim();
    const decisionDate = cells.eq(1).text().trim();
    const outcome = cells.eq(2).text().trim();
    // cells.eq(3) = legal basis (skip)
    const caseNumber =
      cells.eq(4).text().trim() ||
      $(row).find("a[href*='DossID']").first().text().trim();
    const proceedingType = cells.eq(5).text().trim();
    const subject = cells.eq(6).text().trim();
    const initiators = cells.length > 7 ? cells.eq(7).text().trim() : "";
    const respondents = cells.length > 8 ? cells.eq(8).text().trim() : "";

    if (!decisionNumber && !caseNumber) return;

    entries.push({
      dossId,
      decisionNumber,
      decisionDate,
      outcome,
      caseNumber: caseNumber || decisionNumber,
      proceedingType,
      subject,
      initiators,
      respondents,
      sourceCategory,
    });
  });

  return entries;
}

/**
 * Extract the total results count from a DepartmentDecisions page.
 * The page shows text like "Намерени са общо 668 решение, определения и разпореждания".
 */
function extractTotalCount(html: string): number {
  const match = html.match(
    /Намерени са общо\s+(\d+)\s+решени/,
  );
  if (match?.[1]) return parseInt(match[1], 10);

  // Fallback: look for "от NN" in pagination text
  const fallback = html.match(/от\s+(\d+)/);
  if (fallback?.[1]) return parseInt(fallback[1], 10);

  return 0;
}

/**
 * Navigate to the next page of results using the ASP.NET "Next" postback.
 * Returns null if no next page exists.
 */
async function navigateToNextPage(
  html: string,
  baseUrl: string,
): Promise<string | null> {
  const $ = cheerio.load(html);
  const aspState = extractAspNetState(html);

  // Next-page link patterns in CPC registry:
  //   - <a id="...lnkButtonNext" href="javascript:__doPostBack('...','')" ...>
  //   - Image buttons with alt="Next" or "Следваща"
  let nextControlId: string | null = null;

  // Pattern 1: link with "Next" or "Следваща" in id/text
  $("a").each((_i, el) => {
    const id = $(el).attr("id") ?? "";
    const href = $(el).attr("href") ?? "";
    const title = $(el).attr("title") ?? "";
    if (
      (id.includes("lnkButtonNext") ||
        id.includes("Next") ||
        title.includes("Следваща") ||
        title.includes("следваща")) &&
      href.includes("__doPostBack")
    ) {
      const match = href.match(/__doPostBack\('([^']+)'/);
      if (match?.[1]) nextControlId = match[1];
    }
  });

  // Pattern 2: image button for next page
  if (!nextControlId) {
    $("input[type='image'], a > img").each((_i, el) => {
      const alt = $(el).attr("alt") ?? "";
      const title = $(el).attr("title") ?? "";
      if (
        alt.includes("Следваща") ||
        alt.includes("Next") ||
        title.includes("Следваща")
      ) {
        const parent = $(el).closest("a");
        const href = parent.attr("href") ?? "";
        const match = href.match(/__doPostBack\('([^']+)'/);
        if (match?.[1]) nextControlId = match[1];
      }
    });
  }

  if (!nextControlId) return null;

  const body = buildPostBackBody(aspState, nextControlId);

  return fetchHtml(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/**
 * Crawl all pages of a department category.
 */
async function crawlCategory(
  categoryKey: CategoryKey,
): Promise<IndexEntry[]> {
  const cfg = CATEGORIES[categoryKey];
  const url = buildCategoryUrl(categoryKey);

  console.log(`\nCrawling category: ${cfg.label}`);
  console.log(`  URL: ${url}`);

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error(`  Failed to fetch category page: ${err}`);
    return [];
  }

  const totalCount = extractTotalCount(html);
  const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE) || 1;
  console.log(
    `  Total results: ${totalCount} (~${totalPages} pages of ${RESULTS_PER_PAGE})`,
  );

  const allEntries: IndexEntry[] = [];
  let pageNum = 1;

  while (true) {
    const entries = parseDecisionRows(html, categoryKey);
    console.log(`  Page ${pageNum}/${totalPages}: ${entries.length} entries`);
    allEntries.push(...entries);

    if (pageNum >= totalPages) break;

    const nextHtml = await navigateToNextPage(html, url);
    if (!nextHtml) {
      console.log(`  No next page found at page ${pageNum}`);
      break;
    }

    html = nextHtml;
    pageNum++;
  }

  console.log(`  Category total: ${allEntries.length} entries collected`);
  return allEntries;
}

/**
 * Crawl AllNewResolutions.aspx for recent ЗЗК decisions.
 * This page shows decisions by date (most recent first) and uses
 * date-based navigation via __doPostBack on date links.
 */
async function crawlRecentDecisions(): Promise<IndexEntry[]> {
  const url = `${BASE_URL}${NEW_RESOLUTIONS_PATH}?dt=${DT_ZZK}&ot=${OT_DECISIONS}`;
  console.log(`\nCrawling recent ЗЗК decisions`);
  console.log(`  URL: ${url}`);

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error(`  Failed to fetch recent decisions: ${err}`);
    return [];
  }

  // The page shows decisions for the most recent date by default.
  // Date links on the left allow navigating to other dates.
  // We crawl the visible dates (typically 14 days shown).
  const allEntries: IndexEntry[] = [];

  // Parse the currently visible decisions
  const currentEntries = parseDecisionRows(html, "recent");
  console.log(`  Current date: ${currentEntries.length} entries`);
  allEntries.push(...currentEntries);

  // Extract date navigation links and crawl each one
  const $ = cheerio.load(html);
  const dateLinks: Array<{ text: string; controlId: string }> = [];

  $("a").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim();
    // Date links match DD.MM.YYYY format and use __doPostBack
    if (text.match(/^\d{2}\.\d{2}\.\d{4}$/) && href.includes("doPostBack")) {
      const match = href.match(/__doPostBack\('([^']+)'/);
      if (match?.[1]) {
        dateLinks.push({ text, controlId: match[1] });
      }
    }
  });

  console.log(`  Found ${dateLinks.length} date navigation links`);

  for (const dateLink of dateLinks) {
    const aspState = extractAspNetState(html);
    const body = buildPostBackBody(aspState, dateLink.controlId);

    try {
      const dateHtml = await fetchHtml(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      const entries = parseDecisionRows(dateHtml, "recent");
      console.log(`  Date ${dateLink.text}: ${entries.length} entries`);
      allEntries.push(...entries);

      // Update HTML for next iteration's ViewState
      html = dateHtml;
    } catch (err) {
      console.warn(`  Failed to fetch date ${dateLink.text}: ${err}`);
    }
  }

  console.log(`  Recent total: ${allEntries.length} entries collected`);
  return allEntries;
}

// ---------------------------------------------------------------------------
// Phase 2: Fetch dossier detail pages
// ---------------------------------------------------------------------------

interface DossierDetail {
  caseNumber: string;
  description: string;
  dateOpened: string;
  dateClosed: string;
  proceedingType: string;
  subject: string;
  subSubject: string;
  initiators: string;
  respondents: string;
  status: string;
  decisionNumber: string;
  decisionDate: string;
  decisionOutcome: string;
  publicationDate: string;
}

async function fetchDossierDetail(dossId: string): Promise<DossierDetail> {
  const url = `${BASE_URL}${DOSSIER_PATH}?DossID=${dossId}`;
  console.log(`  Fetching dossier ${dossId}: ${url}`);
  const html = await fetchHtml(url);
  return parseDossierPage(html);
}

function parseDossierPage(html: string): DossierDetail {
  const $ = cheerio.load(html);

  /**
   * Find a value by its label text in the page layout.
   * CPC dossier pages use table-based layouts where the label is in one cell
   * and the value is in the next cell or a sibling element.
   */
  function fieldByLabel(label: string): string {
    let value = "";
    $("td, th, dt, span, label").each((_i, el) => {
      const text = $(el).text().trim();
      if (text.includes(label)) {
        // Value is typically in the next sibling cell or dd element
        const next = $(el).next("td, dd, span");
        if (next.length > 0) {
          value = next.text().trim();
        }
        // Or in the parent row's last td
        if (!value) {
          const parentRow = $(el).closest("tr");
          const tds = parentRow.find("td");
          if (tds.length > 1) {
            value = tds.last().text().trim();
          }
        }
      }
    });
    return value;
  }

  // Extract main case fields from the page
  const caseNumber =
    fieldByLabel("Производство №") || fieldByLabel("Производство") || "";
  const description = fieldByLabel("Описание") || "";
  const dateOpened = fieldByLabel("Дата на образуване") || "";
  const dateClosed = fieldByLabel("Дата на приключване") || "";
  const proceedingType = fieldByLabel("Вид производство") || "";
  const subject = fieldByLabel("Предмет") || "";
  const subSubject = fieldByLabel("подпредмет") || "";
  const initiators = fieldByLabel("Инициатор") || "";
  const respondents = fieldByLabel("Ответник") || "";
  const status = fieldByLabel("Текущ статус") || "";

  // Extract decision info from the documents grid (gvDocs)
  let decisionNumber = "";
  let decisionDate = "";
  let decisionOutcome = "";
  let publicationDate = "";

  $("table[id*='gvDocs'] tr, table tr").each((_i, row) => {
    const cells = $(row).find("td");
    const rowText = $(row).text();

    // Decision rows contain "АКТ-" prefix (the act/decision number format)
    if (rowText.includes("АКТ-") || rowText.includes("Решение")) {
      cells.each((_j, cell) => {
        const cellText = $(cell).text().trim();
        // Decision number format: АКТ-196-25.02.2026
        if (cellText.match(/АКТ-\d+-/)) {
          decisionNumber = cellText;
        }
        // Date format: DD.MM.YYYY г.
        if (!decisionDate && cellText.match(/^\d{2}\.\d{2}\.\d{4}/)) {
          decisionDate = cellText.replace(/\s*г\.?\s*$/, "");
        }
        // Outcome keywords
        if (
          cellText.includes("Разрешава") ||
          cellText.includes("разрешава") ||
          cellText.includes("прекратява") ||
          cellText.includes("забранява") ||
          cellText.includes("установява") ||
          cellText.includes("налага") ||
          cellText.includes("отменя") ||
          cellText.includes("отхвърля") ||
          cellText.includes("одобрява") ||
          cellText.includes("образува")
        ) {
          decisionOutcome = cellText;
        }
      });
    }
  });

  // Publication date
  publicationDate = fieldByLabel("Дата на публикуване") || "";

  return {
    caseNumber,
    description,
    dateOpened,
    dateClosed,
    proceedingType,
    subject,
    subSubject,
    initiators,
    respondents,
    status,
    decisionNumber,
    decisionDate,
    decisionOutcome,
    publicationDate,
  };
}

// ---------------------------------------------------------------------------
// Data classification helpers
// ---------------------------------------------------------------------------

/**
 * Map CPC subject categories to DB decision types.
 * Uses the Bulgarian legal terminology from CPC register subjects.
 */
function classifyDecisionType(
  subject: string,
  outcome: string,
  sourceCategory: string,
): string {
  // Source category gives the strongest signal
  if (sourceCategory === "mergers") return "merger";
  if (sourceCategory === "cartels") return "cartel";
  if (sourceCategory === "abuse") return "abuse_of_dominance";
  if (sourceCategory === "sectors") return "sector_inquiry";
  if (sourceCategory === "unfair") return "unfair_competition";

  // Fall back to text analysis for "recent" category entries
  const s = subject.toLowerCase();
  const o = outcome.toLowerCase();

  if (s.includes("концентрац") || o.includes("концентрац")) {
    return "merger";
  }
  if (
    s.includes("картел") ||
    s.includes("забранени споразумения") ||
    s.includes("чл. 15")
  ) {
    return "cartel";
  }
  if (
    s.includes("злоупотреб") ||
    s.includes("господстващо") ||
    s.includes("монополн") ||
    s.includes("чл. 21")
  ) {
    return "abuse_of_dominance";
  }
  if (s.includes("нелоялна конкуренция") || s.includes("нелоялн")) {
    return "unfair_competition";
  }
  if (s.includes("секторн") || s.includes("секторно проучване")) {
    return "sector_inquiry";
  }
  return "other";
}

/**
 * Map CPC outcome text to a normalised outcome value.
 * Based on the standard Bulgarian decision pronouncement language.
 */
function classifyOutcome(outcomeText: string): string {
  const o = outcomeText.toLowerCase();

  if (
    o.includes("разрешава концентрацията") &&
    !o.includes("условия") &&
    !o.includes("промени")
  ) {
    return "cleared_phase1";
  }
  if (
    o.includes("разрешава") &&
    (o.includes("условия") || o.includes("промени") || o.includes("изменен"))
  ) {
    return "cleared_with_conditions";
  }
  if (o.includes("разрешава")) {
    return "cleared";
  }
  if (o.includes("забранява")) {
    return "prohibited";
  }
  if (o.includes("прекратява")) {
    return "terminated";
  }
  if (
    o.includes("установява нарушение") ||
    o.includes("налага санкция") ||
    o.includes("налага имуществена")
  ) {
    return "fine";
  }
  if (o.includes("установява")) {
    return "infringement_found";
  }
  if (o.includes("не установява нарушение") || o.includes("не установява")) {
    return "cleared";
  }
  if (o.includes("отхвърля")) {
    return "rejected";
  }
  if (o.includes("отменя")) {
    return "annulled";
  }
  if (o.includes("одобрява")) {
    return "approved";
  }
  if (o.includes("образува производство") || o.includes("самосезира")) {
    return "proceeding_opened";
  }
  return "other";
}

/**
 * Infer sector from case description and subject.
 * Keyword matching against common Bulgarian industry terms.
 */
function classifySector(description: string, subject: string): string {
  const text = `${description} ${subject}`.toLowerCase();

  const sectorMap: Array<[string, string[]]> = [
    [
      "telecommunications",
      ["телеком", "мобилн", "интернет", "широколентов", "оператор", "съобщен"],
    ],
    [
      "energy",
      [
        "енерг",
        "електро",
        "газ",
        "топлофикация",
        "топлоснабдяване",
        "горив",
        "нефт",
        "петрол",
      ],
    ],
    [
      "retail",
      [
        "търговия на дребно",
        "хранителн",
        "верига магазин",
        "супермаркет",
        "търговск",
      ],
    ],
    [
      "financial_services",
      ["банк", "застрахо", "финансов", "платежн", "кредит", "пенсион"],
    ],
    [
      "digital_economy",
      ["цифров", "дигитал", "онлайн", "платформ", "електронна търговия"],
    ],
    [
      "media",
      ["меди", "телевизи", "радио", "реклам", "издателс", "печатн"],
    ],
    [
      "pharma",
      ["фармацевт", "лекарств", "аптек", "медицинск", "здравн"],
    ],
    [
      "transport",
      [
        "транспорт",
        "логист",
        "жп",
        "летищ",
        "пристанищ",
        "авиокомпан",
        "жел.пътн",
      ],
    ],
    [
      "construction",
      ["строител", "имот", "недвижим", "инфраструктур"],
    ],
    [
      "agriculture",
      [
        "земедел",
        "храни",
        "млечн",
        "месо",
        "зърн",
        "селскостопанс",
        "агро",
      ],
    ],
    [
      "automotive",
      ["автомобил", "превозн", "моторн"],
    ],
    [
      "water",
      ["водоснабд", "вик", "канализац", "водопровод"],
    ],
  ];

  for (const [sector, keywords] of sectorMap) {
    if (keywords.some((kw) => text.includes(kw))) {
      return sector;
    }
  }

  return "other";
}

/** Extract fine amount from outcome text (if mentioned). */
function extractFineAmount(text: string): number | null {
  // Patterns: "1 200 000 лв.", "1,200,000 лева", "1200000 BGN"
  const match = text.match(/([\d\s,.]+)\s*(?:лв\.?|лева|BGN)/i);
  if (!match?.[1]) return null;

  const numStr = match[1].replace(/[\s.]/g, "").replace(",", ".");
  const amount = parseFloat(numStr);
  return isNaN(amount) ? null : amount;
}

/** Parse DD.MM.YYYY date to ISO YYYY-MM-DD. */
function parseDate(bgDate: string): string | null {
  const cleaned = bgDate.replace(/\s*г\.?\s*$/, "").trim();
  const match = cleaned.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/** Extract ЗЗК article references from subject/outcome text. */
function extractArticles(text: string): string[] {
  const articles: Set<string> = new Set();
  // "чл. 15", "чл.21", "чл. 101 ДФЕС"
  const matches = text.matchAll(/чл\.?\s*(\d+)/g);
  for (const m of matches) {
    if (m[1]) articles.add(m[1]);
  }
  return [...articles];
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function upsertDecision(
  db: Database.Database,
  entry: IndexEntry,
  detail: DossierDetail,
): void {
  const caseNumber = detail.caseNumber || entry.caseNumber;
  const title =
    detail.description ||
    [entry.subject, entry.initiators].filter(Boolean).join(" — ");
  const date = parseDate(detail.decisionDate || entry.decisionDate);
  const type = classifyDecisionType(
    detail.subject + " " + detail.subSubject,
    detail.decisionOutcome,
    entry.sourceCategory,
  );
  const sector = classifySector(detail.description, detail.subject);
  const parties = [detail.initiators, detail.respondents]
    .filter(Boolean)
    .filter((p) => p !== "-");
  const summary = detail.decisionOutcome || entry.outcome;
  const fullText = [
    `Производство: ${caseNumber}`,
    detail.description ? `Описание: ${detail.description}` : "",
    `Предмет: ${detail.subject}`,
    detail.subSubject ? `Подпредмет: ${detail.subSubject}` : "",
    `Инициатор(и): ${detail.initiators}`,
    detail.respondents && detail.respondents !== "-"
      ? `Ответник(ници): ${detail.respondents}`
      : "",
    `Статус: ${detail.status}`,
    `Решение: ${detail.decisionNumber}`,
    `Дата на решение: ${detail.decisionDate}`,
    `Произнасяне: ${detail.decisionOutcome}`,
  ]
    .filter(Boolean)
    .join("\n");
  const outcome = classifyOutcome(detail.decisionOutcome || entry.outcome);
  const fineAmount = extractFineAmount(
    detail.decisionOutcome || entry.outcome,
  );
  const articles = extractArticles(
    `${detail.subject} ${detail.subSubject} ${detail.decisionOutcome}`,
  );
  const status = detail.status.includes("приключ") ? "final" : "pending";

  db.prepare(
    `INSERT INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_number) DO UPDATE SET
       title = excluded.title,
       date = excluded.date,
       type = excluded.type,
       sector = excluded.sector,
       parties = excluded.parties,
       summary = excluded.summary,
       full_text = excluded.full_text,
       outcome = excluded.outcome,
       fine_amount = excluded.fine_amount,
       gwb_articles = excluded.gwb_articles,
       status = excluded.status`,
  ).run(
    caseNumber,
    title,
    date,
    type,
    sector,
    JSON.stringify(parties),
    summary,
    fullText,
    outcome,
    fineAmount,
    JSON.stringify(articles),
    status,
  );
}

function upsertMerger(
  db: Database.Database,
  entry: IndexEntry,
  detail: DossierDetail,
): void {
  const caseNumber = detail.caseNumber || entry.caseNumber;
  const title =
    detail.description ||
    [entry.subject, entry.initiators].filter(Boolean).join(" — ");
  const date = parseDate(detail.decisionDate || entry.decisionDate);
  const sector = classifySector(detail.description, detail.subject);
  const acquiringParty = detail.initiators || entry.initiators;
  const target = detail.respondents !== "-" ? detail.respondents : null;
  const summary = detail.decisionOutcome || entry.outcome;
  const fullText = [
    `Производство: ${caseNumber}`,
    detail.description ? `Описание: ${detail.description}` : "",
    `Предмет: ${detail.subject}`,
    detail.subSubject ? `Подпредмет: ${detail.subSubject}` : "",
    `Инициатор(и): ${detail.initiators}`,
    detail.respondents && detail.respondents !== "-"
      ? `Ответник(ници): ${detail.respondents}`
      : "",
    `Статус: ${detail.status}`,
    `Решение: ${detail.decisionNumber}`,
    `Дата на решение: ${detail.decisionDate}`,
    `Произнасяне: ${detail.decisionOutcome}`,
  ]
    .filter(Boolean)
    .join("\n");
  const outcome = classifyOutcome(detail.decisionOutcome || entry.outcome);

  db.prepare(
    `INSERT INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_number) DO UPDATE SET
       title = excluded.title,
       date = excluded.date,
       sector = excluded.sector,
       acquiring_party = excluded.acquiring_party,
       target = excluded.target,
       summary = excluded.summary,
       full_text = excluded.full_text,
       outcome = excluded.outcome`,
  ).run(
    caseNumber,
    title,
    date,
    sector,
    acquiringParty,
    target,
    summary,
    fullText,
    outcome,
    null, // turnover not available from public register
  );
}

function updateSectorCounts(db: Database.Database): void {
  const sectorNames: Record<string, [string, string]> = {
    telecommunications: ["Телекомуникации", "Telecommunications"],
    energy: ["Енергетика", "Energy"],
    retail: ["Търговия на дребно", "Retail"],
    financial_services: ["Финансови услуги", "Financial services"],
    digital_economy: ["Цифрова икономика", "Digital economy"],
    media: ["Медии", "Media"],
    pharma: ["Фармацевтика", "Pharmaceuticals"],
    transport: ["Транспорт", "Transport"],
    construction: ["Строителство", "Construction"],
    agriculture: ["Земеделие", "Agriculture"],
    automotive: ["Автомобилна индустрия", "Automotive"],
    water: ["Водоснабдяване", "Water supply"],
    other: ["Други", "Other"],
  };

  const decisionCounts = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM decisions GROUP BY sector")
    .all() as Array<{ sector: string; cnt: number }>;
  const mergerCounts = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM mergers GROUP BY sector")
    .all() as Array<{ sector: string; cnt: number }>;

  const sectorCounts: Record<string, { decisions: number; mergers: number }> =
    {};

  for (const { sector, cnt } of decisionCounts) {
    if (!sector) continue;
    sectorCounts[sector] = { decisions: cnt, mergers: 0 };
  }
  for (const { sector, cnt } of mergerCounts) {
    if (!sector) continue;
    if (!sectorCounts[sector])
      sectorCounts[sector] = { decisions: 0, mergers: 0 };
    sectorCounts[sector].mergers = cnt;
  }

  const stmt = db.prepare(
    `INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       decision_count = excluded.decision_count,
       merger_count = excluded.merger_count`,
  );

  for (const [id, counts] of Object.entries(sectorCounts)) {
    const [name, nameEn] = sectorNames[id] ?? [id, id];
    stmt.run(id, name, nameEn, null, counts.decisions, counts.mergers);
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log("CPC (Комисия за защита на конкуренцията) Ingestion Crawler");
  console.log("=".repeat(62));
  console.log(`  Source:     ${BASE_URL}`);
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Category:   ${opts.category}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms`);
  console.log(`  Dry run:    ${opts.dryRun}`);
  console.log(`  Resume:     ${opts.resume}`);
  console.log(`  Force:      ${opts.force}`);
  if (opts.limit > 0) console.log(`  Limit:      ${opts.limit} dossiers`);
  console.log();

  // Load resume state
  let state: IngestState = {
    indexedCategories: [],
    processedDossierIds: [],
    lastRunAt: "",
  };
  if (opts.resume) {
    const saved = loadState();
    if (saved) {
      state = saved;
      console.log(
        `Resuming: ${state.processedDossierIds.length} dossiers already processed, ${state.indexedCategories.length} categories indexed`,
      );
    } else {
      console.log("No resume state found, starting fresh");
    }
  }

  // Initialise database (skip in dry-run mode)
  let db: Database.Database | null = null;
  if (!opts.dryRun) {
    db = initDb(opts.force);
    console.log(`Database initialised at ${DB_PATH}`);
  }

  // -----------------------------------------------------------------------
  // Phase 1: Crawl the resolution indices
  // -----------------------------------------------------------------------

  console.log("\n--- Phase 1: Crawling resolution indices ---\n");

  const allEntries: IndexEntry[] = [];

  // Determine which categories to crawl
  const categoriesToCrawl: CategoryKey[] =
    opts.category === "all"
      ? ALL_CATEGORIES
      : opts.category === "recent"
        ? []
        : [opts.category];

  for (const catKey of categoriesToCrawl) {
    // Skip categories already indexed when resuming
    if (opts.resume && state.indexedCategories.includes(catKey)) {
      console.log(`\nSkipping already-indexed category: ${catKey}`);
      continue;
    }

    try {
      const entries = await crawlCategory(catKey);
      allEntries.push(...entries);

      // Mark category as indexed for resume
      if (!state.indexedCategories.includes(catKey)) {
        state.indexedCategories.push(catKey);
      }
      if (opts.resume) saveState(state);
    } catch (err) {
      console.error(`  Failed to crawl category ${catKey}: ${err}`);
      if (opts.resume) saveState(state);
    }
  }

  // Also crawl recent decisions if category is "all" or "recent"
  if (opts.category === "all" || opts.category === "recent") {
    try {
      const recentEntries = await crawlRecentDecisions();
      allEntries.push(...recentEntries);
    } catch (err) {
      console.error(`  Failed to crawl recent decisions: ${err}`);
    }
  }

  console.log(
    `\n--- Phase 1 complete: ${allEntries.length} index entries ---\n`,
  );

  // Deduplicate by dossier ID (or case number as fallback)
  const uniqueEntries = new Map<string, IndexEntry>();
  for (const entry of allEntries) {
    const key = entry.dossId || entry.caseNumber;
    if (!uniqueEntries.has(key)) {
      uniqueEntries.set(key, entry);
    }
  }

  console.log(`Unique dossiers to process: ${uniqueEntries.size}`);

  // -----------------------------------------------------------------------
  // Phase 2: Fetch dossier details
  // -----------------------------------------------------------------------

  console.log("\n--- Phase 2: Fetching dossier details ---\n");

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const [key, entry] of uniqueEntries) {
    // Check limit
    if (opts.limit > 0 && processed >= opts.limit) {
      console.log(`\nReached limit of ${opts.limit} dossiers`);
      break;
    }

    // Skip already-processed dossiers when resuming
    if (opts.resume && state.processedDossierIds.includes(key)) {
      skipped++;
      continue;
    }

    // Skip entries without a dossier ID (cannot fetch detail without it)
    if (!entry.dossId) {
      console.warn(
        `  Skipping entry without DossID: ${entry.caseNumber}`,
      );
      skipped++;
      continue;
    }

    try {
      const detail = await fetchDossierDetail(entry.dossId);

      if (opts.dryRun) {
        console.log(
          `  [DRY RUN] Would insert: ${detail.caseNumber || entry.caseNumber} — ${detail.description || entry.subject}`,
        );
      } else if (db) {
        const type = classifyDecisionType(
          detail.subject + " " + detail.subSubject,
          detail.decisionOutcome,
          entry.sourceCategory,
        );

        if (type === "merger") {
          upsertMerger(db, entry, detail);
        } else {
          upsertDecision(db, entry, detail);
        }

        inserted++;
      }

      state.processedDossierIds.push(key);
      processed++;

      // Periodic state save every 25 dossiers
      if (opts.resume && processed % 25 === 0) {
        saveState(state);
        console.log(`  [State saved: ${processed} processed]`);
      }
    } catch (err) {
      console.error(
        `  Failed to process dossier ${entry.dossId}: ${err}`,
      );
      errors++;
    }
  }

  // Update sector counts from actual data
  if (db && !opts.dryRun) {
    updateSectorCounts(db);
  }

  // Final state save
  if (opts.resume) {
    saveState(state);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  console.log("\n" + "=".repeat(62));
  console.log("Ingestion complete");
  console.log(`  Processed: ${processed}`);
  console.log(`  Inserted:  ${inserted}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);

  if (db) {
    const dCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const mCount = (
      db.prepare("SELECT count(*) as cnt FROM mergers").get() as {
        cnt: number;
      }
    ).cnt;
    const sCount = (
      db.prepare("SELECT count(*) as cnt FROM sectors").get() as {
        cnt: number;
      }
    ).cnt;
    console.log(
      `\nDatabase summary:\n  Sectors:   ${sCount}\n  Decisions: ${dCount}\n  Mergers:   ${mCount}`,
    );
    db.close();
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
