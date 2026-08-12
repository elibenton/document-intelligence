/**
 * Context-aware search.
 *
 * Two tiers:
 *
 *  1. `suggest` — reactive typeahead over entities, document names, and page
 *     full-text. Cheap, runs on every keystroke.
 *
 *  2. Deep search — `start` inserts a `searches` row and schedules `execute`,
 *     which streams progress through the row (planning → searching →
 *     synthesizing → completed):
 *       plan       Interfaze turns the question into a structured plan
 *                  (keywords, semantic query, entity names / roles /
 *                  relation types picked from what actually exists in the DB)
 *       retrieve   three legs in parallel — full-text (BM25), vector
 *                  (Gemini embeddings, skipped when no key), entity graph
 *                  (mentions + relationships) — fused with reciprocal rank
 *                  fusion
 *       synthesize Interfaze answers from the retrieved sources with [n]
 *                  citations that deep-link into the document viewer.
 */

import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A short window of page text around the first hit of any query token. */
function makeSnippet(text: string, queryText: string, radius = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  const tokens = queryText
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length > 2);
  let pos = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return clean.slice(0, radius * 2) + (clean.length > radius * 2 ? "…" : "");
  const start = Math.max(0, pos - radius);
  const end = Math.min(clean.length, pos + radius);
  return (
    (start > 0 ? "…" : "") + clean.slice(start, end) + (end < clean.length ? "…" : "")
  );
}


export type PageHit = {
  documentId: Id<"documents">;
  pageNumber: number;
  snippet: string;
};

async function defaultLanguageCode(ctx: QueryCtx): Promise<string> {
  const settings = await ctx.db
    .query("appSettings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  return settings?.defaultLanguageCode ?? "en";
}


// ---------------------------------------------------------------------------
// Tier 1: reactive typeahead suggestions
// ---------------------------------------------------------------------------

export const suggest = query({
  args: { q: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const q = args.q.trim();
    if (q.length < 2) {
      return { entities: [], documents: [], pages: [] };
    }

    const entities = await ctx.db
      .query("entities")
      .withSearchIndex("search_name", (s) =>
        s.search("name", q).eq("projectId", args.projectId)
      )
      .take(5);

    const documents = await ctx.db
      .query("documents")
      .withSearchIndex("search_name", (s) =>
        s.search("name", q).eq("projectId", args.projectId)
      )
      .take(4);

    const targetLanguageCode = await defaultLanguageCode(ctx);
    const translatedPageHits = await ctx.db
      .query("pageTranslations")
      .withSearchIndex("search_text", (s) =>
        s
          .search("text", q)
          .eq("targetLanguageCode", targetLanguageCode)
          .eq("status", "complete")
      )
      .take(15);

    // Pages carry no projectId — over-fetch and keep only this project's docs
    const pageHits = await ctx.db
      .query("pages")
      .withSearchIndex("search_text", (s) => s.search("text", q))
      .take(15);

    const docNames = new Map<Id<"documents">, string>();
    for (const doc of documents) docNames.set(doc._id, doc.name);
    const inProject = new Map<Id<"documents">, boolean>();
    const pages = [];
    const mergedPageHits = [
      ...translatedPageHits.map((translation) => ({
        _id: translation.pageId,
        documentId: translation.documentId,
        pageNumber: translation.pageNumber,
        text: translation.text,
      })),
      ...pageHits,
    ];
    const seenPages = new Set<string>();
    for (const page of mergedPageHits) {
      if (pages.length >= 5) break;
      const key = `${page.documentId}:${page.pageNumber}`;
      if (seenPages.has(key)) continue;
      let name = docNames.get(page.documentId);
      if (name === undefined || !inProject.has(page.documentId)) {
        const doc = await ctx.db.get(page.documentId);
        inProject.set(page.documentId, doc?.projectId === args.projectId);
        name = doc?.name ?? "Unknown document";
        docNames.set(page.documentId, name);
      }
      if (!inProject.get(page.documentId)) continue;
      seenPages.add(key);
      pages.push({
        pageId: page._id,
        documentId: page.documentId,
        documentName: name,
        pageNumber: page.pageNumber,
        snippet: makeSnippet(page.text, q),
      });
    }

    return {
      entities: entities.map((e) => ({
        entityId: e._id,
        name: e.name,
        type: e.type,
        mentionCount: e.mentionCount,
      })),
      documents: documents.map((d) => ({
        documentId: d._id,
        name: d.name,
        mediaType: d.mediaType,
        mimeType: d.mimeType,
      })),
      pages,
    };
  },
});


// ---------------------------------------------------------------------------
// Tier 2: deep search lifecycle
// ---------------------------------------------------------------------------

// Keep this many past searches loadable from history; older rows are pruned.
const MAX_SAVED_SEARCHES = 50;


export const start = mutation({
  args: {
    query: v.string(),
    projectId: v.id("projects"),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const q = args.query.trim();
    if (!q) throw new Error("Empty search query");

    // History cache: an identical completed search in the same project is
    // returned as-is — no new Interfaze / embedding calls. `force` re-runs.
    if (!args.force) {
      const recentRows = await ctx.db
        .query("searches")
        .withIndex("by_project", (s) => s.eq("projectId", args.projectId))
        .order("desc")
        .take(MAX_SAVED_SEARCHES);
      const cached = recentRows.find(
        (r) => r.status === "completed" && r.query === q
      );
      if (cached) return cached._id;
    }

    const searchId = await ctx.db.insert("searches", {
      projectId: args.projectId,
      query: q,
      status: "planning",
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.searchNode.execute, {
      searchId,
      query: q,
      projectId: args.projectId,
    });

    // Prune this project's history beyond the cap (oldest first).
    const excess = await ctx.db
      .query("searches")
      .withIndex("by_project", (s) => s.eq("projectId", args.projectId))
      .order("asc")
      .take(1000);
    for (const row of excess.slice(0, Math.max(0, excess.length - MAX_SAVED_SEARCHES))) {
      await ctx.db.delete(row._id);
    }

    return searchId;
  },
});


export const get = query({
  args: { id: v.id("searches") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});


export const recent = query({
  args: { projectId: v.id("projects") },
  returns: v.array(
    v.object({
      _id: v.id("searches"),
      query: v.string(),
      status: v.string(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("searches")
      .withIndex("by_project", (s) => s.eq("projectId", args.projectId))
      .order("desc")
      .take(MAX_SAVED_SEARCHES);
    return rows.map((r) => ({
      _id: r._id,
      query: r.query,
      status: r.status,
      createdAt: r.createdAt,
    }));
  },
});


export const update = internalMutation({
  args: {
    searchId: v.id("searches"),
    status: v.optional(v.string()),
    plan: v.optional(v.string()),
    results: v.optional(
      v.array(
        v.object({
          documentId: v.id("documents"),
          documentName: v.string(),
          pageNumber: v.number(),
          snippet: v.string(),
          score: v.number(),
          sources: v.array(v.string()),
        })
      )
    ),
    matchedEntities: v.optional(
      v.array(
        v.object({
          entityId: v.id("entities"),
          name: v.string(),
          type: v.string(),
        })
      )
    ),
    answer: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { searchId, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(fields)) {
      if (val !== undefined) patch[k] = val;
    }
    await ctx.db.patch(searchId, patch);
  },
});


// ---------------------------------------------------------------------------
// Planning context: what actually exists in this corpus, so the planner
// grounds its entity/role/relation choices instead of hallucinating them.
// ---------------------------------------------------------------------------

const PLANNER_VOCAB_CAP = 60;


export const plannerContext = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_project", (s) => s.eq("projectId", args.projectId))
      .take(150);

    // Roles and relationships carry no projectId, so they're read per entity
    // through their indexes. An earlier version took the first 300 rows of
    // each table unindexed and filtered afterwards — past 300 rows total the
    // planner silently saw some other project's vocabulary (or none), and it
    // is instructed to only choose from these lists.
    const roles = new Set<string>();
    const relationTypes = new Set<string>();
    for (const entity of entities) {
      if (roles.size >= PLANNER_VOCAB_CAP && relationTypes.size >= PLANNER_VOCAB_CAP) {
        break;
      }
      if (roles.size < PLANNER_VOCAB_CAP) {
        const roleRows = await ctx.db
          .query("entityRoles")
          .withIndex("by_entity", (s) => s.eq("entityId", entity._id))
          .take(10);
        for (const r of roleRows) roles.add(r.role);
      }
      if (relationTypes.size < PLANNER_VOCAB_CAP) {
        const relRows = await ctx.db
          .query("relationships")
          .withIndex("by_source", (s) => s.eq("sourceEntityId", entity._id))
          .take(10);
        for (const r of relRows) relationTypes.add(r.relationType);
      }
    }

    const kinds = await ctx.db.query("documentKinds").take(50);
    return {
      entityNames: entities.map((e) => `${e.name} (${e.type})`),
      roles: [...roles].slice(0, PLANNER_VOCAB_CAP),
      relationTypes: [...relationTypes].slice(0, PLANNER_VOCAB_CAP),
      kinds: kinds.map((k) => k.name),
    };
  },
});


// ---------------------------------------------------------------------------
// Retrieval legs
// ---------------------------------------------------------------------------

/** Cached "does this document belong to the project" check. */
async function docInProject(
  ctx: { db: { get: (id: Id<"documents">) => Promise<Doc<"documents"> | null> } },
  cache: Map<Id<"documents">, boolean>,
  documentId: Id<"documents">,
  projectId: Id<"projects">
): Promise<boolean> {
  let ok = cache.get(documentId);
  if (ok === undefined) {
    const doc = await ctx.db.get(documentId);
    ok = doc?.projectId === projectId;
    cache.set(documentId, ok);
  }
  return ok;
}


export const textLeg = internalQuery({
  args: {
    keywords: v.string(),
    queryText: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args): Promise<PageHit[]> => {
    if (!args.keywords.trim()) return [];
    const targetLanguageCode = await defaultLanguageCode(ctx);
    const translatedHits = await ctx.db
      .query("pageTranslations")
      .withSearchIndex("search_text", (s) =>
        s
          .search("text", args.keywords)
          .eq("targetLanguageCode", targetLanguageCode)
          .eq("status", "complete")
      )
      .take(48);
    // Pages carry no projectId — over-fetch, then keep this project's docs
    const hits = await ctx.db
      .query("pages")
      .withSearchIndex("search_text", (s) =>
        s.search("text", args.keywords)
      )
      .take(48);
    const cache = new Map<Id<"documents">, boolean>();
    const out: PageHit[] = [];
    const seen = new Set<string>();
    for (const p of translatedHits) {
      if (out.length >= 16) break;
      if (!(await docInProject(ctx, cache, p.documentId, args.projectId)))
        continue;
      const key = `${p.documentId}:${p.pageNumber}`;
      seen.add(key);
      out.push({
        documentId: p.documentId,
        pageNumber: p.pageNumber,
        snippet: makeSnippet(p.text, args.queryText || args.keywords),
      });
    }
    for (const p of hits) {
      if (out.length >= 16) break;
      if (!(await docInProject(ctx, cache, p.documentId, args.projectId)))
        continue;
      const key = `${p.documentId}:${p.pageNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        documentId: p.documentId,
        pageNumber: p.pageNumber,
        snippet: makeSnippet(
          p.text,
          args.queryText || args.keywords
        ),
      });
    }
    return out;
  },
});


export const hydratePageHits = internalQuery({
  args: {
    pageIds: v.array(v.id("pages")),
    queryText: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args): Promise<PageHit[]> => {
    const out: PageHit[] = [];
    const cache = new Map<Id<"documents">, boolean>();
    for (const pageId of args.pageIds.slice(0, 32)) {
      const page = await ctx.db.get(pageId);
      if (!page) continue;
      if (!(await docInProject(ctx, cache, page.documentId, args.projectId)))
        continue;
      out.push({
        documentId: page.documentId,
        pageNumber: page.pageNumber,
        snippet: makeSnippet(page.text, args.queryText),
      });
    }
    return out;
  },
});


export const entityLeg = internalQuery({
  args: {
    entityNames: v.array(v.string()),
    roles: v.array(v.string()),
    relationTypes: v.array(v.string()),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    // Resolve planned names against real entities via the name search index.
    const matched: Doc<"entities">[] = [];
    const seen = new Set<string>();
    for (const rawName of args.entityNames.slice(0, 6)) {
      const name = rawName.replace(/\s*\((person|organization|place|other)\)\s*$/i, "").trim();
      if (!name) continue;
      const candidates = await ctx.db
        .query("entities")
        .withSearchIndex("search_name", (s) =>
          s.search("name", name).eq("projectId", args.projectId)
        )
        .take(3);
      const exact = candidates.find(
        (c) =>
          c.name.toLowerCase() === name.toLowerCase() ||
          c.aliases.some((a) => a.toLowerCase() === name.toLowerCase())
      );
      const pick = exact ?? candidates[0];
      if (pick && !seen.has(pick._id)) {
        seen.add(pick._id);
        matched.push(pick);
      }
    }

    const hits: PageHit[] = [];
    const facts: string[] = [];
    const docNames = new Map<Id<"documents">, string>();
    const docName = async (id: Id<"documents">) => {
      let name = docNames.get(id);
      if (name === undefined) {
        name = (await ctx.db.get(id))?.name ?? "Unknown document";
        docNames.set(id, name);
      }
      return name;
    };

    for (const entity of matched) {
      // Where this entity appears (mention pages, best-confidence first)
      const mentions = await ctx.db
        .query("mentions")
        .withIndex("by_entity", (s) => s.eq("entityId", entity._id))
        .take(20);
      const roleRows = await ctx.db
        .query("entityRoles")
        .withIndex("by_entity", (s) => s.eq("entityId", entity._id))
        .take(20);
      const roleByDoc = new Map<Id<"documents">, string[]>();
      for (const r of roleRows) {
        // Role filter: when the plan names roles, keep only matching docs
        if (
          args.roles.length > 0 &&
          !args.roles.some((pr) => pr.toLowerCase() === r.role.toLowerCase())
        )
          continue;
        const list = roleByDoc.get(r.documentId) ?? [];
        list.push(r.role);
        roleByDoc.set(r.documentId, list);
      }

      const seenPages = new Set<string>();
      for (const m of mentions) {
        // When roles were planned, restrict this entity's hits to documents
        // where it plays one of those roles.
        if (args.roles.length > 0 && !roleByDoc.has(m.documentId)) continue;
        const key = `${m.documentId}:${m.pageNumber}`;
        if (seenPages.has(key)) continue;
        seenPages.add(key);
        hits.push({
          documentId: m.documentId,
          pageNumber: m.pageNumber,
          snippet: m.text.slice(0, 200),
        });
        if (hits.length >= 24) break;
      }

      for (const [documentId, roles] of roleByDoc) {
        facts.push(
          `${entity.name} is ${roles.join(", ")} in "${await docName(documentId)}"`
        );
      }

      // Relationships in both directions, filtered by planned relation types
      const outgoing = await ctx.db
        .query("relationships")
        .withIndex("by_source", (s) => s.eq("sourceEntityId", entity._id))
        .take(25);
      const incoming = await ctx.db
        .query("relationships")
        .withIndex("by_target", (s) => s.eq("targetEntityId", entity._id))
        .take(25);
      for (const rel of [...outgoing, ...incoming]) {
        if (
          args.relationTypes.length > 0 &&
          !args.relationTypes.some(
            (t) => t.toLowerCase() === rel.relationType.toLowerCase()
          )
        )
          continue;
        const source = await ctx.db.get(rel.sourceEntityId);
        const target = await ctx.db.get(rel.targetEntityId);
        if (!source || !target) continue;
        let fact = `${source.name} —${rel.relationType}→ ${target.name}`;
        if (rel.eventDate) fact += ` (${rel.eventDate})`;
        if (rel.documentId) {
          fact += ` [source: "${await docName(rel.documentId)}"${
            rel.pageNumber !== undefined ? ` p.${rel.pageNumber + 1}` : ""
          }]`;
          if (rel.pageNumber !== undefined) {
            const key = `${rel.documentId}:${rel.pageNumber}`;
            if (!hits.some((h) => `${h.documentId}:${h.pageNumber}` === key)) {
              hits.push({
                documentId: rel.documentId,
                pageNumber: rel.pageNumber,
                snippet: rel.quote?.slice(0, 200) ?? fact,
              });
            }
          }
        }
        if (rel.quote) fact += ` — "${rel.quote.slice(0, 200)}"`;
        facts.push(fact);
        if (facts.length >= 40) break;
      }
    }

    return {
      matchedEntities: matched.map((e) => ({
        entityId: e._id,
        name: e.name,
        type: e.type,
      })),
      hits: hits.slice(0, 24),
      facts: facts.slice(0, 40),
    };
  },
});


/** Document names + page texts for the fused result set / synthesis. */
export const hydrateForSynthesis = internalQuery({
  args: {
    keys: v.array(
      v.object({ documentId: v.id("documents"), pageNumber: v.number() })
    ),
  },
  handler: async (ctx, args) => {
    const targetLanguageCode = await defaultLanguageCode(ctx);
    const out: Array<{
      documentId: Id<"documents">;
      documentName: string;
      pageNumber: number;
      text: string;
    }> = [];
    const docNames = new Map<Id<"documents">, string>();
    for (const key of args.keys.slice(0, 16)) {
      let name = docNames.get(key.documentId);
      if (name === undefined) {
        name = (await ctx.db.get(key.documentId))?.name ?? "Unknown document";
        docNames.set(key.documentId, name);
      }
      const page = await ctx.db
        .query("pages")
        .withIndex("by_document", (s) =>
          s.eq("documentId", key.documentId).eq("pageNumber", key.pageNumber)
        )
        .unique();
      const translated = page
        ? await ctx.db
            .query("pageTranslations")
            .withIndex("by_page_and_target", (s) =>
              s.eq("pageId", page._id).eq("targetLanguageCode", targetLanguageCode)
            )
            .unique()
        : null;
      out.push({
        documentId: key.documentId,
        documentName: name,
        pageNumber: key.pageNumber,
        text: (
          translated?.status === "complete" ? translated.text : page?.text ?? ""
        ).slice(0, 2500),
      });
    }
    return out;
  },
});
