import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// Better Auth's /api/auth/* routes. Position in this file is cosmetic: Convex
// matches exact paths first, then prefixes longest-first, so `/api/auth/`
// always beats the `/` catch-all registerStaticRoutes adds at the bottom
// regardless of registration order. `cors: true` is for `vite dev`; see
// convex/auth.ts.
authComponent.registerRoutes(http, createAuth, { cors: true });

// ---------------------------------------------------------------------------
// POST /clip — web clipper ingestion endpoint.
// The Chrome extension sends a self-contained HTML archive plus the parsed
// article (markdown + metadata). Auth is a personal bearer token minted in
// Settings (convex/clipperTokens.ts), which also names the project clips
// land in and the account the Analyze spend bills to.
// ---------------------------------------------------------------------------

// Per-string ceiling on the two large clip payloads. Well under what a page
// realistically produces, and keeps a hostile caller from parking arbitrary
// bytes in storage on someone's token.
const MAX_CLIP_PART_CHARS = 5_000_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

http.route({
  path: "/clip",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }),
});

http.route({
  path: "/clip",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    // Body is parsed before auth only because the optional per-clip
    // `projectId` override rides in it and resolve validates token and
    // override together, in one query.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: "Body must be JSON" });
    }
    if (typeof body !== "object" || body === null) {
      return jsonResponse(400, { error: "Body must be a JSON object" });
    }
    const b = body as Record<string, unknown>;

    const resolved = await ctx.runQuery(internal.clipperTokens.resolve, {
      token,
      projectId: optionalString(b.projectId),
    });
    if (!resolved) {
      return jsonResponse(401, {
        error: "Invalid clipper token or project",
      });
    }
    if (resolved.exhausted) {
      return jsonResponse(402, {
        error: "This account is out of processing budget",
      });
    }

    if (typeof b.url !== "string" || !/^https?:\/\//.test(b.url)) {
      return jsonResponse(400, { error: "'url' must be an http(s) URL" });
    }
    if (typeof b.title !== "string" || !b.title.trim()) {
      return jsonResponse(400, { error: "'title' must be a non-empty string" });
    }
    if (typeof b.archiveHtml !== "string" || !b.archiveHtml.trim()) {
      return jsonResponse(400, { error: "'archiveHtml' must be a non-empty string" });
    }
    if (typeof b.articleMarkdown !== "string" || !b.articleMarkdown.trim()) {
      return jsonResponse(400, { error: "'articleMarkdown' must be a non-empty string" });
    }
    if (
      b.archiveHtml.length > MAX_CLIP_PART_CHARS ||
      b.articleMarkdown.length > MAX_CLIP_PART_CHARS
    ) {
      return jsonResponse(413, {
        error: `'archiveHtml' and 'articleMarkdown' must each be under ${MAX_CLIP_PART_CHARS} characters`,
      });
    }
    const rawMeta =
      typeof b.metadata === "object" && b.metadata !== null
        ? (b.metadata as Record<string, unknown>)
        : {};
    const tags = Array.isArray(b.tags)
      ? b.tags.filter((t): t is string => typeof t === "string" && !!t.trim())
      : [];
    const notes = optionalString(b.notes);
    const force = b.force === true;

    // Refuse duplicates before storing any bytes (across all the owner's
    // projects — the same scope the popup's warning checks). The mutation
    // re-checks the target project transactionally as the race backstop.
    if (!force) {
      const existing = await ctx.runQuery(internal.clips.lookupClipped, {
        token,
        url: b.url,
      });
      if (existing) {
        return jsonResponse(409, {
          error: "This page is already clipped",
          documentId: existing.documentId,
          projectName: existing.projectName,
          clippedAt: existing.clippedAt,
        });
      }
    }

    // Store both artifacts: the archive is what humans view; the markdown is
    // what the AI pipeline (metadata pass, extraction) reads.
    const storageId = await ctx.storage.store(
      new Blob([b.archiveHtml], { type: "text/html" })
    );
    const textStorageId = await ctx.storage.store(
      new Blob([b.articleMarkdown], { type: "text/markdown" })
    );

    let documentId;
    try {
      documentId = await ctx.runMutation(internal.clips.createFromClip, {
        projectId: resolved.projectId,
        ownerId: resolved.ownerId,
        title: b.title.trim(),
        url: b.url,
        force,
        storageId,
        textStorageId,
        articleMarkdown: b.articleMarkdown,
        tags,
        notes,
        byline: optionalString(rawMeta.byline),
        siteName: optionalString(rawMeta.siteName),
        description: optionalString(rawMeta.description),
        publishedAt: optionalString(rawMeta.publishedAt),
        excerpt: optionalString(rawMeta.excerpt),
        lang: optionalString(rawMeta.lang),
        ogImage: optionalString(rawMeta.ogImage),
      });
    } catch (e) {
      // The mutation's transactional duplicate backstop (two clips racing).
      const data =
        e instanceof ConvexError && typeof e.data === "object" && e.data !== null
          ? (e.data as Record<string, unknown>)
          : null;
      if (data?.code === "duplicate_clip") {
        return jsonResponse(409, {
          error: "This page is already clipped",
          documentId: data.documentId,
          clippedAt: data.clippedAt,
        });
      }
      throw e;
    }

    return jsonResponse(200, { documentId });
  }),
});

// GET /clip/projects — the owner's projects for the popup's per-clip
// dropdown, authenticated by the same bearer token as POST /clip.
http.route({
  path: "/clip/projects",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const result = await ctx.runQuery(internal.clipperTokens.projectsFor, {
      token,
    });
    if (!result) {
      return jsonResponse(401, { error: "Invalid or missing clipper token" });
    }
    return jsonResponse(200, result);
  }),
});

// GET /clip/lookup?url=… — has this URL already been clipped into any of the
// owner's projects? Powers the popup's re-clip warning; same bearer token.
http.route({
  path: "/clip/lookup",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) {
      return jsonResponse(401, { error: "Invalid or missing clipper token" });
    }
    const url = new URL(req.url).searchParams.get("url") ?? "";
    if (!/^https?:\/\//.test(url)) {
      return jsonResponse(400, { error: "'url' must be an http(s) URL" });
    }
    const existing = await ctx.runQuery(internal.clips.lookupClipped, {
      token,
      url,
    });
    return jsonResponse(200, { existing });
  }),
});

// PATCH /clip/metadata — human corrections from the popup's post-clip
// preview. Fields absent from the body are untouched; empty strings clear.
http.route({
  path: "/clip/metadata",
  method: "PATCH",
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: "Body must be JSON" });
    }
    if (typeof body !== "object" || body === null) {
      return jsonResponse(400, { error: "Body must be a JSON object" });
    }
    const b = body as Record<string, unknown>;
    if (typeof b.documentId !== "string" || !b.documentId) {
      return jsonResponse(400, { error: "'documentId' is required" });
    }
    const field = (value: unknown): string | undefined =>
      typeof value === "string" ? value : undefined;
    try {
      await ctx.runMutation(internal.clips.updateClipMetadata, {
        token,
        documentId: b.documentId as Id<"documents">,
        title: field(b.title),
        author: field(b.author),
        publishedAt: field(b.publishedAt),
        siteName: field(b.siteName),
        description: field(b.description),
      });
    } catch (e) {
      if (e instanceof ConvexError) {
        const message =
          typeof e.data === "string" ? e.data : "Invalid request";
        const status = message.startsWith("Invalid clipper") ? 401 : 400;
        return jsonResponse(status, { error: message });
      }
      // An id from the wrong table fails the mutation's arg validator.
      return jsonResponse(400, { error: "Invalid document id" });
    }
    return jsonResponse(200, { ok: true });
  }),
});

// Preserve the extension's exact /clip endpoint and let every other GET path
// fall through to the hosted Vite app, including React Router deep links.
registerStaticRoutes(http, components.staticHosting);

export default http;
