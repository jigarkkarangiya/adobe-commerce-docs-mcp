import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodeExamples,
  extractPageToc,
  extractStructuredContent,
  smartTruncate,
} from "../src/content.js";

const SAMPLE_MARKDOWN = `# Product Catalog

This guide explains how to manage your product catalog.

## Creating Products

To create a product, follow these steps:

1. Navigate to Catalog > Products
2. Click "Add Product"

\`\`\`php
$product = $this->productFactory->create();
$product->setName('Test Product');
$product->setSku('test-sku');
$product->save();
\`\`\`

## Configuring Categories

Categories organize your catalog hierarchy.

\`\`\`xml
<config>
    <category name="Electronics" />
</config>
\`\`\`

### Nested Categories

You can nest categories up to 10 levels deep.

## Related Links

See [Admin Guide](https://experienceleague.adobe.com/en/docs/commerce-admin) and
[API Reference](https://experienceleague.adobe.com/en/docs/commerce-php/api).
`;

describe("extractCodeExamples", () => {
  it("extracts fenced code blocks with languages", () => {
    const examples = extractCodeExamples(SAMPLE_MARKDOWN);
    assert.equal(examples.length, 2);
    assert.equal(examples[0].language, "php");
    assert.ok(examples[0].code.includes("productFactory"));
    assert.equal(examples[1].language, "xml");
    assert.ok(examples[1].code.includes("<config>"));
  });

  it("returns empty array for markdown with no code", () => {
    const examples = extractCodeExamples("# Hello\n\nNo code here.");
    assert.equal(examples.length, 0);
  });

  it("handles code blocks without language tag", () => {
    const md = "```\nplain code\n```";
    const examples = extractCodeExamples(md);
    assert.equal(examples.length, 1);
    assert.equal(examples[0].language, "text");
  });
});

describe("extractPageToc", () => {
  it("extracts heading hierarchy", () => {
    const toc = extractPageToc(SAMPLE_MARKDOWN);
    assert.ok(toc.length >= 4);
    assert.equal(toc[0].level, 1);
    assert.equal(toc[0].title, "Product Catalog");
    assert.equal(toc[1].level, 2);
    assert.equal(toc[1].title, "Creating Products");
  });

  it("includes nested headings", () => {
    const toc = extractPageToc(SAMPLE_MARKDOWN);
    const nested = toc.find((h) => h.title === "Nested Categories");
    assert.ok(nested);
    assert.equal(nested!.level, 3);
  });

  it("returns empty for no headings", () => {
    const toc = extractPageToc("Just plain text\nwith no headings.");
    assert.equal(toc.length, 0);
  });
});

describe("extractStructuredContent", () => {
  it("extracts title from h1", () => {
    const sc = extractStructuredContent(SAMPLE_MARKDOWN);
    assert.equal(sc.title, "Product Catalog");
  });

  it("extracts description from first paragraph", () => {
    const sc = extractStructuredContent(SAMPLE_MARKDOWN);
    assert.ok(sc.description.includes("manage your product catalog"));
  });

  it("extracts sections from h2/h3 headings", () => {
    const sc = extractStructuredContent(SAMPLE_MARKDOWN);
    assert.ok(sc.sections.length >= 3);
    assert.equal(sc.sections[0].heading, "Creating Products");
  });

  it("extracts code examples", () => {
    const sc = extractStructuredContent(SAMPLE_MARKDOWN);
    assert.equal(sc.codeExamples.length, 2);
  });

  it("extracts related links", () => {
    const sc = extractStructuredContent(SAMPLE_MARKDOWN);
    assert.ok(sc.relatedLinks.length >= 2);
    assert.ok(sc.relatedLinks.some((l) => l.text === "Admin Guide"));
  });
});

describe("smartTruncate", () => {
  it("returns content unchanged if under limit", () => {
    const short = "Hello world";
    assert.equal(smartTruncate(short, 1000), short);
  });

  it("truncates long content with indicator", () => {
    const long = "a".repeat(100);
    const result = smartTruncate(long, 50);
    assert.ok(result.length < 100 + 50);
    assert.ok(result.includes("truncated"));
  });

  it("prefers heading boundaries for truncation", () => {
    const content = [
      "# Title",
      "",
      "Some intro text here that is long enough.",
      "",
      "## Section 1",
      "",
      "Content for section 1.",
      "",
      "## Section 2",
      "",
      "Content for section 2 that we want to cut.",
      "",
      "## Section 3",
      "",
      "More content after the cut point.",
    ].join("\n");

    const result = smartTruncate(content, content.length - 40);
    assert.ok(result.includes("truncated"));
    assert.ok(!result.includes("Section 3") || result.includes("truncated"));
  });
});
