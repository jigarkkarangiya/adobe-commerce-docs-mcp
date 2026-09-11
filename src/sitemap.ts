import { XMLParser } from "fast-xml-parser";
import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { config } from "./config.js";

// --- Types ---

export interface DocEntry {
  url: string;
  lastmod: string;
  path: string;
  pathSegments: string[];
  title: string;
  section: string;
  alternates: { lang: string; href: string }[];
}

export interface SearchResult {
  entry: DocEntry;
  score: number;
  snippet: string;
}

// --- Commerce-specific synonym map for query expansion ---

const SYNONYM_MAP: Record<string, string[]> = {
  graphql: ["gql"],
  gql: ["graphql"],
  rest: ["webapi"],
  webapi: ["rest"],
  cms: ["content", "pagebuilder"],
  pagebuilder: ["cms"],
  ece: ["cloud"],
  cloud: ["ece"],
  di: ["dependency"],
  cron: ["scheduled"],
  admin: ["backend", "adminhtml"],
  adminhtml: ["admin"],
  frontend: ["storefront"],
  storefront: ["frontend"],
  elasticsearch: ["opensearch"],
  opensearch: ["elasticsearch"],
  module: ["extension"],
  extension: ["module"],
  plugin: ["interceptor"],
  interceptor: ["plugin"],
  observer: ["event"],
  deploy: ["deployment"],
  deployment: ["deploy"],
  upgrade: ["update", "migration"],
  patch: ["hotfix"],
  b2b: ["company", "quote"],
  cli: ["command"],
  acl: ["permission", "role"],
  indexer: ["reindex"],
  checkout: ["cart"],
  catalog: ["product", "category"],
  product: ["catalog"],
  category: ["catalog"],
  payment: ["gateway"],
  shipping: ["carrier", "delivery"],
  customer: ["account"],
  luma: ["theme"],
  pwa: ["headless"],
  headless: ["pwa"],
  magento: ["commerce"],
};

// --- Index state ---

let invertedIndex: Map<string, Set<number>> = new Map();
let indexedEntries: DocEntry[] = [];
let docLengths: number[] = [];
let avgDocLength = 1;

// --- URL helpers ---

/**
 * Determines whether a sitemap URL belongs to Adobe Commerce documentation.
 *
 * This is pattern-based rather than an enumerated allowlist: Experience
 * League URLs follow `/<locale>/docs/<product-slug>/...`, and every current
 * Commerce doc section uses a `commerce` or `commerce-*` product slug
 * (commerce, commerce-admin, commerce-operations, commerce-on-cloud, etc).
 * Matching the slug pattern means a new section Adobe adds later (as
 * commerce-on-cloud was, until it was added here) is picked up automatically
 * on the next sitemap load — no code change needed. `config.extraCommerceSlugs`
 * remains as an escape hatch for a product slug that doesn't literally start
 * with "commerce" but should still be indexed.
 */
function isCommerceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    // segments: [locale, "docs", "<product-slug>", ...]
    if (segments.length < 3 || segments[1] !== "docs") return false;
    const slug = segments[2];
    return (
      slug === "commerce" ||
      slug.startsWith("commerce-") ||
      config.extraCommerceSlugs.includes(slug)
    );
  } catch {
    return false;
  }
}

function urlToTitle(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    return segments
      .slice(2)
      .map((s) =>
        s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      )
      .join(" > ");
  } catch {
    return url;
  }
}

// --- XML / Sitemap fetching ---

async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": config.userAgent },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function createXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "url" || name === "sitemap",
  });
}

/**
 * Strips <xhtml:link .../> hreflang-alternate tags from raw sitemap XML
 * before parsing. We never use these (DocEntry.alternates is always []) —
 * the sitemap.xml.parse of these ~10-per-URL tags dominated cold-load
 * time (~2.5s of it, most of the ~6s total) for entries that get discarded
 * by isCommerceUrl anyway. A cheap string strip before the DOM-style parser
 * runs avoids that cost entirely (~7x faster parse in practice).
 */
function stripAlternateLinks(xml: string): string {
  return xml.replace(/<xhtml:link\b[^>]*\/>\s*/g, "");
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
    // Hreflang alternates are stripped before parsing (see stripAlternateLinks) — unused downstream.
    const alternates: { lang: string; href: string }[] = [];

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

    const sectionParts = path.split("/").filter(Boolean);
    const section = sectionParts.length >= 3 ? sectionParts[2] : (sectionParts[1] || "general");
    entries.push({
      url: loc,
      lastmod,
      path,
      pathSegments,
      title: urlToTitle(loc),
      section,
      alternates,
    });
  }

  return entries;
}

async function fetchWithConcurrency(
  urls: string[],
  limit: number,
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

  const workers = Array.from(
    { length: Math.min(limit, urls.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function fetchSitemap(): Promise<DocEntry[]> {
  const xml = await fetchUrl(config.sitemapUrl);
  const parser = createXmlParser();
  const parsed = parser.parse(stripAlternateLinks(xml));

  if (parsed.sitemapindex?.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    const childUrls = sitemaps
      .map((s: any) => s.loc)
      .filter((loc: any): loc is string => typeof loc === "string");

    if (childUrls.length === 0) return [];

    console.error(
      `Sitemap index: ${childUrls.length} child sitemaps, fetching...`,
    );

    const results = await fetchWithConcurrency(
      childUrls,
      config.maxConcurrentFetches,
    );
    const allEntries: DocEntry[] = [];
    const childParser = createXmlParser();

    for (const result of results) {
      if (result.status === "fulfilled") {
        try {
          allEntries.push(
            ...extractEntriesFromUrlset(
              childParser.parse(stripAlternateLinks(result.value)),
            ),
          );
        } catch {
          // skip malformed
        }
      }
    }

    return allEntries;
  }

  return extractEntriesFromUrlset(parsed);
}

// --- Tokenization & index building ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/\-_>]+/)
    .filter((t) => t.length > 1);
}

function buildInvertedIndex(entries: DocEntry[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  const lengths: number[] = new Array(entries.length);
  let totalLength = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tokens = new Set([
      ...tokenize(entry.path),
      ...entry.pathSegments,
      ...tokenize(entry.title),
    ]);

    lengths[i] = tokens.size;
    totalLength += tokens.size;

    for (const token of tokens) {
      let set = index.get(token);
      if (!set) {
        set = new Set();
        index.set(token, set);
      }
      set.add(i);
    }
  }

  docLengths = lengths;
  avgDocLength = entries.length > 0 ? totalLength / entries.length : 1;
  return index;
}

// --- Fuzzy matching (Levenshtein) ---

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

function findFuzzyMatches(term: string, maxDist: number = 2): Set<number> {
  const matches = new Set<number>();
  if (term.length < 4) return matches;

  for (const [key, indices] of invertedIndex) {
    if (Math.abs(key.length - term.length) > maxDist) continue;
    if (levenshtein(term, key) <= maxDist) {
      for (const idx of indices) matches.add(idx);
    }
  }
  return matches;
}

// --- Synonym expansion ---

export function expandWithSynonyms(terms: string[]): string[] {
  const expanded = new Set(terms);
  for (const term of terms) {
    const syns = SYNONYM_MAP[term];
    if (syns) {
      for (const s of syns) {
        for (const t of s.split(/\s+/)) {
          if (t.length > 1) expanded.add(t);
        }
      }
    }
  }
  return Array.from(expanded);
}

// --- BM25 helpers ---

/**
 * Scans the inverted index once for a given term, returning every matching
 * document index (substring match against indexed tokens) plus the raw
 * document frequency (summed across matching tokens, pre-cap). Callers
 * should cache the result per term for the lifetime of a single search —
 * the index has thousands of unique tokens, so this scan is the expensive
 * part of scoring and must not be repeated per-document or per-helper-call.
 */
function matchTermAgainstIndex(term: string): { docIndices: Set<number>; rawDf: number } {
  const docIndices = new Set<number>();
  let rawDf = 0;
  for (const [key, indices] of invertedIndex) {
    if (key.includes(term)) {
      rawDf += indices.size;
      for (const idx of indices) docIndices.add(idx);
    }
  }
  return { docIndices, rawDf };
}

function computeIDFFromDf(rawDf: number, N: number): number {
  const df = Math.min(rawDf, N);
  if (df === 0) return 0;
  return Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

function buildSnippet(entry: DocEntry, terms: string[]): string {
  const segments = entry.path
    .split("/")
    .filter(Boolean)
    .slice(2);
  const matched: string[] = [];

  for (const seg of segments) {
    const low = seg.toLowerCase();
    if (terms.some((t) => low.includes(t))) {
      matched.push(seg.replace(/-/g, " "));
    }
  }

  return matched.length > 0
    ? `Matched in: ${matched.join(" > ")}`
    : `Path: ${segments.slice(-2).join(" > ").replace(/-/g, " ")}`;
}

// --- Cache ---

async function loadFromCache(): Promise<DocEntry[] | null> {
  try {
    const info = await stat(config.sitemapCacheFile);
    if (Date.now() - info.mtimeMs > config.sitemapCacheTtlMs) return null;
    const data = await readFile(config.sitemapCacheFile, "utf-8");
    const entries = JSON.parse(data) as DocEntry[];
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

async function saveToCache(entries: DocEntry[]): Promise<void> {
  try {
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(config.sitemapCacheFile, JSON.stringify(entries), "utf-8");
  } catch {
    // non-critical
  }
}

export async function clearCache(): Promise<void> {
  try {
    await unlink(config.sitemapCacheFile);
  } catch {
    // file may not exist
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

/**
 * BM25-scored search with synonym expansion and fuzzy fallback.
 */
export function searchEntries(
  entries: DocEntry[],
  query: string,
  limit: number = 20,
): SearchResult[] {
  const rawTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (rawTerms.length === 0) {
    return entries
      .slice(0, limit)
      .map((entry) => ({ entry, score: 0, snippet: "" }));
  }

  const allTerms = expandWithSynonyms(rawTerms);
  const useIndex = entries === indexedEntries && invertedIndex.size > 0;
  const N = entries.length;
  const k1 = 1.5;
  const b = 0.75;

  // Scan the inverted index at most once per unique term for this query,
  // and reuse the result for candidate gathering, the fuzzy-fallback check,
  // and IDF — all three used to re-scan the whole index independently
  // (and IDF was being recomputed per document, not just per term).
  const termMatchCache = new Map<string, { docIndices: Set<number>; rawDf: number }>();
  function getTermMatch(term: string) {
    let m = termMatchCache.get(term);
    if (!m) {
      m = matchTermAgainstIndex(term);
      termMatchCache.set(term, m);
    }
    return m;
  }

  // Gather candidate indices via inverted index
  let candidateIndices: Set<number> | null = null;
  const idfByTerm = new Map<string, number>();
  if (useIndex) {
    candidateIndices = new Set<number>();
    for (const term of allTerms) {
      const { docIndices, rawDf } = getTermMatch(term);
      for (const idx of docIndices) candidateIndices.add(idx);
      idfByTerm.set(term, computeIDFFromDf(rawDf, N));
    }
    // Fuzzy fallback for original terms with no exact hits
    for (const term of rawTerms) {
      const { docIndices } = getTermMatch(term);
      if (docIndices.size === 0) {
        for (const idx of findFuzzyMatches(term)) candidateIndices.add(idx);
      }
    }
  }

  const pool =
    useIndex && candidateIndices
      ? Array.from(candidateIndices).map((i) => ({ entry: entries[i], idx: i }))
      : entries.map((entry, idx) => ({ entry, idx }));

  const scored: SearchResult[] = [];

  for (const { entry, idx } of pool) {
    const pathLower = entry.path.toLowerCase();
    const titleLower = entry.title.toLowerCase();
    const lastSeg = entry.pathSegments[entry.pathSegments.length - 1] || "";
    const dl = useIndex ? (docLengths[idx] || 1) : entry.pathSegments.length;

    let score = 0;
    let matchedOriginal = 0;

    for (const term of allTerms) {
      const inPath = pathLower.includes(term);
      const inTitle = titleLower.includes(term);
      const inSegs = entry.pathSegments.some((s) => s.includes(term));

      if (!inPath && !inTitle && !inSegs) continue;

      const idf = useIndex ? (idfByTerm.get(term) ?? 0) : 1;
      let tf = 0;
      if (inPath) tf++;
      if (inTitle) tf++;
      if (inSegs) tf++;

      const tfNorm =
        (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgDocLength));
      score += idf * tfNorm;

      if (lastSeg.includes(term)) score += idf * 0.5;
      if (rawTerms.includes(term)) matchedOriginal++;
    }

    if (matchedOriginal >= rawTerms.length && rawTerms.length > 1) {
      score *= 2;
    }

    if (score > 0) {
      scored.push({ entry, score, snippet: buildSnippet(entry, rawTerms) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function getDocSections(entries: DocEntry[]): Map<string, number> {
  const sections = new Map<string, number>();
  for (const entry of entries) {
    if (entry.section) sections.set(entry.section, (sections.get(entry.section) || 0) + 1);
  }
  return sections;
}

export function getSectionSlugs(entries: DocEntry[]): string[] {
  return [...getDocSections(entries).keys()].sort();
}

export function getSectionEntries(
  entries: DocEntry[],
  section: string,
): DocEntry[] {
  return entries.filter((e) => e.section === section);
}

export function getRelatedDocs(
  entries: DocEntry[],
  url: string,
  limit: number = 10,
): DocEntry[] {
  const target = entries.find((e) => e.url === url);
  if (!target) return [];

  const targetParts = target.path.split("/").filter(Boolean);
  if (targetParts.length < 3) return [];

  const parentPath = targetParts.slice(0, -1).join("/");

  return entries
    .filter((e) => {
      if (e.url === url) return false;
      const parts = e.path.split("/").filter(Boolean);
      return parts.slice(0, -1).join("/") === parentPath;
    })
    .slice(0, limit);
}

export function findEntryByUrl(
  entries: DocEntry[],
  url: string,
): DocEntry | undefined {
  return entries.find((e) => e.url === url);
}
