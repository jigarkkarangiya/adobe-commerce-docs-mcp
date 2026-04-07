import { join } from "node:path";
import { homedir } from "node:os";

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const cacheDir = envStr(
  "CACHE_DIR",
  join(homedir(), ".cache", "adobe-commerce-docs-mcp"),
);

export const config = {
  version: "2.0.0",

  sitemapUrl: envStr(
    "SITEMAP_URL",
    "https://experienceleague.adobe.com/en/sitemap.xml",
  ),

  cacheDir,
  sitemapCacheFile: join(cacheDir, "sitemap-cache.json"),
  pageCacheDir: join(cacheDir, "pages"),

  sitemapCacheTtlMs: envInt("SITEMAP_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
  pageCacheMemoryMax: envInt("PAGE_CACHE_MAX", 100),
  pageCacheMemoryTtlMs: envInt("PAGE_CACHE_TTL_MS", 60 * 60 * 1000),
  pageCacheDiskTtlMs: envInt("PAGE_DISK_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000),

  maxContentLength: envInt("MAX_CONTENT_LENGTH", 15000),
  maxConcurrentFetches: envInt("MAX_CONCURRENT_FETCHES", 5),

  httpPort: envInt("PORT", 3000),
  logLevel: envStr("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",

  userAgent:
    "Mozilla/5.0 (compatible; AdobeCommerceMCP/2.0; +https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp)",

  commercePathPrefixes: [
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
  ],
};
