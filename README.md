# Adobe Commerce Docs MCP Server

[![npm version](https://img.shields.io/npm/v/adobe-commerce-docs-mcp)](https://www.npmjs.com/package/adobe-commerce-docs-mcp)
[![CI](https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants direct access to the official **Adobe Commerce / Magento documentation**. It indexes the Adobe Experience League sitemap and provides tools, resources, and prompts to search, browse, and read documentation pages — all from within your AI coding assistant.

---

## Features

- **9 tools** — search, read pages, browse sections, find related docs, extract code examples, get page TOC, lookup errors, multi-query search, and refresh
- **MCP Resources** — browsable `commerce://` URIs for sections and doc pages
- **MCP Prompts** — reusable workflows for troubleshooting, code review, upgrades, and concept explanation
- **BM25 search** — relevance-ranked results with IDF weighting and document-length normalization
- **Synonym expansion** — `graphql` also matches `gql`, `cloud` matches `ece`, `module` matches `extension`, and 40+ more
- **Fuzzy matching** — tolerates typos like `chekout` → `checkout`, `catlog` → `catalog`
- **Smart truncation** — cuts at heading boundaries instead of mid-sentence
- **Persistent cache** — disk cache for both sitemap (24h) and page content (7 days), survives restarts
- **HTTP transport** — `--http` flag for remote/team deployment via Streamable HTTP
- **Docker ready** — multi-stage Dockerfile for containerized deployment
- **Configurable** — all settings tunable via environment variables
- **Zero config** — just add one line to your MCP config and go

---

## Tools

### `search_adobe_commerce_docs`

BM25-ranked search with synonym expansion and fuzzy matching.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search keywords (e.g., `"graphql product query"`, `"checkout configuration"`) |
| `limit` | number | No | Max results to return (1–50, default: 15) |
| `section` | string | No | Filter by section slug (see [Available Sections](#available-sections)) |

### `get_doc_content`

Fetch the full content of a documentation page as clean markdown.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Full URL of the doc page from search results |

### `get_code_examples`

Extract only the code blocks from a documentation page. Returns fenced code snippets without surrounding prose — much more token-efficient than fetching the full page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Full URL of the doc page |

### `get_page_toc`

Get the heading hierarchy (table of contents) of a page. Useful for understanding structure before fetching the full content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Full URL of the doc page |

### `get_related_docs`

Find sibling/related pages in the same section of the documentation tree.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Full URL of the doc page |
| `limit` | number | No | Max related pages (1–30, default: 10) |

### `lookup_error_code`

Search the Knowledge Base for an error code or message. Auto-fetches the top result for immediate answers.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `error` | string | Yes | Error code or message (e.g., `"MDVA-43395"`, `"Unable to serialize value"`) |

### `multi_page_search`

Search with multiple queries in one call. Returns de-duplicated results — reduces round-trips when researching from multiple angles.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `queries` | string[] | Yes | Array of search queries (1–5) |
| `limit_per_query` | number | No | Max results per query (1–20, default: 5) |
| `section` | string | No | Optional section filter for all queries |

### `list_doc_sections`

List all available documentation sections with page counts. No parameters.

### `refresh_sitemap`

Force-refresh the cached sitemap data. No parameters.

### Available Sections

Use these slugs with the `section` parameter:

| Section Slug | Description |
|---|---|
| `commerce-admin` | Admin panel, catalog, customers, orders, stores configuration |
| `commerce-operations` | Installation, upgrade, configuration, CLI tools, patches |
| `commerce-cloud-service` | Cloud infrastructure, deployment, environments |
| `commerce-merchant-services` | Live Search, Product Recommendations, Payment Services |
| `commerce-channels` | Amazon Sales Channel, Channel Manager |
| `commerce-knowledge-base` | Troubleshooting articles and known issues |
| `commerce-learn` | Tutorials and video guides |
| `commerce-php` | PHP developer guide, extensions, APIs |
| `commerce-business-intelligence` | Reporting and analytics |

---

## Resources

MCP Resources let AI clients browse data directly via URIs — no tool call needed.

| URI | Description |
|---|---|
| `commerce://sections` | All documentation sections with page counts |
| `commerce://stats` | Server status: version, uptime, index size |
| `commerce://docs/{section}` | Browse all pages within a section (supports autocomplete) |

---

## Prompts

MCP Prompts are reusable workflows that work across all MCP clients (Cursor, Claude Desktop, VS Code, Windsurf, etc.).

| Prompt | Arguments | Description |
|---|---|---|
| `troubleshoot-commerce-error` | `error_message` | Search Knowledge Base, provide root cause + solution + prevention |
| `explain-commerce-concept` | `topic` | Explain a concept with code examples and best practices from official docs |
| `commerce-code-review` | `code` | Review PHP/XML/JS code against official Commerce coding standards |
| `commerce-upgrade-guide` | `from_version`, `to_version` | Generate upgrade checklist with breaking changes and rollback plan |

---

## Quick Setup for Cursor

### Option A: Automatic Setup Script (Linux / macOS)

Run this single command in your terminal:

```bash
bash <(curl -sS https://raw.githubusercontent.com/jigarkkarangiya/adobe-commerce-docs-mcp/main/setup-cursor.sh)
```

Or if you have the repo cloned:

```bash
bash setup-cursor.sh
```

The script will:
- Check that Node.js 18+ is installed
- Create or update your `~/.cursor/mcp.json`
- Tell you to restart Cursor

### Option B: Manual Setup (All Platforms — 3 Steps)

#### Prerequisites

You need **Node.js 18+** installed. Check by running:

```bash
node --version
```

If you don't have it, install from [nodejs.org](https://nodejs.org/).

#### Step 1: Open MCP Settings in Cursor

1. Open **Cursor**
2. Go to **Settings** (gear icon in bottom-left, or `Ctrl + ,` / `Cmd + ,`)
3. In the left sidebar, click **"MCP"**
4. Click **"+ Add new MCP server"**

#### Step 2: Add the Server

A dialog will appear. Fill it in:

| Field | Value |
|---|---|
| **Name** | `adobe-commerce-docs` |
| **Type** | `command` |
| **Command** | `npx -y adobe-commerce-docs-mcp` |

Click **"Add"**.

#### Step 3: Verify

You should see `adobe-commerce-docs` in your MCP list with a **green dot** (active).

Open any chat in **Agent mode** and try:

> *"Search Adobe Commerce docs for checkout configuration"*

### Option C: Edit Config File Directly

Open (or create) the MCP config file:

| OS | Path |
|---|---|
| **Linux** | `~/.cursor/mcp.json` |
| **macOS** | `~/.cursor/mcp.json` |
| **Windows** | `%USERPROFILE%\.cursor\mcp.json` |

Add this JSON (if the file already has other servers, merge the `adobe-commerce-docs` block into the existing `mcpServers` object):

```json
{
  "mcpServers": {
    "adobe-commerce-docs": {
      "command": "npx",
      "args": ["-y", "adobe-commerce-docs-mcp"]
    }
  }
}
```

Restart Cursor after saving.

---

## Setup for Other Tools

### Claude Desktop

Add to your Claude Desktop config:

| OS | Config Path |
|---|---|
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Linux** | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "adobe-commerce-docs": {
      "command": "npx",
      "args": ["-y", "adobe-commerce-docs-mcp"]
    }
  }
}
```

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "adobe-commerce-docs": {
      "command": "npx",
      "args": ["-y", "adobe-commerce-docs-mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "adobe-commerce-docs": {
      "command": "npx",
      "args": ["-y", "adobe-commerce-docs-mcp"]
    }
  }
}
```

---

## Usage Examples

Once connected, just ask naturally in any AI chat:

| What You Ask | What Happens |
|---|---|
| *"Search Adobe Commerce docs for GraphQL product queries"* | BM25-ranked search with synonym expansion |
| *"Get the documentation page for payment methods"* | Fetches full page as clean markdown |
| *"Show me just the code examples from the DI docs"* | Extracts only code blocks (saves tokens) |
| *"What's the table of contents for the checkout page?"* | Returns heading hierarchy |
| *"Find related pages for this Cloud deployment doc"* | Returns sibling pages in the doc tree |
| *"Look up error MDVA-43395"* | Searches Knowledge Base, auto-fetches the top match |
| *"Search for REST API, GraphQL mutations, and webhooks"* | Multi-query search in one call |
| *"What does Commerce say about catalog price rules?"* | Searches, then reads the best matching page |
| *"Help me upgrade from 2.4.6 to 2.4.7"* | Uses the upgrade-guide prompt workflow |

---

## How It Works

```
┌─────────────┐     ┌──────────────────────────┐     ┌─────────────────────────┐
│  AI Client   │────▶│  MCP Server (v2.0)        │────▶│  Adobe Experience League │
│  (Cursor,    │◀────│                          │◀────│  sitemap.xml + .md pages │
│   Claude,    │     │  9 Tools                 │     │                         │
│   VS Code)   │     │  3 Resources             │     └─────────────────────────┘
│              │     │  4 Prompts               │
└─────────────┘     └──────────────────────────┘
                      │
                      ├─ BM25 search with synonym expansion + fuzzy matching
                      ├─ Pre-warms sitemap on startup
                      ├─ Fetches .md endpoints (native markdown)
                      ├─ Memory LRU cache: 100 pages, 1h TTL
                      ├─ Disk page cache: 7-day TTL (survives restarts)
                      └─ Disk sitemap cache: 24h TTL
```

1. On startup, fetches the Adobe Experience League sitemap and indexes all Commerce-related URLs
2. Builds an inverted index with BM25 scoring, synonym mappings, and document frequency stats
3. When you search, terms are expanded with synonyms and matched with fuzzy fallback for typos
4. When you ask for page content, fetches the native `.md` version (clean markdown, no HTML parsing needed)
5. Falls back to HTML fetch + conversion if `.md` is unavailable
6. Smart truncation cuts at heading boundaries instead of mid-sentence
7. Pages are cached on disk (7 days) and in memory (LRU, 100 pages, 1 hour)

---

## HTTP Transport

For team/remote deployment, run the server in HTTP mode:

```bash
npm run start:http
# or
npx adobe-commerce-docs-mcp --http
```

This starts a Streamable HTTP server on port 3000 (configurable via `PORT` env var).

### Docker

```bash
docker build -t adobe-commerce-docs-mcp .
docker run -p 3000:3000 adobe-commerce-docs-mcp
```

---

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|---|---|---|
| `SITEMAP_URL` | Adobe Experience League URL | Override sitemap source |
| `CACHE_DIR` | `~/.cache/adobe-commerce-docs-mcp` | Cache directory path |
| `SITEMAP_CACHE_TTL_MS` | `86400000` (24h) | Sitemap cache lifetime |
| `PAGE_CACHE_MAX` | `100` | Max pages in memory LRU cache |
| `PAGE_CACHE_TTL_MS` | `3600000` (1h) | Memory cache page lifetime |
| `PAGE_DISK_CACHE_TTL_MS` | `604800000` (7d) | Disk cache page lifetime |
| `MAX_CONTENT_LENGTH` | `15000` | Max characters per page response |
| `MAX_CONCURRENT_FETCHES` | `5` | Concurrent sitemap fetches |
| `PORT` | `3000` | HTTP server port (with `--http`) |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

---

## Troubleshooting

### MCP server failed to start

- Verify Node.js 18+ is installed: `node --version`
- Test the command manually in a terminal:
  ```bash
  npx -y adobe-commerce-docs-mcp
  ```
- If you're behind a corporate proxy, ensure npm can reach the registry:
  ```bash
  npm config set registry https://registry.npmjs.org/
  ```

### Green dot doesn't appear in Cursor

- Click the **refresh icon** next to the server name in MCP settings
- Restart Cursor completely
- Check Cursor's Output panel for error messages

### "No results found" for searches

- The sitemap loads on first use (takes a few seconds). Wait and try again.
- Use broader keywords: `"checkout"` instead of `"checkout multishipping step 3"`
- Synonym expansion handles many aliases automatically (`gql` → `graphql`, `ece` → `cloud`, etc.)
- Ask the AI to run `refresh_sitemap` to reload the latest data

### Slow first response

- The first query triggers sitemap loading (~2–5 seconds). Subsequent queries are instant.
- The sitemap is cached on disk for 24 hours, and page content is cached for 7 days, so restarts are fast.

---

## Development

### Run from Source

```bash
git clone https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp.git
cd adobe-commerce-docs-mcp
npm install
npm run build
npm start
```

### Dev Mode (auto-reload)

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport
```

### Run Tests

```bash
npm test
```

### Project Structure

```
adobe-commerce-docs-mcp/
├── src/
│   ├── index.ts          # MCP server: tools, resources, prompts, transport
│   ├── sitemap.ts        # Sitemap loading, BM25 search, synonyms, fuzzy matching
│   ├── content.ts        # Page fetching, markdown/HTML parsing, structured extraction
│   └── config.ts         # Environment variable configuration
├── tests/
│   ├── search.test.ts    # Search, Levenshtein, synonym expansion tests
│   └── content.test.ts   # Content extraction, TOC, smart truncation tests
├── dist/                 # Compiled JS (generated by `npm run build`)
├── .cursor/
│   ├── rules/            # Cursor auto-apply rules for this MCP
│   └── prompts/          # Cursor slash commands (/commerce-search, etc.)
├── .github/workflows/    # CI/CD: build, test, publish
├── Dockerfile            # Multi-stage Docker build for HTTP deployment
├── setup-cursor.sh       # One-command Cursor setup script
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

### Contributing

1. Fork the repo
2. Create a branch: `git checkout -b my-feature`
3. Make your changes
4. Build and test: `npm run build && npm test`
5. Commit and push
6. Open a Pull Request

---

## Requirements

- Node.js 18 or later

---

## Find This MCP

| Registry | Link |
|---|---|
| npm | [npmjs.com/package/adobe-commerce-docs-mcp](https://www.npmjs.com/package/adobe-commerce-docs-mcp) |
| GitHub | [github.com/jigarkkarangiya/adobe-commerce-docs-mcp](https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp) |
| mcp.so | [mcp.so](https://mcp.so) — search `adobe-commerce-docs` |
| Smithery | [smithery.ai](https://smithery.ai) — search `adobe-commerce-docs` |
| Glama | [glama.ai/mcp/servers](https://glama.ai/mcp/servers) — search `adobe commerce` |

## Related MCPs

- [adobe-commerce-dev-docs-mcp](https://github.com/jigarkkarangiya/adobe-commerce-dev-docs-mcp) — Adobe Commerce developer docs (developer.adobe.com/commerce)
- [aem-live-docs-mcp](https://github.com/jigarkkarangiya/aem-live-docs-mcp) — AEM / Edge Delivery Services docs (aem.live)

---

## License

[MIT](LICENSE)
