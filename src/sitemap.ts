import { XMLParser } from "fast-xml-parser";
import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DocEntry {
  url: string;
  lastmod: string;
  path: string;
  pathSegments: string[];
  title: string;
  alternates: { lang: string; href: string }[];
}

const SITEMAP_URL = "https://experienceleague.adobe.com/en/sitemap.xml";
const CACHE_DIR = join(homedir(), ".cache", "adobe-commerce-docs-mcp");
const CACHE_FILE = join(CACHE_DIR, "sitemap-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_CONCURRENT_FETCHES = 5;

const COMMERCE_PATH_PREFIXES = [
  "/en/docs/commerce",
  "/en/docs/commerce-admin",
  "/en/docs/commerce-operations",
  "/en/docs/commerce-merchant-services",
  "/en/docs/commerce-channels",
  "/en/docs/commerce-knowledge-base",
  "/en/docs/commerce-learn",
  "/en/docs/commerce-cloud-service",
  "/en/docs/commerce-business-intelligence",
  "/en/docs/commerce-php",
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; AdobeCommerceMCP/1.0; +https://github.com)",
};

// Pre-built inverted index: term -> set of entry indices
let invertedIndex: Map<string, Set<number>> = new Map();
let indexedEntries: DocEntry[] = [];

function isCommerceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return COMMERCE_PATH_PREFIXES.some((prefix) =>
      u.pathname.startsWith(prefix)
    );
  } catch {
    return false;
  }
}

function urlToTitle(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const relevant = segments.slice(2);
    return relevant
      .map((s) =>
        s
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase())
      )
      .join(" > ");
  } catch {
    return url;
  }
}

async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

function createXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "url" || name === "xhtml:link" || name === "sitemap",
  });
}

function extractEntriesFromUrlset(parsed: any): DocEntry[] {
  const entries: DocEntry[] = [];
  let urls: any[] = [];

  if (parsed.urlset?.url) {
    urls = Array.isArray(parsed.urlset.url)
      ? parsed.urlset.url
      : [parsed.urlset.url];
  }

  for (const urlEntry of urls) {
    const loc = urlEntry.loc;
    if (!loc || !isCommerceUrl(loc)) continue;

    const lastmod = urlEntry.lastmod || "";

    let alternates: { lang: string; href: string }[] = [];
    if (urlEntry["xhtml:link"]) {
      const links = Array.isArray(urlEntry["xhtml:link"])
        ? urlEntry["xhtml:link"]
        : [urlEntry["xhtml:link"]];
      alternates = links
        .filter((l: any) => l["@_rel"] === "alternate" && l["@_hreflang"])
        .map((l: any) => ({
          lang: l["@_hreflang"],
          href: l["@_href"],
        }));
    }

    let path: string;
    try {
      path = new URL(loc).pathname;
    } catch {
      path = loc;
    }

    const pathSegments = path
      .split("/")
      .filter(Boolean)
      .map((s) => s.replace(/-/g, " ").toLowerCase());

    entries.push({
      url: loc,
      lastmod,
      path,
      pathSegments,
      title: urlToTitle(loc),
      alternates,
    });
  }

  return entries;
}

/**
 * Fetch multiple URLs with a concurrency limit using a simple pool.
 */
async function fetchWithConcurrency(
  urls: string[],
  limit: number
): Promise<PromiseSettledResult<string>[]> {
  const results: PromiseSettledResult<string>[] = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const idx = cursor++;
      try {
        const text = await fetchUrl(urls[idx]);
        results[idx] = { status: "fulfilled", value: text };
      } catch (err) {
        results[idx] = {
          status: "rejected",
          reason: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, urls.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

async function fetchSitemap(): Promise<DocEntry[]> {
  const xml = await fetchUrl(SITEMAP_URL);
  const parser = createXmlParser();
  const parsed = parser.parse(xml);

  // Handle sitemap index: fetch all child sitemaps concurrently
  if (parsed.sitemapindex?.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    const childUrls = sitemaps
      .map((s: any) => s.loc)
      .filter((loc: any): loc is string => typeof loc === "string");

    if (childUrls.length === 0) return [];

    console.error(
      `Sitemap index found with ${childUrls.length} child sitemaps, fetching concurrently...`
    );

    const results = await fetchWithConcurrency(childUrls, MAX_CONCURRENT_FETCHES);
    const allEntries: DocEntry[] = [];
    const childParser = createXmlParser();

    for (const result of results) {
      if (result.status === "fulfilled") {
        try {
          const childParsed = childParser.parse(result.value);
          allEntries.push(...extractEntriesFromUrlset(childParsed));
        } catch {
          // Skip malformed child sitemaps
        }
      }
    }

    return allEntries;
  }

  // Direct urlset
  return extractEntriesFromUrlset(parsed);
}

// --- Inverted index ---

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s/\-_>]+/).filter((t) => t.length > 1);
}

function buildInvertedIndex(entries: DocEntry[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tokens = new Set([
      ...tokenize(entry.path),
      ...entry.pathSegments,
      ...tokenize(entry.title),
    ]);

    for (const token of tokens) {
      let set = index.get(token);
      if (!set) {
        set = new Set();
        index.set(token, set);
      }
      set.add(i);
    }
  }

  return index;
}

// --- Cache ---

async function loadFromCache(): Promise<DocEntry[] | null> {
  try {
    const info = await stat(CACHE_FILE);
    const age = Date.now() - info.mtimeMs;
    if (age > CACHE_TTL_MS) return null;

    const data = await readFile(CACHE_FILE, "utf-8");
    const entries = JSON.parse(data) as DocEntry[];
    if (entries.length > 0) return entries;
    return null;
  } catch {
    return null;
  }
}

async function saveToCache(entries: DocEntry[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(entries), "utf-8");
  } catch {
    // Non-critical
  }
}

export async function clearCache(): Promise<void> {
  try {
    await unlink(CACHE_FILE);
  } catch {
    // File may not exist
  }
}

// --- Public API ---

export async function loadSitemap(): Promise<DocEntry[]> {
  const cached = await loadFromCache();
  if (cached) {
    indexedEntries = cached;
    invertedIndex = buildInvertedIndex(cached);
    return cached;
  }

  const entries = await fetchSitemap();
  await saveToCache(entries);
  indexedEntries = entries;
  invertedIndex = buildInvertedIndex(entries);
  return entries;
}

export function searchEntries(
  entries: DocEntry[],
  query: string,
  limit: number = 20
): DocEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return entries.slice(0, limit);

  // Use inverted index if searching full corpus, fallback to linear for filtered subsets
  const useIndex = entries === indexedEntries && invertedIndex.size > 0;

  let candidateIndices: Set<number> | null = null;

  if (useIndex) {
    // Collect candidate indices from inverted index using union of all term matches
    candidateIndices = new Set<number>();
    for (const term of terms) {
      // Support partial matching: check all index keys that contain the term
      for (const [key, indices] of invertedIndex) {
        if (key.includes(term)) {
          for (const idx of indices) {
            candidateIndices.add(idx);
          }
        }
      }
    }
  }

  const pool = useIndex && candidateIndices
    ? Array.from(candidateIndices).map((i) => entries[i])
    : entries;

  const scored = new Array<{ entry: DocEntry; score: number }>(pool.length);
  let count = 0;

  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    const pathLower = entry.path.toLowerCase();
    const titleLower = entry.title.toLowerCase();
    const lastSegment = entry.pathSegments[entry.pathSegments.length - 1] || "";

    let score = 0;
    let allMatch = true;

    for (const term of terms) {
      const inPath = pathLower.includes(term);
      const inTitle = titleLower.includes(term);
      const inSegments = entry.pathSegments.some((s) => s.includes(term));

      if (inPath || inTitle || inSegments) {
        score += 10;
        if (inPath) score += 5;
        if (lastSegment.includes(term)) score += 3;
        if (inTitle) score += 2;
      } else {
        allMatch = false;
      }
    }

    if (allMatch && terms.length > 1) score += 20;

    if (score > 0) {
      scored[count++] = { entry, score };
    }
  }

  // Partial sort: only need top `limit` items
  const candidates = scored.slice(0, count);
  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, limit).map((s) => s.entry);
}

export function getDocSections(entries: DocEntry[]): Map<string, number> {
  const sections = new Map<string, number>();
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    if (parts.length >= 3) {
      const section = parts[2];
      sections.set(section, (sections.get(section) || 0) + 1);
    }
  }
  return sections;
}
