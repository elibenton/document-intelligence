import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./authz";
import { requireDocument } from "./ownership";
import { transcriptSignature } from "./speakerSignature";
import { resolveEntity } from "./entityResolution";

/**
 * The speaker→name mapping for one recording. Human and ai rows both flow
 * through this one subscription, which is what makes suggestions
 * progressive: the dialog is open on library autocomplete immediately, and
 * suggestion chips appear reactively when Analyze lands.
 */
export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    return await ctx.db
      .query("documentSpeakers")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  },
});

/**
 * The user's answer to the naming dialog — assignments for any subset of
 * labels (partial naming is fine; unnamed labels keep rendering as
 * "Speaker N"), or a skip. Either way the transcript's signature is
 * written, so the dialog stops re-asking until the diarization changes.
 *
 * Each confirmed name also: upserts the user-wide library row (recency and
 * spelling variants feed the next recording's autocomplete), and resolves
 * to a project entity through the same resolver extraction uses — so when
 * the name was spoken in the transcript, the transcript and the entity
 * sidebar agree with zero re-runs.
 */
export const confirm = authedMutation({
  args: {
    documentId: v.id("documents"),
    assignments: v.array(v.object({ label: v.string(), name: v.string() })),
    skipped: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    const now = Date.now();

    for (const { label, name: rawName } of args.assignments) {
      const name = rawName.trim().replace(/\s+/g, " ");
      if (!name) continue;

      // Library upsert, keyed on the normalized form; a differently-spelled
      // confirm teaches the variant as an alias rather than a second row.
      const normalizedName = name.toLowerCase();
      const existing = await ctx.db
        .query("speakers")
        .withIndex("by_user_and_name", (q) =>
          q.eq("userId", ctx.user._id).eq("normalizedName", normalizedName)
        )
        .unique();
      let speakerId;
      if (existing) {
        await ctx.db.patch(existing._id, {
          useCount: existing.useCount + 1,
          lastUsedAt: now,
        });
        speakerId = existing._id;
      } else {
        speakerId = await ctx.db.insert("speakers", {
          userId: ctx.user._id,
          name,
          normalizedName,
          useCount: 1,
          lastUsedAt: now,
        });
      }

      // Entity link: the resolver dedupes by name/alias within the project
      // and queues fuzzy merge suggestions, exactly as extraction does.
      const { entityId } = await resolveEntity(ctx, {
        name,
        stableType: "person",
        documentId: args.documentId,
      });

      const row = await ctx.db
        .query("documentSpeakers")
        .withIndex("by_document", (q) =>
          q.eq("documentId", args.documentId).eq("label", label)
        )
        .unique();
      if (row) {
        await ctx.db.patch(row._id, {
          name,
          source: "human",
          evidence: undefined,
          speakerId,
          entityId,
          confirmedAt: now,
        });
      } else {
        await ctx.db.insert("documentSpeakers", {
          documentId: args.documentId,
          label,
          name,
          source: "human",
          speakerId,
          entityId,
          confirmedAt: now,
        });
      }
    }

    // Written on skip too — "asked and answered" covers "asked and waved
    // away". The signature is recomputed from the live segments rather than
    // trusted from the client.
    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    await ctx.db.patch(args.documentId, {
      speakerNamingSignature: transcriptSignature(segments),
    });
    return null;
  },
});

/**
 * AI-suggested names from textual clues, written by the pipeline (Analyze's
 * recording-gated `speakers` field). Never touches a human row — the same
 * human-wins rule every *Source field follows.
 */
export const saveSuggestions = internalMutation({
  args: {
    documentId: v.id("documents"),
    speakers: v.array(
      v.object({
        label: v.string(),
        name: v.string(),
        evidence: v.string(),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const suggestion of args.speakers) {
      const row = await ctx.db
        .query("documentSpeakers")
        .withIndex("by_document", (q) =>
          q.eq("documentId", args.documentId).eq("label", suggestion.label)
        )
        .unique();
      if (row?.source === "human") continue;
      if (row) {
        await ctx.db.patch(row._id, {
          name: suggestion.name,
          evidence: suggestion.evidence,
        });
      } else {
        await ctx.db.insert("documentSpeakers", {
          documentId: args.documentId,
          label: suggestion.label,
          name: suggestion.name,
          source: "ai",
          evidence: suggestion.evidence,
        });
      }
    }
    return null;
  },
});
