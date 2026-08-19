/**
 * Content script, injected on demand. Defines a global capture function that
 * the background worker invokes; it returns the full clip payload:
 *   - archiveHtml: self-contained single-file snapshot (styles + images inlined)
 *   - articleMarkdown / title / metadata: Readability parse of the page
 */
import { Readability } from "@mozilla/readability";

interface CaptureOptions {
  inlineImages: boolean;
}

interface ClipPayload {
  url: string;
  title: string;
  archiveHtml: string;
  articleMarkdown: string;
  metadata: {
    byline?: string;
    siteName?: string;
    description?: string;
    publishedAt?: string;
    excerpt?: string;
    lang?: string;
    ogImage?: string;
  };
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // skip inlining single images above this
const MAX_CSS_ASSET_BYTES = 512 * 1024; // fonts / background images
// The /clip endpoint rejects archives over 5M characters, so inlining gets
// whatever this target leaves after the page's own HTML and CSS text; past
// that, resources keep their absolute URL instead of sinking the whole clip.
const ARCHIVE_TARGET_CHARS = 4_800_000;
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

async function fetchAsDataUri(
  url: string,
  maxBytes: number
): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  if (!/^https?:/.test(url)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > maxBytes) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** CORS-blocked images that already rendered can be recovered via canvas. */
function imageElementToDataUri(img: HTMLImageElement): string | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null; // tainted canvas
  }
}

// ---------------------------------------------------------------------------
// CSS collection: concatenate all stylesheets, absolutizing url(...) refs
// ---------------------------------------------------------------------------

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function rewriteCssUrls(css: string, baseUrl: string): string {
  return css.replace(CSS_URL_RE, (match, _q, ref) =>
    ref.startsWith("data:") ? match : `url("${absolutize(ref, baseUrl)}")`
  );
}

/**
 * Inline fonts and background images referenced from CSS, so typography and
 * decoration survive the original going offline or refusing cross-origin
 * loads. Refs the budget can't afford keep their absolute URL.
 */
async function inlineCssAssets(
  css: string,
  afford: (chars: number) => boolean
): Promise<string> {
  // A ref repeated across rules expands at every occurrence, so the budget
  // must be charged per occurrence, not per unique URL.
  const refCounts = new Map<string, number>();
  for (const match of css.matchAll(CSS_URL_RE)) {
    const ref = match[2];
    if (/^https?:/.test(ref)) {
      refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    }
  }
  if (refCounts.size === 0) return css;

  // Fetch in parallel; spend the budget in deterministic (document) order.
  const fetched = await Promise.all(
    Array.from(refCounts.keys(), async (ref) =>
      [ref, await fetchAsDataUri(ref, MAX_CSS_ASSET_BYTES)] as const
    )
  );
  const inlined = new Map<string, string>();
  for (const [ref, dataUri] of fetched) {
    if (dataUri && afford(dataUri.length * refCounts.get(ref)!)) {
      inlined.set(ref, dataUri);
    }
  }
  if (inlined.size === 0) return css;
  return css.replace(CSS_URL_RE, (match, _q, ref) => {
    const dataUri = inlined.get(ref);
    return dataUri ? `url("${dataUri}")` : match;
  });
}

async function collectCss(): Promise<string> {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const base = sheet.href ?? location.href;
    try {
      const rules = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
      parts.push(rewriteCssUrls(rules, base));
    } catch {
      // Cross-origin stylesheet: fetch its text directly
      if (sheet.href) {
        try {
          const res = await fetch(sheet.href, { credentials: "omit" });
          if (res.ok) parts.push(rewriteCssUrls(await res.text(), sheet.href));
        } catch {
          parts.push(`@import url("${sheet.href}");`);
        }
      }
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Archive: clone the DOM, strip scripts, inline styles and images
// ---------------------------------------------------------------------------

async function buildArchive(options: CaptureOptions): Promise<string> {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;

  // Strip active/executable content, self-navigation, and resource hints
  // that would only dangle or phone home from an archive.
  clone
    .querySelectorAll(
      "script, noscript, link[rel='preload'], link[rel='modulepreload'], link[rel='prefetch'], link[rel='preconnect'], link[rel='dns-prefetch'], link[rel='manifest'], meta[http-equiv='Content-Security-Policy' i], meta[http-equiv='refresh' i]"
    )
    .forEach((el) => el.remove());
  clone.querySelectorAll("iframe, frame, embed, object").forEach((el) => {
    const note = document.createElement("div");
    note.setAttribute("data-clipper-removed", el.tagName.toLowerCase());
    note.style.cssText = "border:1px dashed #999;padding:8px;color:#666;font:12px sans-serif;";
    note.textContent = `[embedded ${el.tagName.toLowerCase()} removed: ${
      el.getAttribute("src") ?? ""
    }]`;
    el.replaceWith(note);
  });
  clone.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
    }
    const href = el.getAttribute("href");
    if (href?.trim().toLowerCase().startsWith("javascript:")) {
      el.setAttribute("href", "#");
    }
  });

  // Absolutize links
  clone.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("href", absolutize(a.getAttribute("href")!, location.href));
  });

  // A <picture>'s <source> list outranks its <img> src, so leaving the
  // sources in would make the browser ignore the inlined copy below and go
  // back to the network. The <img> already shows what the reader saw.
  clone.querySelectorAll("picture > source").forEach((el) => el.remove());

  // Audio/video stays streamable from the live URL (inlining media would
  // dwarf the archive), but must neither autoplay nor preload on open.
  clone.querySelectorAll("video, audio, source, track").forEach((el) => {
    const src = el.getAttribute("src");
    if (src) el.setAttribute("src", absolutize(src, location.href));
    el.removeAttribute("autoplay");
    if (el.tagName !== "SOURCE" && el.tagName !== "TRACK") {
      el.setAttribute("preload", "none");
    }
  });

  // Absolutize every image first. Original and clone querySelectorAll orders
  // match, so index-pair the live elements with their clones.
  const liveImgs = Array.from(document.querySelectorAll("img"));
  const cloneImgs = Array.from(clone.querySelectorAll("img"));
  const inlineCandidates: {
    cloneImg: HTMLImageElement;
    liveImg: HTMLImageElement | undefined;
    abs: string;
  }[] = [];
  for (let i = 0; i < cloneImgs.length; i++) {
    const cloneImg = cloneImgs[i];
    const liveImg = liveImgs[i];
    cloneImg.removeAttribute("srcset");
    cloneImg.removeAttribute("loading");
    // currentSrc resolves srcset/lazy-load to what's actually displayed
    const src =
      liveImg?.currentSrc ||
      cloneImg.getAttribute("src") ||
      cloneImg.getAttribute("data-src") ||
      "";
    if (!src) continue;
    const abs = absolutize(src, location.href);
    cloneImg.setAttribute("src", abs);
    if (options.inlineImages) inlineCandidates.push({ cloneImg, liveImg, abs });
  }

  let css = await collectCss();

  // Everything above is text the archive must carry; inlining only gets what
  // that leaves under the /clip ceiling. A resource the budget can't afford
  // keeps its absolute URL rather than sinking the whole clip as oversized.
  let inlineBudget = Math.max(
    0,
    ARCHIVE_TARGET_CHARS - clone.outerHTML.length - css.length
  );
  const afford = (chars: number): boolean => {
    if (chars > inlineBudget) return false;
    inlineBudget -= chars;
    return true;
  };

  // Content images first, then fonts and background images from what's left.
  for (const { cloneImg, liveImg, abs } of inlineCandidates) {
    if (inlineBudget <= 0) break;
    const dataUri =
      (await fetchAsDataUri(abs, MAX_IMAGE_BYTES)) ??
      (liveImg ? imageElementToDataUri(liveImg) : null);
    if (dataUri && afford(dataUri.length)) {
      cloneImg.setAttribute("src", dataUri);
    }
  }
  if (options.inlineImages && inlineBudget > 0) {
    css = await inlineCssAssets(css, afford);
  }

  // Replace all stylesheet links / style tags with one combined inline sheet
  clone
    .querySelectorAll("link[rel='stylesheet'], style")
    .forEach((el) => el.remove());
  const head = clone.querySelector("head") ?? clone;
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  head.appendChild(styleEl);

  // Every URL in the archive is absolute by now, so an original <base> only
  // misleads; ours sends link clicks to a new tab on the live web — followed
  // in place, a link would render scriptless inside the viewer's sandbox.
  clone.querySelectorAll("base").forEach((el) => el.remove());
  const baseEl = document.createElement("base");
  baseEl.setAttribute("target", "_blank");
  head.insertBefore(baseEl, head.firstChild);

  // Ensure charset + canonical base metadata (charset must stay first)
  const metaCharset = document.createElement("meta");
  metaCharset.setAttribute("charset", "utf-8");
  head.insertBefore(metaCharset, head.firstChild);

  const banner = `<!--
  Archived by Haystack Clipper
  Source: ${location.href}
  Clipped: ${new Date().toISOString()}
-->\n`;
  return `<!DOCTYPE html>\n${banner}${clone.outerHTML}`;
}

// ---------------------------------------------------------------------------
// HTML → markdown (compact walker; enough for article content)
// ---------------------------------------------------------------------------

function htmlToMarkdown(root: HTMLElement): string {
  const walk = (node: Node, listDepth = 0, ordered = false): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? "").replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const children = (d = listDepth, o = ordered) =>
      Array.from(el.childNodes)
        .map((c) => walk(c, d, o))
        .join("");
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
      case "p":
        return `\n\n${children().trim()}\n\n`;
      case "br":
        return "\n";
      case "hr":
        return "\n\n* * *\n\n";
      case "strong": case "b":
        return `**${children().trim()}**`;
      case "em": case "i":
        return `*${children().trim()}*`;
      case "code":
        return el.closest("pre") ? children() : `\`${children().trim()}\``;
      case "pre":
        return `\n\n\`\`\`\n${el.textContent ?? ""}\n\`\`\`\n\n`;
      case "a": {
        const text = children().trim();
        const href = el.getAttribute("href");
        if (!href || !text) return text;
        return `[${text}](${absolutize(href, location.href)})`;
      }
      case "img": {
        const alt = el.getAttribute("alt")?.trim();
        return alt ? `![${alt}]` : "";
      }
      case "ul": case "ol": {
        const isOrdered = tag === "ol";
        const items = Array.from(el.children)
          .filter((c) => c.tagName.toLowerCase() === "li")
          .map((li, i) => {
            const bullet = isOrdered ? `${i + 1}.` : "-";
            const content = walk(li, listDepth + 1, isOrdered).trim();
            return `${"  ".repeat(listDepth)}${bullet} ${content}`;
          })
          .join("\n");
        return `\n\n${items}\n\n`;
      }
      case "li":
        return children();
      case "blockquote": {
        const inner = children().trim().split("\n").map((l) => `> ${l}`).join("\n");
        return `\n\n${inner}\n\n`;
      }
      case "table": {
        const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
          Array.from(tr.querySelectorAll("th,td"))
            .map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
            .join(" | ")
        );
        if (rows.length === 0) return "";
        const header = rows[0];
        const sep = header.split(" | ").map(() => "---").join(" | ");
        return `\n\n${[`| ${header} |`, `| ${sep} |`, ...rows.slice(1).map((r) => `| ${r} |`)].join("\n")}\n\n`;
      }
      case "figure": case "figcaption": case "div": case "section": case "article":
      case "main": case "span": case "header": case "footer": case "aside":
        return children();
      default:
        return children();
    }
  };
  return walk(root)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

function meta(selector: string): string | undefined {
  const el = document.querySelector<HTMLMetaElement>(selector);
  const content = el?.getAttribute("content")?.trim();
  return content || undefined;
}

function extractMetadata(): ClipPayload["metadata"] & { title?: string } {
  let jsonLd: Record<string, unknown> = {};
  for (const script of Array.from(
    document.querySelectorAll("script[type='application/ld+json']")
  )) {
    try {
      const parsed = JSON.parse(script.textContent ?? "");
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      const article = nodes.find(
        (n) =>
          typeof n === "object" && n !== null &&
          /Article|NewsArticle|BlogPosting|WebPage/.test(
            String((n as Record<string, unknown>)["@type"] ?? "")
          )
      );
      if (article) {
        jsonLd = article as Record<string, unknown>;
        break;
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  const ldAuthor = jsonLd.author;
  const ldAuthorName =
    typeof ldAuthor === "string"
      ? ldAuthor
      : typeof ldAuthor === "object" && ldAuthor !== null
        ? String((ldAuthor as Record<string, unknown>).name ?? "") || undefined
        : Array.isArray(ldAuthor) && ldAuthor.length > 0
          ? String((ldAuthor[0] as Record<string, unknown>)?.name ?? "") || undefined
          : undefined;

  return {
    title:
      meta("meta[property='og:title']") ||
      (typeof jsonLd.headline === "string" ? jsonLd.headline : undefined) ||
      document.title || undefined,
    byline: meta("meta[name='author']") || ldAuthorName,
    siteName: meta("meta[property='og:site_name']") || location.hostname,
    description:
      meta("meta[property='og:description']") || meta("meta[name='description']"),
    publishedAt:
      meta("meta[property='article:published_time']") ||
      (typeof jsonLd.datePublished === "string" ? jsonLd.datePublished : undefined),
    lang: document.documentElement.lang || undefined,
    ogImage: meta("meta[property='og:image']"),
  };
}

// ---------------------------------------------------------------------------
// Entry point, invoked by the background worker after injection
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __haystackCapture: (options: CaptureOptions) => Promise<ClipPayload>;
  }
}

window.__haystackCapture = async (options: CaptureOptions) => {
  const pageMeta = extractMetadata();

  // Readability mutates its input — give it a clone
  const article = new Readability(
    document.cloneNode(true) as Document
  ).parse();

  let articleMarkdown = "";
  if (article?.content) {
    const container = document.implementation
      .createHTMLDocument("")
      .createElement("div");
    container.innerHTML = article.content;
    articleMarkdown = htmlToMarkdown(container);
  }
  if (!articleMarkdown.trim()) {
    articleMarkdown = (document.body.innerText ?? "").trim();
  }

  const archiveHtml = await buildArchive(options);

  return {
    url: location.href,
    title: article?.title || pageMeta.title || document.title || location.href,
    archiveHtml,
    articleMarkdown,
    metadata: {
      byline: article?.byline || pageMeta.byline,
      siteName: article?.siteName || pageMeta.siteName,
      description: pageMeta.description,
      publishedAt: article?.publishedTime || pageMeta.publishedAt,
      excerpt: article?.excerpt || undefined,
      lang: pageMeta.lang,
      ogImage: pageMeta.ogImage,
    },
  };
};
