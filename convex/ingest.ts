import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  findByNameOrAlias,
  recountEntity,
  resolveEntity,
} from "./entityResolution";

// ---------------------------------------------------------------------------
// Ingest parse (convert) results
// ---------------------------------------------------------------------------

const bboxValidator = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});

type WordEntry = {
  text: string;
  bbox?: { x: number; y: number; width: number; height: number };
  confidence?: number;
};

function bboxFitsPage(
  bbox: WordEntry["bbox"],
  width: number | undefined,
  height: number | undefined
): boolean {
  if (!bbox || !width || !height) return Boolean(bbox);
  const toleranceX = Math.max(2, width * 0.01);
  const toleranceY = Math.max(2, height * 0.01);
  return (
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.width) &&
    Number.isFinite(bbox.height) &&
    bbox.width > 0 &&
    bbox.height > 0 &&
    bbox.x >= -toleranceX &&
    bbox.y >= -toleranceY &&
    bbox.x + bbox.width <= width + toleranceX &&
    bbox.y + bbox.height <= height + toleranceY
  );
}

function geometryForPage(
  bbox: WordEntry["bbox"],
  words: WordEntry[] | undefined,
  width: number | undefined,
  height: number | undefined
) {
  return {
    bbox: bboxFitsPage(bbox, width, height) ? bbox : undefined,
    words: words?.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      bbox: bboxFitsPage(word.bbox, width, height) ? word.bbox : undefined,
    })),
  };
}

const cleanToken = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Find the name as a consecutive run of OCR words inside a block; return the
 * union bounding box of the run (a tight box around just the name) and the
 * weakest word confidence in the run.
 */
export function matchWordRun(
  words: WordEntry[] | undefined,
  name: string
): { bbox?: WordEntry["bbox"]; confidence?: number } | null {
  if (!words || words.length === 0) return null;
  const nameTokens = name.split(/\s+/).map(cleanToken).filter(Boolean);
  if (nameTokens.length === 0) return null;
  const wordTokens = words.map((w) => cleanToken(w.text));

  for (let i = 0; i + nameTokens.length <= words.length; i++) {
    let matched = true;
    for (let j = 0; j < nameTokens.length; j++) {
      if (wordTokens[i + j] !== nameTokens[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const run = words.slice(i, i + nameTokens.length);
    const boxes = run
      .map((w) => w.bbox)
      .filter((b): b is NonNullable<WordEntry["bbox"]> => !!b);
    const confs = run
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number");

    let bbox: WordEntry["bbox"];
    if (boxes.length > 0) {
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      bbox = {
        x,
        y,
        width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
        height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
      };
    }
    return {
      bbox,
      confidence: confs.length > 0 ? Math.min(...confs) : undefined,
    };
  }
  return null;
}

const parsedBlockValidator = v.object({
  blockId: v.string(),
  blockType: v.string(),
  text: v.string(),
  html: v.optional(v.string()),
  pageNumber: v.number(),
  bbox: v.optional(bboxValidator),
  confidence: v.optional(v.number()),
  words: v.optional(
    v.array(
      v.object({
        text: v.string(),
        bbox: v.optional(bboxValidator),
        confidence: v.optional(v.number()),
      })
    )
  ),
});

const pageDimensionsValidator = v.array(
  v.object({
    page: v.number(),
    width: v.number(),
    height: v.number(),
  })
);

type ParsedBlock = typeof parsedBlockValidator.type;

/**
 * Reconcile `pageCount` pages (and their blocks) starting at global page
 * number `pageOffset`. Keeping the oldest page row as the canonical row makes
 * parse reruns idempotent without invalidating mentions that already point at
 * that page. Any duplicate rows left by older runs are folded into it.
 *
 * Page numbers in `blocks`/`pageDimensions` are local to this batch (0-based);
 * the offset shifts them — and the `p{n}_l{m}` block IDs — into document
 * coordinates, so chunked parses land on the right pages.
 */
async function reconcilePagesAndBlocks(
  ctx: MutationCtx,
  args: {
    documentId: Id<"documents">;
    pageText: string[];
    blocks: ParsedBlock[];
    pageDimensions?: { page: number; width: number; height: number }[];
    pageCount: number;
    pageOffset: number;
  }
) {
  // Build a page dimensions lookup (local page numbers)
  const dimsByPage = new Map<number, { width: number; height: number }>();
  for (const dim of args.pageDimensions ?? []) {
    dimsByPage.set(dim.page, { width: dim.width, height: dim.height });
  }

  const blocksByPage = new Map<number, ParsedBlock[]>();
  for (const block of args.blocks) {
    const pageBlocks = blocksByPage.get(block.pageNumber) ?? [];
    pageBlocks.push(block);
    blocksByPage.set(block.pageNumber, pageBlocks);
  }

  const entitiesToRecount = new Set<Id<"entities">>();

  for (let pageNum = 0; pageNum < args.pageCount; pageNum++) {
    const globalPage = args.pageOffset + pageNum;
    const text = args.pageText[pageNum] ?? "";
    const dims = dimsByPage.get(pageNum);
    const existingPages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", globalPage)
      )
      .collect();
    const canonicalPage = existingPages[0];

    // Native PDF text is page-aligned by construction. Rendering and
    // Interfaze analysis run concurrently, so an OCR completion may arrive
    // after native geometry was committed. Preserve the selected native
    // source instead of letting completion order decide which boxes win.
    const nativeGeometryIsPreferred =
      canonicalPage?.textSource === "pdf" &&
      canonicalPage.nativeTextVisibility !== "hidden" &&
      (canonicalPage.nativeGeometryScore ?? 1) >= 0.65;
    if (nativeGeometryIsPreferred) {
      for (const duplicatePage of existingPages.slice(1)) {
        await ctx.db.delete(duplicatePage._id);
      }
      continue;
    }

    const pageValue = {
      documentId: args.documentId,
      pageNumber: globalPage,
      text: text.trim(),
      textSource: "ocr" as const,
      nativeTextVisibility: canonicalPage?.nativeTextVisibility,
      nativeGeometryScore: canonicalPage?.nativeGeometryScore,
      geometryVersion: canonicalPage?.geometryVersion,
      viewerRotationAdjustment: canonicalPage?.viewerRotationAdjustment,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    };
    const pageId = canonicalPage
      ? canonicalPage._id
      : await ctx.db.insert("pages", pageValue);
    if (canonicalPage) {
      // Full replacement intentionally clears a stale embedding and dimensions
      // that are absent from the latest OCR result.
      await ctx.db.replace("pages", pageId, pageValue);
    }

    const pageBlocks = blocksByPage.get(pageNum) ?? [];
    const incomingBlocks = new Map(
      pageBlocks.map((block) => [
        block.blockId.replace(/^p\d+/, `p${globalPage}`),
        block,
      ])
    );

    // Mentions use stable block IDs rather than block-row IDs. Preserve those
    // that still exist, repoint them to the canonical page, and remove only
    // mentions whose source block disappeared in the latest OCR result.
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", globalPage)
      )
      .collect();
    for (const mention of mentions) {
      if (mention.blockId && !incomingBlocks.has(mention.blockId)) {
        entitiesToRecount.add(mention.entityId);
        await ctx.db.delete(mention._id);
      } else if (mention.pageId !== pageId) {
        await ctx.db.patch(mention._id, { pageId });
      }
    }

    const existingBlocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", globalPage)
      )
      .collect();
    const existingByBlockId = new Map<string, typeof existingBlocks>();
    for (const block of existingBlocks) {
      if (block.source === "pdf") continue;
      const matches = existingByBlockId.get(block.blockId) ?? [];
      matches.push(block);
      existingByBlockId.set(block.blockId, matches);
    }

    for (const [blockId, block] of incomingBlocks) {
      const candidates = existingByBlockId.get(blockId) ?? [];
      const canonicalBlock =
        candidates.find((candidate) => candidate.pageId === pageId) ??
        candidates[0];
      const geometry = geometryForPage(
        block.bbox,
        block.words,
        dims?.width,
        dims?.height
      );
      const blockValue = {
        documentId: args.documentId,
        pageId,
        pageNumber: globalPage,
        blockId,
        blockType: block.blockType,
        text: block.text,
        source: "ocr" as const,
        html: block.html,
        bbox: geometry.bbox,
        confidence: block.confidence,
        words: geometry.words,
      };
      if (canonicalBlock) {
        await ctx.db.replace("blocks", canonicalBlock._id, blockValue);
      } else {
        await ctx.db.insert("blocks", blockValue);
      }
      for (const duplicate of candidates) {
        if (duplicate._id !== canonicalBlock?._id) {
          await ctx.db.delete(duplicate._id);
        }
      }
      existingByBlockId.delete(blockId);
    }

    // Anything left was produced by an older OCR result and is no longer a
    // valid citation target.
    for (const obsoleteBlocks of existingByBlockId.values()) {
      for (const obsolete of obsoleteBlocks) {
        await ctx.db.delete(obsolete._id);
      }
    }

    for (const duplicatePage of existingPages.slice(1)) {
      await ctx.db.delete(duplicatePage._id);
    }
  }

  // A replacement file can have fewer pages. Remove the now-out-of-range
  // content so the database exactly mirrors the newest parse.
  const firstRemovedPage = args.pageOffset + args.pageCount;
  const stalePages = await ctx.db
    .query("pages")
    .withIndex("by_document", (q) =>
      q.eq("documentId", args.documentId).gte("pageNumber", firstRemovedPage)
    )
    .collect();
  const stalePageNumbers = new Set(stalePages.map((page) => page.pageNumber));
  for (const pageNumber of stalePageNumbers) {
    const staleMentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", pageNumber)
      )
      .collect();
    for (const mention of staleMentions) {
      entitiesToRecount.add(mention.entityId);
      await ctx.db.delete(mention._id);
    }

    const staleBlocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).eq("pageNumber", pageNumber)
      )
      .collect();
    for (const block of staleBlocks) await ctx.db.delete(block._id);
  }
  for (const page of stalePages) await ctx.db.delete(page._id);

  for (const entityId of entitiesToRecount) {
    await recountEntity(ctx, entityId);
  }
}

export const ingestParseResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    pageText: v.array(v.string()),
    blocks: v.array(parsedBlockValidator),
    pageDimensions: v.optional(pageDimensionsValidator),
    pageCount: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, { pageCount: args.pageCount });
    await reconcilePagesAndBlocks(ctx, { ...args, pageOffset: 0 });
  },
});

/** Remove provider boxes that cannot exist in their declared page space. */
export const sanitizeStoredGeometry = internalMutation({
  args: { documentId: v.id("documents") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    let changed = 0;
    for (const page of pages) {
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) =>
          q
            .eq("documentId", args.documentId)
            .eq("pageNumber", page.pageNumber)
        )
        .collect();
      for (const block of blocks) {
        const normalized = geometryForPage(
          block.bbox,
          block.words,
          page.width,
          page.height
        );
        const bboxChanged = Boolean(block.bbox) !== Boolean(normalized.bbox);
        const wordBoxesChanged = (block.words ?? []).some(
          (word, index) =>
            Boolean(word.bbox) !== Boolean(normalized.words?.[index]?.bbox)
        );
        if (!bboxChanged && !wordBoxesChanged) continue;
        await ctx.db.patch(block._id, normalized);
        changed++;
      }
    }
    return changed;
  },
});

// ---------------------------------------------------------------------------
// Ingest template extraction results: entities resolved against the existing
// graph (exact/alias auto-link, fuzzy → merge suggestions), contextual roles
// recorded per document. Additive: human-sourced roles are never touched.
// ---------------------------------------------------------------------------

export const ingestTemplateResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    roles: v.array(
      v.object({
        role: v.string(),
        question: v.string(),
        entityType: v.string(),
      })
    ),
    schemaUsed: v.string(),
    results: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("extractions", {
      documentId: args.documentId,
      schemaUsed: args.schemaUsed,
      results: args.results,
      extractedAt: Date.now(),
    });

    let results: Record<string, unknown>;
    try {
      results = JSON.parse(args.results);
    } catch {
      return;
    }

    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const pageIdByNumber = new Map<number, (typeof pages)[0]["_id"]>();
    for (const page of pages) pageIdByNumber.set(page.pageNumber, page._id);

    const slug = (s: string) =>
      s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

    const seenEntities = new Set<string>();
    for (const templateRole of args.roles) {
      const val = results[slug(templateRole.role)];
      if (!Array.isArray(val)) continue;

      for (const item of val) {
        if (typeof item !== "string" || !item.trim()) continue;
        const name = item.trim();

        const { entityId } = await resolveEntity(ctx, {
          name,
          stableType: templateRole.entityType,
          documentId: args.documentId,
        });

        // Record the contextual role (skip if already present, incl. human rows)
        const existingRoles = await ctx.db
          .query("entityRoles")
          .withIndex("by_entity_and_document", (q) =>
            q.eq("entityId", entityId).eq("documentId", args.documentId)
          )
          .collect();
        if (!existingRoles.some((r) => r.role === templateRole.role)) {
          await ctx.db.insert("entityRoles", {
            entityId,
            documentId: args.documentId,
            role: templateRole.role,
            confidence: 1.0,
            source: "ai",
          });
        }

        // Refresh this entity's mentions in this document (once per entity)
        if (!seenEntities.has(entityId)) {
          seenEntities.add(entityId);
          const oldMentions = await ctx.db
            .query("mentions")
            .withIndex("by_entity", (q) =>
              q.eq("entityId", entityId).eq("documentId", args.documentId)
            )
            .collect();
          for (const m of oldMentions) await ctx.db.delete(m._id);

          const nameLower = name.toLowerCase();
          for (const block of blocks) {
            if (!block.text.toLowerCase().includes(nameLower)) continue;
            const pageId = pageIdByNumber.get(block.pageNumber);
            if (!pageId) continue;
            // Word-level OCR detail gives a tight box around the name itself
            // and its real recognition confidence; fall back to the line.
            const wordMatch = matchWordRun(block.words, name);
            await ctx.db.insert("mentions", {
              entityId,
              documentId: args.documentId,
              pageId,
              pageNumber: block.pageNumber,
              text: block.text,
              confidence:
                wordMatch?.confidence ?? block.confidence ?? 1.0,
              blockId: block.blockId,
              bbox: wordMatch?.bbox ?? block.bbox,
            });
          }
          await recountEntity(ctx, entityId);
        }
      }
    }

    await ctx.db.patch(args.documentId, {
      status: "completed",
      completedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Ingest extract results + populate entities and mentions
// ---------------------------------------------------------------------------

export const ingestExtractResults = internalMutation({
  args: {
    documentId: v.id("documents"),
    schemaUsed: v.string(),
    results: v.string(),
    pageRange: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Store raw extraction
    await ctx.db.insert("extractions", {
      documentId: args.documentId,
      schemaUsed: args.schemaUsed,
      results: args.results,
      pageRange: args.pageRange,
      extractedAt: Date.now(),
    });

    // Parse extraction results into entity entries
    let schema: Record<string, unknown>;
    let results: Record<string, unknown>;
    try {
      schema = JSON.parse(args.schemaUsed);
      results = JSON.parse(args.results);
    } catch {
      // If parsing fails, still mark complete
      await ctx.db.patch(args.documentId, {
        status: "completed",
        completedAt: Date.now(),
      });
      return;
    }

    const properties = (schema as { properties?: Record<string, unknown> })
      .properties ?? {};
    const entries: { name: string; type: string }[] = [];

    for (const key of Object.keys(properties)) {
      const val = results[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.trim()) {
            entries.push({ name: item.trim(), type: key });
          }
        }
      }
    }

    if (entries.length > 0) {
      // Entity matching and creation are scoped to the document's project
      const doc = await ctx.db.get(args.documentId);
      const projectId = doc?.projectId;

      // Load blocks and pages for this document to create mentions
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
        .collect();

      const pages = await ctx.db
        .query("pages")
        .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
        .collect();

      // Build pageNumber → pageId lookup
      const pageIdByNumber = new Map<number, typeof pages[0]["_id"]>();
      for (const page of pages) {
        pageIdByNumber.set(page.pageNumber, page._id);
      }

      // Process each unique name once. Deduping by name (not "type:name") is
      // deliberate: lookup below is name-based, so two schema keys yielding
      // the same name resolve to one entity rather than two.
      const processed = new Set<string>();

      for (const entry of entries) {
        const nameLower = entry.name.toLowerCase();
        if (processed.has(nameLower)) continue;
        processed.add(nameLower);

        // Use the SAME lookup as the template path (entityResolution). The old
        // hand-rolled version filtered the search index by `.eq("type", ...)`
        // with the raw schema key ("places", "emails", ...), which can never
        // match the template path's vocabulary ("people", "organization") — so
        // the two extraction paths created duplicate, unlinked rows for the
        // same person, and only the template's row had aliases/merge handling.
        let entityId: Id<"entities">;
        const existing = await findByNameOrAlias(ctx, entry.name, projectId);

        if (existing) {
          entityId = existing._id;
          // Re-extraction: drop this document's previous mentions first
          const existingMentions = await ctx.db
            .query("mentions")
            .withIndex("by_entity", (q) =>
              q.eq("entityId", entityId).eq("documentId", args.documentId)
            )
            .collect();
          for (const m of existingMentions) await ctx.db.delete(m._id);
        } else {
          entityId = await ctx.db.insert("entities", {
            projectId,
            name: entry.name,
            // Preset/custom keys ("places", "dates", ...) are what the
            // homepage groups by, so this path keeps them as the legacy type.
            type: entry.type,
            mentionCount: 0,
            documentCount: 0,
            avgConfidence: 1.0,
            aliases: [],
            isCustom: entry.type !== "people",
          });
        }

        // Find blocks containing this entity (case-insensitive substring)
        const matchingBlocks = blocks.filter((b) =>
          b.text.toLowerCase().includes(nameLower)
        );

        for (const block of matchingBlocks) {
          const pageId = pageIdByNumber.get(block.pageNumber);
          if (!pageId) continue;

          await ctx.db.insert("mentions", {
            entityId,
            documentId: args.documentId,
            pageId,
            pageNumber: block.pageNumber,
            text: block.text,
            confidence: 1.0,
            blockId: block.blockId,
            bbox: block.bbox,
          });
        }

        // Derive counts from the mention rows instead of hand-summing them,
        // matching the template path.
        await recountEntity(ctx, entityId);
      }
    }

    // Mark document completed
    await ctx.db.patch(args.documentId, {
      status: "completed",
      completedAt: Date.now(),
    });
  },
});
