import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  searchEntries,
  levenshtein,
  expandWithSynonyms,
  type DocEntry,
} from "../src/sitemap.js";

function makeEntry(path: string, title?: string): DocEntry {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/-/g, " ").toLowerCase());
  return {
    url: `https://experienceleague.adobe.com${path}`,
    lastmod: "2025-01-01",
    path,
    pathSegments: segments,
    title:
      title ??
      segments
        .slice(2)
        .map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase()))
        .join(" > "),
    alternates: [],
  };
}

const testEntries: DocEntry[] = [
  makeEntry("/en/docs/commerce-admin/catalog/products/create"),
  makeEntry("/en/docs/commerce-admin/catalog/categories/overview"),
  makeEntry("/en/docs/commerce-admin/checkout/configuration"),
  makeEntry("/en/docs/commerce-php/development/components/dependency-injection"),
  makeEntry("/en/docs/commerce-cloud-service/deploy/best-practices"),
  makeEntry("/en/docs/commerce-operations/upgrade/overview"),
  makeEntry("/en/docs/commerce-knowledge-base/troubleshooting/payments/error-500"),
  makeEntry("/en/docs/commerce-admin/graphql/queries/products"),
  makeEntry("/en/docs/commerce-php/development/components/plugins"),
  makeEntry("/en/docs/commerce-admin/stores/configuration/payment-methods"),
];

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    assert.equal(levenshtein("hello", "hello"), 0);
  });

  it("computes correct distance for single edit", () => {
    assert.equal(levenshtein("cat", "car"), 1);
    assert.equal(levenshtein("cat", "cats"), 1);
  });

  it("handles empty strings", () => {
    assert.equal(levenshtein("", "abc"), 3);
    assert.equal(levenshtein("abc", ""), 3);
  });

  it("handles common Commerce typos", () => {
    assert.ok(levenshtein("chekout", "checkout") <= 2);
    assert.ok(levenshtein("catlog", "catalog") <= 2);
    assert.ok(levenshtein("graphql", "graphqll") <= 2);
  });
});

describe("expandWithSynonyms", () => {
  it("expands known synonyms", () => {
    const result = expandWithSynonyms(["graphql"]);
    assert.ok(result.includes("graphql"));
    assert.ok(result.includes("gql"));
  });

  it("expands cloud/ece", () => {
    const result = expandWithSynonyms(["cloud"]);
    assert.ok(result.includes("ece"));
  });

  it("preserves original terms", () => {
    const result = expandWithSynonyms(["foobar"]);
    assert.deepEqual(result, ["foobar"]);
  });

  it("handles multiple terms", () => {
    const result = expandWithSynonyms(["module", "plugin"]);
    assert.ok(result.includes("module"));
    assert.ok(result.includes("extension"));
    assert.ok(result.includes("plugin"));
    assert.ok(result.includes("interceptor"));
  });
});

describe("searchEntries (linear scan mode)", () => {
  it("returns results for matching query", () => {
    const results = searchEntries(testEntries, "catalog", 10);
    assert.ok(results.length > 0);
    assert.ok(
      results.some((r) => r.entry.path.includes("catalog")),
    );
  });

  it("ranks exact path matches higher", () => {
    const results = searchEntries(testEntries, "checkout configuration", 10);
    assert.ok(results.length > 0);
    assert.ok(results[0].entry.path.includes("checkout"));
  });

  it("returns empty for nonsense query", () => {
    const results = searchEntries(testEntries, "xyznonexistent", 10);
    assert.equal(results.length, 0);
  });

  it("respects limit", () => {
    const results = searchEntries(testEntries, "commerce", 3);
    assert.ok(results.length <= 3);
  });

  it("returns all entries for empty query", () => {
    const results = searchEntries(testEntries, "", 5);
    assert.equal(results.length, 5);
  });

  it("includes snippets in results", () => {
    const results = searchEntries(testEntries, "graphql", 5);
    assert.ok(results.length > 0);
    assert.ok(typeof results[0].snippet === "string");
    assert.ok(results[0].snippet.length > 0);
  });

  it("returns scored results sorted by score", () => {
    const results = searchEntries(testEntries, "deploy", 10);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score);
    }
  });
});
