# Tools Reference — Bulgarian Competition MCP

All tools use the `bg_comp_` prefix. There are 8 tools total.

---

## bg_comp_search_decisions

Full-text search across CPC enforcement decisions (abuse of dominance, cartels, sector inquiries) under Bulgarian competition law (ZZK).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search query (supports Bulgarian and English) |
| `type` | enum | no | `abuse_of_dominance` \| `cartel` \| `merger` \| `sector_inquiry` |
| `sector` | string | no | Filter by sector ID |
| `outcome` | enum | no | `prohibited` \| `cleared` \| `cleared_with_conditions` \| `fine` |
| `limit` | number | no | Max results (default 20, max 100) |

**Returns:** `{ results: Decision[], count: number, _meta }`

---

## bg_comp_get_decision

Get a specific CPC decision by case number.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `case_number` | string | yes | CPC case number (e.g., `КЗК-1234/2023`) |

**Returns:** `Decision | error`

---

## bg_comp_search_mergers

Search CPC merger control decisions (concentrations).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search query |
| `sector` | string | no | Filter by sector ID |
| `outcome` | enum | no | `cleared` \| `cleared_phase1` \| `cleared_with_conditions` \| `prohibited` |
| `limit` | number | no | Max results (default 20, max 100) |

**Returns:** `{ results: Merger[], count: number, _meta }`

---

## bg_comp_get_merger

Get a specific CPC merger control decision by case number.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `case_number` | string | yes | Merger case number (e.g., `КЗК-К-123/2023`) |

**Returns:** `Merger | error`

---

## bg_comp_list_sectors

List all sectors with CPC enforcement activity, including decision and merger counts.

**Parameters:** None

**Returns:** `{ sectors: Sector[], count: number, _meta }`

---

## bg_comp_about

Return metadata about this MCP server: version, data source, coverage, and tool list.

**Parameters:** None

**Returns:** Server metadata object with `_meta`

---

## bg_comp_list_sources

List all data sources used by this MCP server with provenance metadata.

**Parameters:** None

**Returns:**
```json
{
  "sources": [
    {
      "id": "cpc-bg-decisions",
      "authority": "CPC Bulgaria — Commission for Protection of Competition",
      "url": "https://www.cpc.bg/",
      "data_type": "enforcement_decisions",
      "coverage": "...",
      "license": "Public domain",
      "jurisdiction": "BG",
      "language": ["bg", "en"]
    }
  ],
  "_meta": { ... }
}
```

---

## bg_comp_check_data_freshness

Check the freshness of the underlying SQLite database.

**Parameters:** None

**Returns:**
```json
{
  "index_counts": { "decisions": 0, "mergers": 0 },
  "latest_decision_date": "2024-01-15",
  "latest_merger_date": "2024-01-10",
  "update_recommended": false,
  "note": "Run the ingest script to refresh data from CPC Bulgaria.",
  "_meta": { ... }
}
```
