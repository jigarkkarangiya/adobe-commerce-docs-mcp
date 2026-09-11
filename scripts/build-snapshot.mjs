#!/usr/bin/env node
// Builds dist/sitemap-snapshot.json — a pre-fetched, pre-indexed copy of
// the Commerce sitemap, bundled into the npm package so a cold start
// (no disk cache yet) can index instantly from a local file read instead
// of blocking on a live ~77MB sitemap fetch. See loadSitemap() in
// src/sitemap.ts for how it's used (as a fast starting point only — a
// live background refresh always follows and supersedes it within seconds).
//
// Runs against the compiled dist/ output, so `npm run build` must happen
// first — wired into package.json's prepublishOnly for that reason.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { fetchSitemap } = await import(join(__dirname, "../dist/sitemap.js"));

  console.error("Fetching live sitemap for snapshot...");
  const entries = await fetchSitemap();

  if (entries.length === 0) {
    console.error("Fetched 0 entries — refusing to write an empty snapshot (leaving any existing one in place).");
    process.exit(1);
  }

  const outPath = join(__dirname, "../dist/sitemap-snapshot.json");
  await writeFile(outPath, JSON.stringify(entries), "utf-8");
  console.error(`Wrote ${entries.length} entries to ${outPath}`);
}

main().catch((err) => {
  console.error("build-snapshot failed:", err);
  process.exit(1);
});
