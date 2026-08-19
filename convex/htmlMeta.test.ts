import { describe, expect, it } from "vitest";
import { extractHtmlMeta } from "./htmlMeta";

const PAGE = `<!doctype html>
<html lang="en-US">
<head>
<title>Fallback &amp; Title — Site</title>
<meta property="og:title" content="The Real Headline">
<meta name="author" content="Jane Byline">
<meta property="og:site_name" content="The Atlantic">
<meta name="description" content="plain description">
<meta property="og:description" content="og description">
<meta property="article:published_time" content="2024-05-01T10:00:00Z">
<meta property="og:image" content="https://example.com/x.jpg">
</head><body><p>hi</p></body></html>`;

describe("extractHtmlMeta", () => {
  it("mirrors the extension's precedence", () => {
    expect(extractHtmlMeta(PAGE)).toEqual({
      title: "The Real Headline",
      byline: "Jane Byline",
      siteName: "The Atlantic",
      description: "og description",
      publishedAt: "2024-05-01T10:00:00Z",
      lang: "en-US",
      ogImage: "https://example.com/x.jpg",
    });
  });

  it("falls back to JSON-LD, then the title tag", () => {
    const page = `<html><head>
<title>Tab Title</title>
<script type="application/ld+json">
{"@graph":[{"@type":"NewsArticle","headline":"LD Headline",
"author":[{"name":"LD Author"}],"datePublished":"2023-01-02"}]}
</script></head></html>`;
    const meta = extractHtmlMeta(page);
    expect(meta.title).toBe("LD Headline");
    expect(meta.byline).toBe("LD Author");
    expect(meta.publishedAt).toBe("2023-01-02");
    expect(extractHtmlMeta("<title>Tab Title</title>").title).toBe("Tab Title");
  });

  it("decodes entities and tolerates attribute order", () => {
    const page = `<meta content="A &amp; B" property="og:title">`;
    expect(extractHtmlMeta(page).title).toBe("A & B");
  });

  it("returns nothing for tagless or malformed pages", () => {
    expect(extractHtmlMeta("<p>plain</p>")).toEqual({
      title: undefined,
      byline: undefined,
      siteName: undefined,
      description: undefined,
      publishedAt: undefined,
      lang: undefined,
      ogImage: undefined,
    });
    expect(
      extractHtmlMeta(
        `<script type="application/ld+json">not json</script>`
      ).title
    ).toBeUndefined();
  });
});
