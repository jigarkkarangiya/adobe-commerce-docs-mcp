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
  clearMemoryCache,
} from "./content.js";

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

    const text = entries.map((e) => `- ${e.title}\n  ${e.url}`).join("\n");
    return {
      contents: [
        {
          uri: uri.href,
          text: `${section} — ${entries.length} pages:\n\n${text}`,
          mimeType: "text/plain",
        },
      ],
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  PROMPTS  (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════

server.prompt(
  "troubleshoot-commerce-error",
  "Troubleshoot an Adobe Commerce / Magento error using the Knowledge Base",
  {
    error_message: z
      .string()
      .describe("The error message or error code to troubleshoot"),
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

server.prompt(
  "explain-commerce-concept",
  "Explain an Adobe Commerce / Magento concept using official docs",
  {
    topic: z
      .string()
      .describe(
        "The concept to explain (e.g., 'dependency injection', 'EAV model')",
      ),
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

server.prompt(
  "commerce-code-review",
  "Review Magento/Commerce code against official best practices",
  {
    code: z
      .string()
      .describe("The PHP/XML/JS code to review"),
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

server.prompt(
  "commerce-upgrade-guide",
  "Generate an upgrade checklist for Commerce version migration",
  {
    from_version: z.string().describe("Current version (e.g., '2.4.6')"),
    to_version: z.string().describe("Target version (e.g., '2.4.7')"),
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

server.tool(
  "search_adobe_commerce_docs",
  "Search Adobe Commerce / Magento documentation. Returns pages ranked by BM25 relevance with snippets. Supports synonym expansion (e.g. 'graphql' also matches 'gql') and fuzzy matching for typos.",
  {
    query: z
      .string()
      .describe(
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
        "Filter by section slug (e.g., commerce-admin, commerce-php, commerce-cloud-service)",
      ),
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

server.tool(
  "get_doc_content",
  "Fetch the full content of an Adobe Commerce documentation page as clean markdown.",
  {
    url: z
      .string()
      .url()
      .describe("Full URL of the documentation page"),
  },
  async ({ url }) => {
    try {
      const content = await fetchPageContent(url);
      return { content: [{ type: "text" as const, text: content }] };
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

server.tool(
  "list_doc_sections",
  "List all Adobe Commerce documentation sections with page counts.",
  {},
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

server.tool(
  "refresh_sitemap",
  "Force-refresh the cached sitemap data from Adobe Experience League.",
  {},
  async () => {
    try {
      isLoaded = false;
      loadPromise = null;
      docEntries = [];
      clearMemoryCache();
      await clearCache();
      await ensureLoaded();

      return {
        content: [
          {
            type: "text" as const,
            text: `Sitemap refreshed. ${docEntries.length} pages indexed.`,
          },
        ],
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

server.tool(
  "get_related_docs",
  "Find sibling/related documentation pages for a given page URL (same parent in the doc tree).",
  {
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

server.tool(
  "get_code_examples",
  "Extract only code examples from a documentation page. Returns fenced code blocks without prose — much more token-efficient than full page fetch.",
  {
    url: z
      .string()
      .url()
      .describe("Full URL of the documentation page"),
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

server.tool(
  "get_page_toc",
  "Get the table of contents (heading hierarchy) of a documentation page. Useful for understanding structure before fetching the full (expensive) content.",
  {
    url: z
      .string()
      .url()
      .describe("Full URL of the documentation page"),
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

server.tool(
  "lookup_error_code",
  "Look up an Adobe Commerce error code or message in the Knowledge Base. Auto-fetches the top result content for immediate answers.",
  {
    error: z
      .string()
      .describe(
        "Error code or message (e.g., 'MDVA-43395', 'Unable to serialize value')",
      ),
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

      return { content: [{ type: "text" as const, text }] };
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

server.tool(
  "multi_page_search",
  "Search documentation with multiple queries at once. Returns de-duplicated results from all queries — reduces round-trips when researching a topic from multiple angles.",
  {
    queries: z
      .array(z.string())
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
  async ({ queries, limit_per_query, section }) => {
    try {
      await ensureLoaded();

      const pool = section
        ? getSectionEntries(docEntries, section)
        : docEntries;
      const seen = new Set<string>();
      const blocks: string[] = [];

      for (const q of queries) {
        const results = searchEntries(pool, q, limit_per_query);
        const unique = results.filter((r) => !seen.has(r.entry.url));
        unique.forEach((r) => seen.add(r.entry.url));

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
