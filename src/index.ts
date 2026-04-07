#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadSitemap,
  searchEntries,
  getDocSections,
  clearCache,
  type DocEntry,
} from "./sitemap.js";

// --- State ---

let docEntries: DocEntry[] = [];
let isLoaded = false;
let loadPromise: Promise<void> | null = null;

// --- LRU Page Content Cache ---

interface CacheEntry {
  content: string;
  timestamp: number;
}

const PAGE_CACHE_MAX = 100;
const PAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const pageCache = new Map<string, CacheEntry>();

function getFromPageCache(url: string): string | null {
  const entry = pageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PAGE_CACHE_TTL_MS) {
    pageCache.delete(url);
    return null;
  }
  // Move to end (most recently used) by re-inserting
  pageCache.delete(url);
  pageCache.set(url, entry);
  return entry.content;
}

function setPageCache(url: string, content: string): void {
  if (pageCache.size >= PAGE_CACHE_MAX) {
    // Evict oldest (first key in Map iteration order)
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(url, { content, timestamp: Date.now() });
}

// --- Sitemap Loading ---

function preWarm(): void {
  if (loadPromise) return;
  loadPromise = (async () => {
    try {
      docEntries = await loadSitemap();
      isLoaded = true;
      console.error(`Pre-warm complete: ${docEntries.length} pages indexed`);
    } catch (err) {
      console.error("Pre-warm failed, will retry on first tool call:", err);
      loadPromise = null;
    }
  })();
}

async function ensureLoaded(): Promise<void> {
  if (isLoaded) return;
  if (loadPromise) {
    await loadPromise;
    if (isLoaded) return;
  }
  // Retry if pre-warm failed
  docEntries = await loadSitemap();
  isLoaded = true;
}

// --- Page Content Fetching ---
// Strategy: try .md endpoint first (native markdown), fall back to HTML parsing

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; AdobeCommerceMCP/1.0; +https://github.com)",
};

const MAX_LENGTH = 15000;

async function fetchPageContent(url: string): Promise<string> {
  const cached = getFromPageCache(url);
  if (cached) return cached;

  // Try native .md endpoint first — much faster, no HTML parsing needed
  const mdContent = await tryFetchMarkdown(url);
  if (mdContent) {
    const result = `Source: ${url}\n\n${mdContent}`;
    setPageCache(url, result);
    return result;
  }

  // Fallback: fetch HTML and convert
  const htmlContent = await fetchAndParseHtml(url);
  const result = `Source: ${url}\n\n${htmlContent}`;
  setPageCache(url, result);
  return result;
}

async function tryFetchMarkdown(url: string): Promise<string | null> {
  try {
    const mdUrl = url.endsWith("/") ? url.slice(0, -1) + ".md" : url + ".md";
    const res = await fetch(mdUrl, {
      headers: FETCH_HEADERS,
      redirect: "follow",
    });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("markdown") && !contentType.includes("text/plain")) {
      return null;
    }

    const raw = await res.text();
    return cleanMarkdown(raw);
  } catch {
    return null;
  }
}

function cleanMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const cleaned: string[] = [];
  let insideMetadataTable = false;
  let skipBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip ASCII table blocks that wrap metadata (Back To Browsing, Breadcrumbs,
    // Article Metadata, Article Metadata Topics, Article Metadata Createdby)
    if (trimmed.startsWith("+") && trimmed.endsWith("+") && trimmed.includes("---")) {
      if (!insideMetadataTable) {
        // Check if this is a metadata table by peeking at next content line
        const nextContentLine = findNextContentLine(lines, i + 1);
        if (isMetadataTableHeader(nextContentLine)) {
          insideMetadataTable = true;
          skipBlock = true;
          continue;
        }
      }
    }

    if (skipBlock) {
      if (trimmed.startsWith("+") && trimmed.endsWith("+") && trimmed.includes("---")) {
        // Could be end of this table or a divider within it
        const nextContentLine = findNextContentLine(lines, i + 1);
        if (!nextContentLine || !nextContentLine.startsWith("|")) {
          // End of table
          skipBlock = false;
          insideMetadataTable = false;
        }
      }
      continue;
    }

    cleaned.push(line);
  }

  let content = cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (content.length > MAX_LENGTH) {
    content = content.substring(0, MAX_LENGTH) + "\n\n... [content truncated]";
  }

  return content;
}

function findNextContentLine(lines: string[], start: number): string | null {
  for (let i = start; i < Math.min(start + 3, lines.length); i++) {
    const t = lines[i].trim();
    if (t.length > 0) return t;
  }
  return null;
}

function isMetadataTableHeader(line: string | null): boolean {
  if (!line) return false;
  const lower = line.toLowerCase();
  return (
    lower.includes("back to browsing") ||
    lower.includes("breadcrumbs") ||
    lower.includes("article metadata") ||
    lower.includes("created for") ||
    lower.includes("createdby")
  );
}

async function fetchAndParseHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch page: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return extractMainContent(html);
}

function extractMainContent(html: string): string {
  let content = html;
  const mainMatch =
    content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
    content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch) {
    content = mainMatch[1];
  }

  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?[uo]l[^>]*>/gi, "\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (content.length > MAX_LENGTH) {
    content = content.substring(0, MAX_LENGTH) + "\n\n... [content truncated]";
  }

  return content;
}

// --- MCP Server ---

const server = new McpServer({
  name: "adobe-commerce-docs",
  version: "1.1.0",
});

server.tool(
  "search_adobe_commerce_docs",
  "Search through Adobe Commerce / Magento documentation. Returns matching doc pages from the official Adobe Experience League sitemap. Use keywords like 'catalog', 'checkout', 'graphql', 'rest api', 'admin', 'cloud', 'payment', etc.",
  {
    query: z
      .string()
      .describe(
        "Search keywords (e.g., 'graphql product query', 'checkout configuration', 'cloud deploy')"
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Max number of results to return (default: 15)"),
    section: z
      .string()
      .optional()
      .describe(
        "Filter by section: commerce-admin, commerce-operations, commerce-cloud-service, commerce-merchant-services, commerce-php, commerce-learn, etc."
      ),
  },
  async ({ query, limit, section }) => {
    try {
      await ensureLoaded();

      let searchPool = docEntries;
      if (section) {
        searchPool = docEntries.filter((e) =>
          e.path.includes(`/${section}/`)
        );
      }

      const results = searchEntries(searchPool, query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for "${query}"${section ? ` in section "${section}"` : ""}. Try broader keywords or remove the section filter.`,
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   Last updated: ${r.lastmod}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} results for "${query}":\n\n${formatted}\n\nUse the \`get_doc_content\` tool with a URL above to fetch the full page content.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching docs: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_doc_content",
  "Fetch and return the content of a specific Adobe Commerce documentation page. Provide the full URL from search results.",
  {
    url: z
      .string()
      .url()
      .describe(
        "Full URL of the documentation page (e.g., https://experienceleague.adobe.com/en/docs/commerce-admin/...)"
      ),
  },
  async ({ url }) => {
    try {
      const content = await fetchPageContent(url);
      return {
        content: [
          {
            type: "text" as const,
            text: content,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching page: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_doc_sections",
  "List all available sections/categories of Adobe Commerce documentation with page counts.",
  {},
  async () => {
    try {
      await ensureLoaded();

      const sections = getDocSections(docEntries);
      const sorted = [...sections.entries()].sort(
        (a, b) => b[1] - a[1]
      );

      const formatted = sorted
        .map(([section, count]) => {
          const title = section
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          return `- **${title}** (\`${section}\`) — ${count} pages`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Adobe Commerce Documentation Sections (${docEntries.length} total pages):\n\n${formatted}\n\nUse the section slug (in backticks) with the \`search_adobe_commerce_docs\` tool's \`section\` parameter to filter results.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing sections: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "refresh_sitemap",
  "Force refresh the cached sitemap data from Adobe Experience League. Use when you need the latest documentation URLs.",
  {},
  async () => {
    try {
      isLoaded = false;
      loadPromise = null;
      docEntries = [];
      pageCache.clear();

      await clearCache();
      await ensureLoaded();

      return {
        content: [
          {
            type: "text" as const,
            text: `Sitemap refreshed successfully. Loaded ${docEntries.length} Commerce documentation pages.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error refreshing sitemap: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Adobe Commerce Docs MCP server running on stdio");

  // Pre-warm: start loading sitemap immediately after connection
  preWarm();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
