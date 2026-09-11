import { readFile, writeFile, mkdir, stat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.js";

// --- Types ---

export interface TocEntry {
  level: number;
  title: string;
}

export interface StructuredContent {
  title: string;
  description: string;
  sections: { heading: string; content: string }[];
  codeExamples: { language: string; code: string }[];
  relatedLinks: { text: string; url: string }[];
}

// --- In-memory LRU Cache ---

interface MemCacheEntry {
  content: string;
  timestamp: number;
}

const memoryCache = new Map<string, MemCacheEntry>();

function getFromMemoryCache(url: string): string | null {
  const entry = memoryCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > config.pageCacheMemoryTtlMs) {
    memoryCache.delete(url);
    return null;
  }
  memoryCache.delete(url);
  memoryCache.set(url, entry);
  return entry.content;
}

function setMemoryCache(url: string, content: string): void {
  if (memoryCache.size >= config.pageCacheMemoryMax) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(url, { content, timestamp: Date.now() });
}

export function clearMemoryCache(): void {
  memoryCache.clear();
}

// --- Persistent Disk Page Cache ---

function urlToHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

async function getFromDiskCache(url: string): Promise<string | null> {
  try {
    const filePath = join(config.pageCacheDir, `${urlToHash(url)}.md`);
    const info = await stat(filePath);
    if (Date.now() - info.mtimeMs > config.pageCacheDiskTtlMs) return null;
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function setDiskCache(url: string, content: string): Promise<void> {
  try {
    await mkdir(config.pageCacheDir, { recursive: true });
    await writeFile(
      join(config.pageCacheDir, `${urlToHash(url)}.md`),
      content,
      "utf-8",
    );
  } catch {
    // Non-critical — disk cache write failure shouldn't block
  }
}

/**
 * Clears every cached page from disk. Page content is cached for
 * PAGE_DISK_CACHE_TTL_MS (7 days by default) independently of the sitemap
 * cache — without this, a stale cached page keeps being served for up to
 * that long with no way to force a fresh fetch (e.g. after Adobe updates a
 * doc, or after a content-processing fix ships in a new server version).
 */
export async function clearDiskPageCache(): Promise<number> {
  try {
    const files = await readdir(config.pageCacheDir);
    let cleared = 0;
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        await unlink(join(config.pageCacheDir, file));
        cleared++;
      } catch {
        // best-effort — skip files that fail to delete
      }
    }
    return cleared;
  } catch {
    return 0; // cache dir doesn't exist yet — nothing to clear
  }
}

// --- Fetching ---

const FETCH_HEADERS = { "User-Agent": config.userAgent };

async function tryFetchMarkdown(url: string): Promise<string | null> {
  try {
    const mdUrl = url.endsWith("/") ? url.slice(0, -1) + ".md" : url + ".md";
    const res = await fetch(mdUrl, {
      headers: FETCH_HEADERS,
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (
      !contentType.includes("markdown") &&
      !contentType.includes("text/plain")
    )
      return null;

    return await res.text();
  } catch {
    return null;
  }
}

async function fetchAndParseHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch page: ${res.status} ${res.statusText}`);
  }
  return extractMainContent(await res.text());
}

// --- HTML → Markdown conversion ---

function extractMainContent(html: string): string {
  let content = html;
  const mainMatch =
    content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
    content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    content.match(
      /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );

  if (mainMatch) content = mainMatch[1];

  return content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(
      /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
      "\n```\n$1\n```\n",
    )
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
}

// --- Markdown metadata cleaning ---

/**
 * Adobe's markdown export appends a fixed page-footer block after the real
 * content ends: a "Target Insertion" widget marker, then Toc/Doc
 * Actions/Mini Toc/Metadata tables (git hashes, JSON-LD, exl-id, etc).
 * This is present in the raw source on every page we've checked, so cut
 * everything from that marker onward before it reaches any tool output.
 * Long pages previously hid this because smartTruncate's length cap
 * happened to cut before reaching the footer — short pages did not.
 */
export function stripPageFooter(raw: string): string {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Target Insertion")) {
      // Walk back to the top border of this table (+---+ line) so the
      // table itself is excluded too, not just the marker line.
      let cut = i;
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        const t = lines[j].trim();
        if (t.startsWith("+") && t.endsWith("+") && t.includes("-")) {
          cut = j;
          break;
        }
      }
      return lines.slice(0, cut).join("\n").trim();
    }
  }
  return raw;
}

function cleanMarkdown(rawInput: string): string {
  const raw = stripPageFooter(rawInput);
  const lines = raw.split("\n");
  const cleaned: string[] = [];
  let insideMetadataTable = false;
  let skipBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (
      trimmed.startsWith("+") &&
      trimmed.endsWith("+") &&
      trimmed.includes("---")
    ) {
      if (!insideMetadataTable) {
        const next = findNextContentLine(lines, i + 1);
        if (isMetadataTableHeader(next)) {
          insideMetadataTable = true;
          skipBlock = true;
          continue;
        }
      }
    }

    if (skipBlock) {
      if (
        trimmed.startsWith("+") &&
        trimmed.endsWith("+") &&
        trimmed.includes("---")
      ) {
        const next = findNextContentLine(lines, i + 1);
        if (!next || !next.startsWith("|")) {
          skipBlock = false;
          insideMetadataTable = false;
        }
      }
      continue;
    }

    cleaned.push(lines[i]);
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

// --- Smart truncation (heading-boundary aware) ---

export function smartTruncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;

  const lines = content.split("\n");
  let charCount = 0;
  let lastHeadingIdx = -1;
  let lastBlankIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1;
    if (charCount > maxLen) break;
    if (/^#{1,6}\s/.test(lines[i])) lastHeadingIdx = i;
    if (lines[i].trim() === "") lastBlankIdx = i;
  }

  // Prefer cutting at heading boundary if it's past 30 % of max
  const threshold = lines.length * 0.3;
  const cutIdx =
    lastHeadingIdx > threshold
      ? lastHeadingIdx
      : lastBlankIdx > threshold
        ? lastBlankIdx
        : -1;

  if (cutIdx > 0) {
    const remaining = lines.length - cutIdx;
    return (
      lines.slice(0, cutIdx).join("\n").trim() +
      `\n\n... [truncated — ${remaining} more lines]`
    );
  }

  return content.substring(0, maxLen) + "\n\n... [content truncated]";
}

// --- Public: Fetch page content ---

async function fetchAndClean(url: string): Promise<string> {
  const md = await tryFetchMarkdown(url);
  if (md) return cleanMarkdown(md);
  return fetchAndParseHtml(url);
}

export async function fetchPageContent(url: string): Promise<string> {
  const memoryCached = getFromMemoryCache(url);
  if (memoryCached) return memoryCached;

  const diskCached = await getFromDiskCache(url);
  if (diskCached) {
    const truncated = smartTruncate(diskCached, config.maxContentLength);
    const result = `Source: ${url}\n\n${truncated}`;
    setMemoryCache(url, result);
    return result;
  }

  const rawContent = await fetchAndClean(url);
  await setDiskCache(url, rawContent);

  const truncated = smartTruncate(rawContent, config.maxContentLength);
  const result = `Source: ${url}\n\n${truncated}`;
  setMemoryCache(url, result);
  return result;
}

export async function fetchRawContent(url: string): Promise<string> {
  const diskCached = await getFromDiskCache(url);
  if (diskCached) return diskCached;

  const rawContent = await fetchAndClean(url);
  await setDiskCache(url, rawContent);
  return rawContent;
}

// --- Public: Content extraction helpers ---

export function extractCodeExamples(
  markdown: string,
): { language: string; code: string }[] {
  const examples: { language: string; code: string }[] = [];
  const fenced = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(markdown)) !== null) {
    const code = m[2].trim();
    if (code.length > 0) {
      examples.push({ language: m[1] || "text", code });
    }
  }
  return examples;
}

export function extractPageToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const heading = /^(#{1,6})\s+(.+)$/gm;
  let m;
  while ((m = heading.exec(markdown)) !== null) {
    entries.push({
      level: m[1].length,
      title: m[2].trim().replace(/[`*_]/g, ""),
    });
  }
  return entries;
}

export interface DocSection {
  heading: string;
  level: number;
  content: string;
}

/**
 * Finds the first heading whose title contains `query` (case-insensitive)
 * and returns everything under it — including nested subheadings — up to
 * (not including) the next heading at the same or a shallower level.
 *
 * This lets a large page be read section-by-section instead of only as a
 * whole, which is the only way to reach content past `smartTruncate`'s cutoff
 * on very long pages: fetch the raw page once, then pull just the section
 * that's actually needed instead of the full (possibly truncated) document.
 */
export function extractSection(
  markdown: string,
  query: string,
): DocSection | null {
  const lines = markdown.split("\n");
  const headingRe = /^(#{1,6})\s+(.+)$/;
  const q = query.trim().toLowerCase();
  if (!q) return null;

  let startIdx = -1;
  let level = 0;
  let heading = "";

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    const title = m[2].trim().replace(/[`*_]/g, "");
    if (title.toLowerCase().includes(q)) {
      startIdx = i;
      level = m[1].length;
      heading = title;
      break;
    }
  }

  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && m[1].length <= level) {
      endIdx = i;
      break;
    }
  }

  return {
    heading,
    level,
    content: lines.slice(startIdx, endIdx).join("\n").trim(),
  };
}

export function extractStructuredContent(
  markdown: string,
): StructuredContent {
  const lines = markdown.split("\n");

  // Title from first h1
  let title = "";
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1].trim();
      break;
    }
  }

  // Description from first paragraph after title
  let foundTitle = false;
  const descParts: string[] = [];
  for (const line of lines) {
    if (!foundTitle) {
      if (/^#\s/.test(line)) foundTitle = true;
      continue;
    }
    if (line.trim() === "") {
      if (descParts.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    descParts.push(line);
  }
  const description = descParts.join(" ").trim();

  // Sections (h2–h4 blocks)
  const sections: { heading: string; content: string }[] = [];
  let curHeading = "";
  let curLines: string[] = [];
  for (const line of lines) {
    const hm = line.match(/^(#{2,4})\s+(.+)$/);
    if (hm) {
      if (curHeading) {
        sections.push({
          heading: curHeading,
          content: curLines.join("\n").trim(),
        });
      }
      curHeading = hm[2].trim();
      curLines = [];
    } else if (curHeading) {
      curLines.push(line);
    }
  }
  if (curHeading) {
    sections.push({ heading: curHeading, content: curLines.join("\n").trim() });
  }

  // Code examples
  const codeExamples = extractCodeExamples(markdown);

  // Related links
  const relatedLinks: { text: string; url: string }[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let lm;
  while ((lm = linkRe.exec(markdown)) !== null) {
    const text = lm[1].trim();
    const url = lm[2].trim();
    if (text && url && !url.includes("#")) {
      relatedLinks.push({ text, url });
    }
  }

  return { title, description, sections, codeExamples, relatedLinks };
}
