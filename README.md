# Adobe Commerce Docs MCP Server

[![npm version](https://img.shields.io/npm/v/adobe-commerce-docs-mcp)](https://www.npmjs.com/package/adobe-commerce-docs-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants direct access to the official **Adobe Commerce / Magento documentation**. It indexes the Adobe Experience League sitemap and provides tools to search, browse, and read documentation pages — all from within your AI coding assistant.

---

## Features

- **Search** across 2,900+ Adobe Commerce documentation pages instantly
- **Read** full page content as clean markdown (uses native `.md` endpoints — no HTML scraping)
- **Browse** documentation by section (Admin, Operations, Cloud, PHP, etc.)
- **Fast** — pre-warms on startup, inverted index for search, LRU cache for pages
- **Offline-friendly** — 24-hour disk cache for sitemap data
- **Zero config** — just add one line to your MCP config and go

---

## Tools

### `search_adobe_commerce_docs`

Search through all Adobe Commerce documentation by keywords.

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

### `list_doc_sections`

List all available documentation sections with page counts. No parameters.

### `refresh_sitemap`

Force-refresh the cached sitemap data. Use when you need the latest docs. No parameters.

### Available Sections

Use these slugs with the `section` parameter in `search_adobe_commerce_docs`:

| Section Slug | Description |
|---|---|
| `commerce-admin` | Admin panel, catalog, customers, orders, stores configuration |
| `commerce-operations` | Installation, upgrade, configuration, CLI tools, patches |
| `commerce-cloud-service` | Cloud infrastructure, deployment, environments |
| `commerce-on-cloud` | Cloud project setup and management |
| `commerce-merchant-services` | Live Search, Product Recommendations, Payment Services |
| `commerce-channels` | Amazon Sales Channel, Channel Manager |
| `commerce-knowledge-base` | Troubleshooting articles and known issues |
| `commerce-learn` | Tutorials and video guides |
| `commerce-php` | PHP developer guide, extensions, APIs |
| `commerce-business-intelligence` | Reporting and analytics |

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
| *"Search Adobe Commerce docs for GraphQL product queries"* | Searches sitemap index, returns top matches |
| *"Get the documentation page for payment methods"* | Fetches full page content as markdown |
| *"List all Adobe Commerce doc sections"* | Shows all sections with page counts |
| *"Find cloud deployment docs"* | Searches with keyword matching |
| *"What does the Commerce docs say about catalog price rules?"* | Searches, then reads the best matching page |
| *"Search for REST API in the commerce-php section"* | Filtered search within a specific section |

---

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
│  AI Client   │────▶│  MCP Server       │────▶│  Adobe Experience League │
│  (Cursor,    │◀────│  (this project)   │◀────│  sitemap.xml + .md pages │
│   Claude)    │     │                  │     │                         │
└─────────────┘     └──────────────────┘     └─────────────────────────┘
                      │
                      ├─ Pre-warms sitemap on startup
                      ├─ Builds inverted index for fast search
                      ├─ Fetches .md endpoints (native markdown)
                      ├─ LRU cache: 100 pages, 1h TTL
                      └─ Disk cache: sitemap, 24h TTL
```

1. On startup, fetches the Adobe Experience League sitemap and indexes all Commerce-related URLs
2. Builds an inverted index for instant keyword search
3. When you ask for page content, fetches the native `.md` version (clean markdown, no HTML parsing needed)
4. Falls back to HTML fetch + conversion if `.md` is unavailable
5. Results are cached in memory (LRU, 100 pages, 1 hour) and the sitemap is cached on disk (24 hours)

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
- Ask the AI to run `refresh_sitemap` to reload the latest data

### Slow first response

- The first query triggers sitemap loading (~2-5 seconds). Subsequent queries are instant.
- The sitemap is cached on disk for 24 hours, so restarts are fast too.

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
npm run dev
```

### Project Structure

```
adobe-commerce-docs-mcp/
├── src/
│   ├── index.ts          # MCP server, tools, page fetching, HTML/MD parsing
│   └── sitemap.ts        # Sitemap fetch, XML parse, inverted index, search
├── dist/                 # Compiled JS (generated by `npm run build`)
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
4. Build and test: `npm run build && npm start`
5. Commit and push
6. Open a Pull Request

---

## Requirements

- Node.js 18 or later

## License

[MIT](LICENSE)
