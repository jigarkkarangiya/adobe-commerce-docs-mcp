#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  loadSitemap,
  searchEntries,
  getDocSections,
  getSectionSlugs,
  getSectionEntries,
  getRelatedDocs,
  clearCache,
  type DocEntry,
} from "./sitemap.js";
import {
  fetchPageContent,
  fetchRawContent,
  extractCodeExamples,
  extractPageToc,
  extractSection,
  smartTruncate,
  clearMemoryCache,
  clearDiskPageCache,
} from "./content.js";

// A blank/whitespace-only query has no meaningful match criteria.
// searchEntries() falls back to returning arbitrary entries for an empty
// query (useful as a library-level "browse" behavior, and covered by its
// own tests) — but a tool surfacing that fallback as if it were a real
// ranked match, with empty snippets and no signal that the query was blank,
// is misleading to whatever's reading the result. Reject it at the schema
// boundary instead, with .trim() also normalizing incidental whitespace.
const nonEmptyQuery = (fieldDescription: string) =>
  z
    .string()
    .trim()
    .min(1, "Must not be empty or whitespace-only")
    .describe(fieldDescription);

// ─── State ───────────────────────────────────────────────────────────────────

let docEntries: DocEntry[] = [];
let isLoaded = false;
let loadPromise: Promise<void> | null = null;
const startTime = Date.now();

function preWarm(): void {
  if (loadPromise) return;
  loadPromise = (async () => {
    try {
      docEntries = await loadSitemap();
      isLoaded = true;
      const sections = getSectionSlugs(docEntries);
      console.error(
        `Pre-warm complete: ${docEntries.length} pages indexed across ${sections.length} sections (${sections.join(", ")})`,
      );
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
  docEntries = await loadSitemap();
  isLoaded = true;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "adobe-commerce-docs",
  version: config.version,
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RESOURCES  (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════════

server.resource(
  "sections",
  "commerce://sections",
  {
    description:
      "All Adobe Commerce documentation sections with page counts",
    mimeType: "text/plain",
  },
  async () => {
    await ensureLoaded();
    const sections = getDocSections(docEntries);
    const sorted = [...sections.entries()].sort((a, b) => b[1] - a[1]);
    const text = sorted
      .map(([slug, count]) => {
        const label = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return `${label} (${slug}) — ${count} pages`;
      })
      .join("\n");

    return {
      contents: [
        {
          uri: "commerce://sections",
          text: `Adobe Commerce Docs — ${docEntries.length} total pages\n\n${text}`,
          mimeType: "text/plain",
        },
      ],
    };
  },
);

server.resource(
  "stats",
  "commerce://stats",
  {
    description: "MCP server status: version, uptime, index size",
    mimeType: "application/json",
  },
  async () => {
    await ensureLoaded();
    const stats = {
      version: config.version,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      total_pages_indexed: docEntries.length,
      sections: getDocSections(docEntries).size,
      loaded: isLoaded,
    };
    return {
      contents: [
        {
          uri: "commerce://stats",
          text: JSON.stringify(stats, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  },
);

server.resource(
  "section-docs",
  new ResourceTemplate("commerce://docs/{section}", {
    list: async () => {
      await ensureLoaded();
      return {
        resources: getSectionSlugs(docEntries).map((slug) => ({
          uri: `commerce://docs/${slug}`,
          name: slug
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          description: `Browse ${slug} documentation`,
          mimeType: "text/plain",
        })),
      };
    },
    complete: {
      section: async (value) => {
        await ensureLoaded();
        const slugs = getSectionSlugs(docEntries);
        return value
          ? slugs.filter((s) => s.startsWith(value.toLowerCase()))
          : slugs;
      },
    },
  }),
  {
    description: "Browse documentation pages within a section",
    mimeType: "text/plain",
  },
  async (uri, variables) => {
    await ensureLoaded();
    const section = variables.section as string;
    const entries = getSectionEntries(docEntries, section);

    if (entries.length === 0) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `No pages found for section "${section}".`,
            mimeType: "text/plain",
          },
        ],
      };
    }

    const RESOURCE_PAGE_CAP = 300;
    const shown = entries.slice(0, RESOURCE_PAGE_CAP);
    const text = shown.map((e) => `- ${e.title}\n  ${e.url}`).join("\n");
    const truncationNote =
      entries.length > RESOURCE_PAGE_CAP
        ? `\n\n... showing first ${RESOURCE_PAGE_CAP} of ${entries.length} pages. Use \`search_adobe_commerce_docs\` with section: "${section}" and a query to find a specific page instead of browsing the full list.`
        : "";

    return {
      contents: [
        {
          uri: uri.href,
          text: `${section} — ${entries.length} pages:\n\n${text}${truncationNote}`,
          mimeType: "text/plain",
        },
      ],
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  PROMPTS  (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════

server.registerPrompt(
  "troubleshoot-commerce-error",
  {
    title: "Troubleshoot Commerce Error",
    description: "Troubleshoot an Adobe Commerce / Magento error using the Knowledge Base",
    argsSchema: {
      error_message: z
        .string()
        .describe("The error message or error code to troubleshoot"),
    },
  },
  ({ error_message }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `I'm encountering this Adobe Commerce / Magento error:`,
            "",
            "```",
            error_message,
            "```",
            "",
            "Please help me troubleshoot:",
            '1. Use `search_adobe_commerce_docs` to search the Knowledge Base (section: "commerce-knowledge-base") for this error.',
            "2. Also search general documentation for relevant configuration guides.",
            "3. Fetch the most relevant pages using `get_doc_content`.",
            "4. Provide: **Root cause**, **Step-by-step solution**, **Prevention tips**, and **Source links**.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "explain-commerce-concept",
  {
    title: "Explain Commerce Concept",
    description: "Explain an Adobe Commerce / Magento concept using official docs",
    argsSchema: {
      topic: z
        .string()
        .describe(
          "The concept to explain (e.g., 'dependency injection', 'EAV model')",
        ),
    },
  },
  ({ topic }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Explain the Adobe Commerce / Magento concept: **${topic}**`,
            "",
            "1. Use `search_adobe_commerce_docs` to find documentation about this topic.",
            "2. Fetch the most relevant page(s) with `get_doc_content`.",
            "3. Provide: **Definition**, **How it works** (with architecture details), **Code examples**, **Best practices**, and **Related documentation links**.",
            "",
            "Cite all source URLs.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "commerce-code-review",
  {
    title: "Commerce Code Review",
    description: "Review Magento/Commerce code against official best practices",
    argsSchema: {
      code: z.string().describe("The PHP/XML/JS code to review"),
    },
  },
  ({ code }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Review this Adobe Commerce / Magento code against official best practices:",
            "",
            "```",
            code,
            "```",
            "",
            "1. Identify the code type (module, plugin, observer, layout XML, etc.).",
            "2. Use `search_adobe_commerce_docs` to find relevant coding standards.",
            "3. Fetch best-practices pages with `get_doc_content`.",
            "4. Provide: **Compliance check**, **Issues found**, **Improvements with examples**, **Documentation references**.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "commerce-upgrade-guide",
  {
    title: "Commerce Upgrade Guide",
    description: "Generate an upgrade checklist for Commerce version migration",
    argsSchema: {
      from_version: z.string().describe("Current version (e.g., '2.4.6')"),
      to_version: z.string().describe("Target version (e.g., '2.4.7')"),
    },
  },
  ({ from_version, to_version }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `I need to upgrade Adobe Commerce from **${from_version}** to **${to_version}**.`,
            "",
            "1. Use `search_adobe_commerce_docs` to find release notes, upgrade guides (section: commerce-operations), and breaking changes.",
            "2. Fetch relevant pages with `get_doc_content`.",
            "3. Provide: **Pre-upgrade checklist**, **Breaking changes**, **Step-by-step upgrade commands**, **Post-upgrade verification**, **Rollback plan**.",
            "",
            "Cite all source URLs.",
          ].join("\n"),
        },
      },
    ],
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
//  TOOLS — Existing (updated)
// ═══════════════════════════════════════════════════════════════════════════════

const searchResultShape = {
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  lastmod: z.string(),
};

server.registerTool(
  "search_adobe_commerce_docs",
  {
    title: "Search Adobe Commerce Docs",
    description:
      "Search Adobe Commerce / Magento documentation. Returns pages ranked by BM25 relevance with snippets. Supports synonym expansion (e.g. 'graphql' also matches 'gql') and fuzzy matching for typos.",
    inputSchema: {
      query: nonEmptyQuery(
        "Search keywords (e.g., 'graphql product query', 'checkout configuration')",
      ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(15)
        .describe("Max results (default: 15)"),
      section: z
        .string()
        .optional()
        .describe(
          "Filter by section slug (e.g., commerce-admin, commerce-cloud-service, commerce-on-cloud)",
        ),
    },
    outputSchema: {
      query: z.string(),
      count: z.number(),
      results: z.array(z.object(searchResultShape)),
    },
    annotations: {
      title: "Search Adobe Commerce Docs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, limit, section }) => {
    try {
      await ensureLoaded();

      const pool = section
        ? getSectionEntries(docEntries, section)
        : docEntries;
      const results = searchEntries(pool, query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results for "${query}"${section ? ` in "${section}"` : ""}. Try broader keywords or remove the section filter.`,
            },
          ],
          structuredContent: { query, count: 0, results: [] },
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.entry.title}**\n   URL: ${r.entry.url}\n   ${r.snippet}\n   Updated: ${r.entry.lastmod}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} results for "${query}":\n\n${formatted}\n\nUse \`get_doc_content\` with a URL to read the full page.`,
          },
        ],
        structuredContent: {
          query,
          count: results.length,
          results: results.map((r) => ({
            title: r.entry.title,
            url: r.entry.url,
            snippet: r.snippet,
            lastmod: r.entry.lastmod,
          })),
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_doc_content",
  {
    title: "Get Doc Content",
    description:
      "Fetch the full content of an Adobe Commerce documentation page as clean markdown.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full URL of the documentation page"),
    },
    outputSchema: {
      url: z.string(),
      content: z.string(),
    },
    annotations: {
      title: "Get Doc Content",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ url }) => {
    try {
      const content = await fetchPageContent(url);
      return {
        content: [{ type: "text" as const, text: content }],
        structuredContent: { url, content },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_doc_sections",
  {
    title: "List Doc Sections",
    description: "List all Adobe Commerce documentation sections with page counts.",
    inputSchema: {},
    outputSchema: {
      total_pages: z.number(),
      sections: z.array(
        z.object({ slug: z.string(), label: z.string(), count: z.number() }),
      ),
    },
    annotations: {
      title: "List Doc Sections",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      await ensureLoaded();
      const sections = getDocSections(docEntries);
      const sorted = [...sections.entries()].sort((a, b) => b[1] - a[1]);
      const formatted = sorted
        .map(([slug, count]) => {
          const label = slug
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          return `- **${label}** (\`${slug}\`) — ${count} pages`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Adobe Commerce Documentation (${docEntries.length} pages):\n\n${formatted}\n\nUse the slug with \`search_adobe_commerce_docs\` section parameter.`,
          },
        ],
        structuredContent: {
          total_pages: docEntries.length,
          sections: sorted.map(([slug, count]) => ({
            slug,
            label: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            count,
          })),
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "refresh_sitemap",
  {
    title: "Refresh Sitemap",
    description:
      "Force-refresh the cached sitemap data from Adobe Experience League, and clear the on-disk page content cache (individually cached per-page for up to 7 days) so subsequently fetched pages are re-downloaded fresh rather than served stale.",
    inputSchema: {},
    outputSchema: {
      pages_indexed: z.number(),
      pages_cache_cleared: z.number(),
    },
    annotations: {
      title: "Refresh Sitemap",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      isLoaded = false;
      loadPromise = null;
      docEntries = [];
      clearMemoryCache();
      await clearCache();
      const pagesCacheCleared = await clearDiskPageCache();
      await ensureLoaded();

      return {
        content: [
          {
            type: "text" as const,
            text: `Sitemap refreshed. ${docEntries.length} pages indexed. Cleared ${pagesCacheCleared} cached page(s) — they'll be re-fetched fresh on next access.`,
          },
        ],
        structuredContent: {
          pages_indexed: docEntries.length,
          pages_cache_cleared: pagesCacheCleared,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  TOOLS — New (Phase 3)
// ═══════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_related_docs",
  {
    title: "Get Related Docs",
    description:
      "Find sibling/related documentation pages for a given page URL (same parent in the doc tree).",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full URL of the documentation page"),
      limit: z
        .number()
        .min(1)
        .max(30)
        .default(10)
        .describe("Max related pages (default: 10)"),
    },
    outputSchema: {
      url: z.string(),
      count: z.number(),
      related: z.array(z.object({ title: z.string(), url: z.string() })),
    },
    annotations: {
      title: "Get Related Docs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ url, limit }) => {
    try {
      await ensureLoaded();
      const related = getRelatedDocs(docEntries, url, limit);

      if (related.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No related pages found for ${url}.`,
            },
          ],
          structuredContent: { url, count: 0, related: [] },
        };
      }

      const formatted = related
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `${related.length} related pages:\n\n${formatted}`,
          },
        ],
        structuredContent: {
          url,
          count: related.length,
          related: related.map((r) => ({ title: r.title, url: r.url })),
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_code_examples",
  {
    title: "Get Code Examples",
    description:
      "Extract only code examples from a documentation page. Returns fenced code blocks without prose — much more token-efficient than full page fetch.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full URL of the documentation page"),
    },
    outputSchema: {
      url: z.string(),
      count: z.number(),
      examples: z.array(z.object({ language: z.string(), code: z.string() })),
    },
    annotations: {
      title: "Get Code Examples",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ url }) => {
    try {
      const raw = await fetchRawContent(url);
      const examples = extractCodeExamples(raw);

      if (examples.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No code examples found on ${url}.`,
            },
          ],
          structuredContent: { url, count: 0, examples: [] },
        };
      }

      const formatted = examples
        .map(
          (ex, i) =>
            `### Example ${i + 1}${ex.language !== "text" ? ` (${ex.language})` : ""}\n\`\`\`${ex.language}\n${ex.code}\n\`\`\``,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `${examples.length} code example(s) from ${url}:\n\n${formatted}`,
          },
        ],
        structuredContent: { url, count: examples.length, examples },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_page_toc",
  {
    title: "Get Page TOC",
    description:
      "Get the table of contents (heading hierarchy) of a documentation page. Useful for understanding structure before fetching the full (expensive) content.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full URL of the documentation page"),
    },
    outputSchema: {
      url: z.string(),
      toc: z.array(z.object({ level: z.number(), title: z.string() })),
    },
    annotations: {
      title: "Get Page TOC",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ url }) => {
    try {
      const raw = await fetchRawContent(url);
      const toc = extractPageToc(raw);

      if (toc.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No headings found on ${url}.`,
            },
          ],
          structuredContent: { url, toc: [] },
        };
      }

      const formatted = toc
        .map((h) => `${"  ".repeat(h.level - 1)}- ${h.title}`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Table of Contents — ${url}:\n\n${formatted}`,
          },
        ],
        structuredContent: { url, toc },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_doc_section",
  {
    title: "Get Doc Section",
    description:
      "Fetch just one section of a documentation page by heading name (matched case-insensitively, substring OK), including its nested subheadings. Use this for long pages where get_doc_content's full-page fetch would truncate before reaching the section you need — check get_page_toc first to find the heading name.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full URL of the documentation page"),
      heading: z
        .string()
        .describe(
          "Heading text to find (e.g., 'tunnel', 'SSH Tunnel Setup'). Matches case-insensitively as a substring.",
        ),
    },
    outputSchema: {
      url: z.string(),
      heading: z.string().nullable(),
      content: z.string(),
    },
    annotations: {
      title: "Get Doc Section",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ url, heading }) => {
    try {
      const raw = await fetchRawContent(url);
      const section = extractSection(raw, heading);

      if (!section) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No section matching "${heading}" found on ${url}. Use \`get_page_toc\` to see available headings.`,
            },
          ],
          structuredContent: { url, heading: null, content: "" },
        };
      }

      const truncated = smartTruncate(section.content, config.maxContentLength);

      return {
        content: [
          {
            type: "text" as const,
            text: `Source: ${url}\nSection: ${section.heading}\n\n${truncated}`,
          },
        ],
        structuredContent: { url, heading: section.heading, content: truncated },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "lookup_error_code",
  {
    title: "Lookup Error Code",
    description:
      "Look up an Adobe Commerce error code or message in the Knowledge Base. Auto-fetches the top result content for immediate answers.",
    inputSchema: {
      error: nonEmptyQuery(
        "Error code or message (e.g., 'MDVA-43395', 'Unable to serialize value')",
      ),
    },
    outputSchema: {
      error: z.string(),
      matched: z
        .object({ title: z.string(), url: z.string() })
        .nullable(),
      others: z.array(z.object({ title: z.string(), url: z.string() })),
    },
    annotations: {
      title: "Lookup Error Code",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ error }) => {
    try {
      await ensureLoaded();

      const kbPool = getSectionEntries(docEntries, "commerce-knowledge-base");
      let results = searchEntries(kbPool, error, 5);

      if (results.length === 0) {
        results = searchEntries(docEntries, error, 5);
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No documentation found for "${error}". Try different keywords or check Adobe Commerce support.`,
            },
          ],
          structuredContent: { error, matched: null, others: [] },
        };
      }

      let pageContent = "";
      try {
        pageContent = await fetchPageContent(results[0].entry.url);
      } catch {
        // non-critical
      }

      const others = results
        .slice(1)
        .map((r, i) => `${i + 2}. **${r.entry.title}**\n   ${r.entry.url}`)
        .join("\n\n");

      const text = pageContent
        ? `## ${results[0].entry.title}\n\n${pageContent}${others ? `\n\n---\n\n## Other Matches\n\n${others}` : ""}`
        : results
            .map(
              (r, i) =>
                `${i + 1}. **${r.entry.title}**\n   ${r.entry.url}\n   ${r.snippet}`,
            )
            .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          error,
          matched: { title: results[0].entry.title, url: results[0].entry.url },
          others: results.slice(1).map((r) => ({ title: r.entry.title, url: r.entry.url })),
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "multi_page_search",
  {
    title: "Multi-Query Search",
    description:
      "Search documentation with multiple queries at once. Returns de-duplicated results from all queries — reduces round-trips when researching a topic from multiple angles.",
    inputSchema: {
      queries: z
        .array(nonEmptyQuery("A search query"))
        .min(1)
        .max(5)
        .describe("Array of search queries (1–5)"),
      limit_per_query: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Max results per query (default: 5)"),
      section: z
        .string()
        .optional()
        .describe("Optional section filter for all queries"),
    },
    outputSchema: {
      queries: z.array(z.string()),
      unique_count: z.number(),
      results: z.array(
        z.object({
          query: z.string(),
          matches: z.array(z.object(searchResultShape)),
        }),
      ),
    },
    annotations: {
      title: "Multi-Query Search",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ queries, limit_per_query, section }) => {
    try {
      await ensureLoaded();

      const pool = section
        ? getSectionEntries(docEntries, section)
        : docEntries;
      const seen = new Set<string>();
      const blocks: string[] = [];
      const structuredResults: {
        query: string;
        matches: { title: string; url: string; snippet: string; lastmod: string }[];
      }[] = [];

      for (const q of queries) {
        const results = searchEntries(pool, q, limit_per_query);
        const unique = results.filter((r) => !seen.has(r.entry.url));
        unique.forEach((r) => seen.add(r.entry.url));

        structuredResults.push({
          query: q,
          matches: unique.map((r) => ({
            title: r.entry.title,
            url: r.entry.url,
            snippet: r.snippet,
            lastmod: r.entry.lastmod,
          })),
        });

        if (unique.length > 0) {
          const list = unique
            .map(
              (r, i) =>
                `  ${i + 1}. **${r.entry.title}**\n     ${r.entry.url}\n     ${r.snippet}`,
            )
            .join("\n");
          blocks.push(`### "${q}" (${unique.length} results)\n\n${list}`);
        } else {
          blocks.push(`### "${q}"\n\n  No results.`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Multi-search — ${seen.size} unique pages:\n\n${blocks.join("\n\n")}`,
          },
        ],
        structuredContent: {
          queries,
          unique_count: seen.size,
          results: structuredResults,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  TRANSPORT & MAIN  (Phase 6)
// ═══════════════════════════════════════════════════════════════════════════════

async function startHttpTransport(): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, mcp-session-id",
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("HTTP error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
    },
  );

  httpServer.listen(config.httpPort, () => {
    console.error(
      `Adobe Commerce Docs MCP running on http://localhost:${config.httpPort}`,
    );
  });
}

async function startStdioTransport(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Adobe Commerce Docs MCP server running on stdio");
}

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http");

  if (useHttp) {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }

  preWarm();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
