import { v } from "convex/values";
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

const SELF_INTRO =
  /\b(?:i'?m|i am|my name is|this is|speaking with you[,]? )\s*$/i;

/**
 * Who each speaker probably is, derived — no API call — from evidence the
 * extraction pipeline already produced: person mentions are matched against
 * transcript blocks (`transcript_seg${i}`), so each name is known to occur
 * inside a specific speaker's turn.
 *
 * Two clues, both conservative:
 *  - self-introduction: the words right before the name, in the speaker's
 *    own turn, are an "I'm / my name is / this is" pattern → that speaker.
 *  - addressee: the name sits in the closing words of a turn immediately
 *    before the floor changes ("Thanks for joining, Maya") → the *next*
 *    speaker. Only trusted in two-speaker recordings — with three, the
 *    addressee is undecidable — and only when it recurs.
 *
 * Guardrails: one name per label, one label per name; a conflict keeps the
 * higher-signal candidate or emits nothing. The merged understanding call
 * can't do this job: it reads the raw file and never sees the diarizer's
 * labels, so any names it produced would need exactly this alignment step
 * anyway.
 */
export const suggestions = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    const segments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    if (segments.length === 0) return [];
    const speakerCount = new Set(segments.map((s) => s.speaker)).size;

    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();

    // candidate name -> per-label evidence
    const votes = new Map<
      string,
      Map<string, { score: number; evidence: string }>
    >();
    const vote = (
      name: string,
      label: string,
      score: number,
      evidence: string
    ) => {
      const byLabel = votes.get(name) ?? new Map();
      const prior = byLabel.get(label);
      byLabel.set(label, {
        score: (prior?.score ?? 0) + score,
        evidence: prior?.evidence ?? evidence,
      });
      votes.set(name, byLabel);
    };

    const entityNames = new Map<string, string>();
    for (const mention of mentions) {
      const match = /^transcript_seg(\d+)$/.exec(mention.blockId ?? "");
      if (!match) continue;
      const seg = segments[Number(match[1])];
      if (!seg) continue;
      let name = entityNames.get(mention.entityId);
      if (name === undefined) {
        const entity = await ctx.db.get(mention.entityId);
        // Only people can be speakers; diarizer placeholders never count.
        if (!entity || !(entity.types ?? [entity.type]).some((t) => t === "person" || t === "people"))
          continue;
        if (/^speaker[\s_-]?\d+$/i.test(entity.name)) continue;
        name = entity.name;
        entityNames.set(mention.entityId, name);
      }
      const text = seg.text;
      const at = text.toLowerCase().indexOf(name.toLowerCase());
      if (at < 0) continue;

      const before = text.slice(Math.max(0, at - 40), at);
      if (SELF_INTRO.test(before)) {
        const evidence = text
          .slice(Math.max(0, at - 40), at + name.length)
          .trim();
        vote(name, seg.speaker, 3, `“…${evidence}”`);
        continue;
      }

      // Addressee: name in the turn's closing stretch, floor changes next.
      const segIndex = Number(match[1]);
      const next = segments[segIndex + 1];
      const nearEnd = at + name.length >= text.length - 30;
      if (speakerCount === 2 && next && next.speaker !== seg.speaker && nearEnd) {
        const evidence = text.slice(Math.max(0, at - 30)).trim();
        vote(name, next.speaker, 1, `“…${evidence}”`);
      }
    }

    // Resolve: strongest label per name (needs a self-intro or a repeated
    // addressee), then one name per label.
    const byLabel = new Map<string, { name: string; score: number; evidence: string }>();
    for (const [name, labels] of votes) {
      let best: { label: string; score: number; evidence: string } | null = null;
      for (const [label, v] of labels) {
        if (!best || v.score > best.score) best = { label, ...v };
      }
      if (!best || best.score < 2) continue;
      const holder = byLabel.get(best.label);
      if (!holder || best.score > holder.score) {
        byLabel.set(best.label, {
          name,
          score: best.score,
          evidence: best.evidence,
        });
      }
    }
    return [...byLabel.entries()].map(([label, v]) => ({
      label,
      name: v.name,
      evidence: v.evidence,
    }));
  },
});

