/**
 * The clip extension's metadata extraction (extension/src/capture.ts
 * extractMetadata), re-implemented over raw archive HTML for the backfill:
 * clips whose ingest metadata was destroyed by the old blob rewrite are
 * re-run from the archived page, which still carries the original og:/
 * article:/JSON-LD tags. Same source precedence as the extension, minus the
 * live-DOM conveniences.
 *
 * Pure string work, no Convex imports, pinned by vitest.
 */

export interface HtmlMeta {
  title?: string;
  byline?: string;
  siteName?: string;
  description?: string;
  publishedAt?: string;
  lang?: string;
  ogImage?: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => ENTITIES[entity] ?? entity);
}

/** First occurrence wins, matching querySelector. Keys are "og:title" etc. */
function metaMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key =
      /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!key || !content) continue;
    const value = decodeEntities(content).trim();
    if (value && !map.has(key)) map.set(key, value);
  }
  return map;
}

/** The first Article-flavored JSON-LD node, matching the extension's search. */
function articleJsonLd(html: string): Record<string, unknown> {
  const scripts =
    html.match(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) ?? [];
  for (const block of scripts) {
    const body = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(block)?.[1] ?? "";
    try {
      const parsed = JSON.parse(body);
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      const article = nodes.find(
        (n) =>
          typeof n === "object" &&
          n !== null &&
          /Article|NewsArticle|BlogPosting|WebPage/.test(
            String((n as Record<string, unknown>)["@type"] ?? "")
          )
      );
      if (article) return article as Record<string, unknown>;
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return {};
}

export function extractHtmlMeta(html: string): HtmlMeta {
  const meta = metaMap(html);
  const jsonLd = articleJsonLd(html);

  const ldAuthor = jsonLd.author;
  const ldAuthorName =
    typeof ldAuthor === "string"
      ? ldAuthor
      : Array.isArray(ldAuthor) && ldAuthor.length > 0
        ? String((ldAuthor[0] as Record<string, unknown>)?.name ?? "") ||
          undefined
        : typeof ldAuthor === "object" && ldAuthor !== null
          ? String((ldAuthor as Record<string, unknown>).name ?? "") || undefined
          : undefined;

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const lang = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];

  const pick = (value: string | undefined) => value?.trim() || undefined;

  return {
    title:
      meta.get("og:title") ??
      (typeof jsonLd.headline === "string" ? pick(jsonLd.headline) : undefined) ??
      (titleTag ? pick(decodeEntities(titleTag)) : undefined),
    byline: meta.get("author") ?? pick(ldAuthorName),
    siteName: meta.get("og:site_name"),
    description: meta.get("og:description") ?? meta.get("description"),
    publishedAt:
      meta.get("article:published_time") ??
      (typeof jsonLd.datePublished === "string"
        ? pick(jsonLd.datePublished)
        : undefined),
    lang: pick(lang),
    ogImage: meta.get("og:image"),
  };
}
