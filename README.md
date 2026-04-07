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

## Installation

### Use with Cursor

Add to your Cursor MCP config (`~/.cursor/mcp.json`):

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

### Use with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

### Use with VS Code / Copilot

Add to your VS Code settings (`.vscode/mcp.json`):

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

### Run Locally (from source)

```bash
git clone https://github.com/jigark/adobe-commerce-docs-mcp.git
cd adobe-commerce-docs-mcp
npm install
npm run build
npm start
```

## Usage Examples

Once connected, your AI assistant can use these tools naturally:

- *"Search Adobe Commerce docs for GraphQL product queries"*
- *"Get the documentation page for checkout configuration"*
- *"List all Adobe Commerce doc sections"*
- *"Find docs about cloud deployment"*

## How It Works

1. On startup, fetches the Adobe Experience League sitemap and indexes all Commerce-related URLs
2. Builds an inverted index for fast keyword search
3. When you ask for page content, fetches the native `.md` version (clean markdown, no HTML parsing)
4. Results are cached in memory (LRU, 1 hour) and the sitemap is cached on disk (24 hours)

## Requirements

- Node.js 18 or later

## License

MIT
