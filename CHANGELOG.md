# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `.mcp.json` at repo root, the standard MCP client config file (Open
  Plugins standard) that lets tool directories like cursor.directory
  auto-detect this as a valid MCP server without inspecting `package.json`.

## [2.0.3] - 2026-09-12

### Added
- Dynamic Commerce section discovery: sections are now detected from the live
  sitemap by product-slug pattern (`commerce` / `commerce-*`) instead of a
  hardcoded prefix list, so new Adobe sections are indexed automatically on
  the next load — no code change required.
- `EXTRA_COMMERCE_SLUGS` env var as an escape hatch to force-include a
  product slug that doesn't literally start with `commerce`.
- Startup log now prints the discovered section list for visibility.
- Structured tool output: every tool returns typed `structuredContent`
  (JSON Schema `outputSchema`) alongside its markdown text, so MCP clients
  can parse results programmatically instead of re-parsing formatted text.
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) and `title` on all 9 tools and all 4 prompts, per the MCP
  spec — reduces confirmation friction in clients that respect these hints.
- `CHANGELOG.md` (this file) — tracked going forward for every release.
- `.github/dependabot.yml` — weekly automated update PRs for npm and
  GitHub Actions dependencies.
- `server.json` and `mcpName` in `package.json`, needed to publish this
  server's metadata to the official MCP Registry
  (`io.github.jigarkkarangiya/adobe-commerce-docs-mcp`) so downstream
  aggregators (Smithery, PulseMCP, Glama, mcp.so) and MCP-aware tools can
  discover it.

### Fixed
- `commerce-on-cloud` (146 pages) was missing from the indexed sections
  entirely — caught by the move to dynamic discovery, verified against the
  live sitemap. Dead `commerce-php` prefix (0 pages left on the live site)
  removed from the old list before it was replaced.
- CI could never actually publish: the workflow's `push` trigger only
  listened on `branches: [main]`, so a `v*` tag push — what the publish job
  was gated on — never fired the workflow at all. Added `tags: ["v*"]`.
- `fast-xml-parser` was resolving to 5.5.10, vulnerable to
  [GHSA-gh4j-gqv2-49f6](https://github.com/advisories/GHSA-gh4j-gqv2-49f6)
  (XML comment/CDATA injection); bumped `^5.2.0` → `^5.11.1`.
- `@modelcontextprotocol/sdk` bumped `^1.12.1` → `^1.30.0` and ran
  `npm audit fix` on its transitive HTTP-transport dependencies
  (hono, express, body-parser, ip-address, qs): 10 vulnerabilities → 1
  (a dev-only, Windows-only, low-severity issue not shipped in the package).
- `commerce://docs/{section}` resource could return an unbounded page list
  (the largest section has 1,312 pages) with no context-window guard —
  capped at 300 entries with a pointer to `search_adobe_commerce_docs`.

### Changed
- **License**: rewritten as a proprietary source-available license.
  Viewing the source and running the unmodified package (including via
  npm/npx) is permitted for personal, educational, or internal
  non-commercial use; modification, forking, redistribution, and
  commercial use require prior written permission. `package.json`
  `license` field set to `"SEE LICENSE IN LICENSE"`.
- CI publish step now runs `npm publish --provenance` with
  `permissions: id-token: write`, so published versions carry verifiable
  Sigstore build provenance instead of relying solely on a stored npm token.
- Added `types` field to `package.json` (the package already ships
  `dist/*.d.ts`, just wasn't declaring it).

### Performance
- **Search (`searchEntries`)**: BM25 IDF and inverted-index candidate
  lookups were being recomputed by scanning the *entire* index per query
  term *per document* instead of once per term. Memoized per-term index
  scans and IDF for the lifetime of a single search call. Measured on the
  live 3,252-page index: **~38x faster** (149ms → 3.95ms average per query).
- **Sitemap cold load**: the raw sitemap XML carries ~10 `<xhtml:link>`
  hreflang-alternate tags per URL (~350,000 nodes total) that are parsed
  but never consumed anywhere in the codebase. These are now stripped from
  the raw XML with a cheap regex before parsing instead of being parsed and
  discarded. XML parse stage: **~7x faster** (2.55s → 0.37s, isolated
  benchmark against the live 77MB sitemap).

## [2.0.2] - 2026-05-20

### Fixed
- `getSectionEntries` matched sections with `path.includes("/section/")`,
  a substring check that could match the wrong section for prefix-overlapping
  slugs. Switched to exact equality against a `section` field computed once
  per entry at index-build time (also used by `getDocSections`).
- Synced `config.ts`'s `version` constant with `package.json` (they had
  drifted).

### Changed
- License switched from MIT to CC BY-NC 4.0 (non-commercial).
- README cross-links added to sibling Adobe-ecosystem MCP servers
  (API Mesh, Commerce KB, I/O Events, etc).
- Removed unused `extractStructuredContent` import from `index.ts`.

## [2.0.1] - 2026-05-20

### Changed
- SEO: expanded npm `keywords`, added registry/homepage links, cross-linked
  sibling MCP packages in the README.

## [2.0.0] - 2026-04-07

### Added
- MCP Resources: `commerce://sections`, `commerce://stats`,
  `commerce://docs/{section}` (with section-slug autocompletion).
- MCP Prompts: `troubleshoot-commerce-error`, `explain-commerce-concept`,
  `commerce-code-review`, `commerce-upgrade-guide`.
- 5 new tools: `get_related_docs`, `get_code_examples`, `get_page_toc`,
  `lookup_error_code`, `multi_page_search`.
- Commerce-specific synonym expansion (40+ mappings, e.g. `graphql` ↔ `gql`)
  and Levenshtein fuzzy matching for typos.
- Smart truncation at heading boundaries instead of mid-sentence.
- Persistent disk page cache (7-day TTL, survives restarts) alongside the
  in-memory LRU cache.
- Structured content extraction (title, sections, code examples, links).
- Env var configuration for all settings (`src/config.ts`).
- Streamable HTTP transport via `--http` flag for remote/team deployment.
- Dockerfile for containerized HTTP deployment.
- GitHub Actions CI: build + test on Node 18/20/22, auto-publish on tag.
- 29 unit tests covering search, Levenshtein, synonyms, content extraction.

### Changed
- Replaced additive keyword scoring with BM25 (IDF weighting, document-length
  normalization) in `searchEntries`.

## [1.1.0] - 2026-04-07

### Added
- Initial release: MCP server indexing the Adobe Experience League sitemap.
- 4 tools: `search_adobe_commerce_docs`, `get_doc_content`,
  `list_doc_sections`, `refresh_sitemap`.
- Native `.md` endpoint fetching (avoids HTML parsing where Adobe serves
  a markdown variant of a page).
- Pre-warm on startup building an inverted index for fast search.
- LRU page cache (100 pages, 1h TTL) plus a 24h disk sitemap cache.
- Sitemap index support with concurrent sub-sitemap fetching.

[2.0.3]: https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp/releases/tag/v1.1.0
