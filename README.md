# Adobe Commerce Docs MCP Server

An MCP (Model Context Protocol) server that gives AI assistants direct access to the official **Adobe Commerce / Magento documentation**. It indexes the Adobe Experience League sitemap and provides tools to search, browse, and read documentation pages.

## Features

- **Search** across 2,900+ Adobe Commerce documentation pages
- **Read** full page content as clean markdown (uses native `.md` endpoints)
- **Browse** documentation by section (Admin, Operations, Cloud, PHP, etc.)
- **Fast** — pre-warms on startup, inverted index for search, LRU cache for pages
- **Offline-friendly** — 24-hour disk cache for sitemap data

## Tools

| Tool | Description |
|---|---|
| `search_adobe_commerce_docs` | Search docs by keywords, optionally filtered by section |
| `get_doc_content` | Fetch full content of a documentation page as markdown |
| `list_doc_sections` | List all doc sections with page counts |
| `refresh_sitemap` | Force-refresh the sitemap cache |

---

## Quick Setup for Cursor (Step-by-Step)

If you've never set up an MCP server before, follow these steps exactly.

### Prerequisites

You need **Node.js 18+** installed. Check by opening a terminal and running:

```bash
node --version
```

If you see `v18.x.x` or higher, you're good. If not, install Node.js from [nodejs.org](https://nodejs.org/).

### Step 1: Open Cursor Settings

1. Open **Cursor**
2. Press `Ctrl + Shift + J` (Linux/Windows) or `Cmd + Shift + J` (macOS) to open Cursor Settings
3. In the left sidebar, click **"MCP"**
4. Click **"+ Add new MCP server"**

### Step 2: Add the Server

A dialog will appear. Fill it in:

| Field | Value |
|---|---|
| **Name** | `adobe-commerce-docs` |
| **Type** | `command` |
| **Command** | `npx -y adobe-commerce-docs-mcp` |

Click **"Add"** — that's it.

### Step 3: Verify It Works

You should see `adobe-commerce-docs` in your MCP list with a **green dot** (active).

Now open any chat in Cursor (Agent mode) and try asking:

> *"Search Adobe Commerce docs for checkout configuration"*

Cursor will use the MCP tools automatically.

### Alternative: Edit the Config File Directly

If you prefer editing config files, open (or create) this file:

- **Linux**: `~/.cursor/mcp.json`
- **macOS**: `~/.cursor/mcp.json`
- **Windows**: `%USERPROFILE%\.cursor\mcp.json`

Paste this JSON:

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

> **Note**: If the file already exists and has other servers, just add the `"adobe-commerce-docs"` block inside the existing `"mcpServers"` object — don't replace the whole file.

Then restart Cursor.

---

## Troubleshooting

### "MCP server failed to start"

- Make sure Node.js 18+ is installed (`node --version`)
- Try running the command directly in a terminal to see the error:
  ```bash
  npx -y adobe-commerce-docs-mcp
  ```
- If you're behind a corporate proxy, make sure npm can reach the registry:
  ```bash
  npm config set registry https://registry.npmjs.org/
  ```

### Green dot doesn't appear

- Click the refresh icon next to the server name in MCP settings
- If it still fails, restart Cursor completely

### "No results found" for searches

- The sitemap loads on first use. Wait a few seconds and try again.
- Try broader keywords (e.g., `"checkout"` instead of `"checkout multishipping step 3"`)
- Run the `refresh_sitemap` tool to reload the latest data

---

## Setup for Other Tools

### Claude Desktop

Add to config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

### VS Code / Copilot

Add to `.vscode/mcp.json` in your project:

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

### Run from Source

```bash
git clone https://github.com/jigark/adobe-commerce-docs-mcp.git
cd adobe-commerce-docs-mcp
npm install
npm run build
npm start
```

---

## Usage Examples

Once connected, just ask naturally in any AI chat:

- *"Search Adobe Commerce docs for GraphQL product queries"*
- *"Get the documentation page for payment methods"*
- *"List all Adobe Commerce doc sections"*
- *"Find docs about cloud deployment"*
- *"What does the Commerce docs say about catalog price rules?"*

The AI will automatically call the right MCP tools and show you the results.

## How It Works

1. On startup, fetches the Adobe Experience League sitemap and indexes all Commerce-related URLs
2. Builds an inverted index for fast keyword search
3. When you ask for page content, fetches the native `.md` version (clean markdown, no HTML parsing)
4. Results are cached in memory (LRU, 1 hour) and the sitemap is cached on disk (24 hours)

## Requirements

- Node.js 18 or later

## License

MIT
