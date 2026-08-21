/**
 * Page embeddings for the semantic leg of hybrid search.
 *
 * Interfaze does not expose an embeddings API (its vector store is internal
 * to the model), so vectors come from Google's Gemini Embedding 2 (natively
 * multimodal, GA May 2026) at 1536 dims to match the pages.by_embedding
 * vector index. Non-default dimensionalities are auto-renormalized by the
 * API, so vectors are unit-length as Convex cosine search expects.
 *
 * Everything degrades gracefully: when GEMINI_API_KEY is unset, embedding
 * runs are skipped and search falls back to full-text + entity-graph legs.
 *
 * The unit is a `chunks` row, not a page. See convex/chunking.ts for why —
 * short version: a page was both too big (an hour of audio is one page, so one
 * vector) and silently truncated at 8k characters, which removed ~92% of a web
 * clip from the semantic leg without saying so.
 */

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { UsageLogger } from "./interfazeCost";
import { usageLogger } from "./apiLogs";
import { healthReporter } from "./providerHealth";
import type { HealthReporter, ProviderStatus } from "./providerHealth";
import { authedAction } from "./authz";
import { applySpeakerNames, embeddingText, type ChunkContext } from "./chunking";
import { rebuildForDocument } from "./chunks";
import { isRecordingDocument } from "./mediaTypes";

export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * The PROVIDER's ceiling, not a budget of ours.
 *
 * Gemini Embedding 2 accepts 8192 tokens; 30k characters sits under that in
 * any script. Chunks target 1,800 characters, so the only thing that can reach
 * this is a single transcript segment longer than it —
 * `chunkTranscriptSegments` never cuts a turn, because half a turn has no
 * anchor the player can seek to. Reaching it is logged rather than swallowed:
 * an unannounced clip is exactly the defect this file used to have.
 */
const PROVIDER_MAX_EMBED_CHARS = 30_000;
// Per-request embedding batch (batchEmbedContents itself allows up to 100).
// Chunks outnumber pages, so the 1s inter-batch pace costs proportionally more
// wall-clock than it did; 32 keeps headroom under the tokens-per-minute quota.
const BATCH_SIZE = 32;
// Paced BETWEEN API calls only, never while merely scanning.
const BATCH_PACING_MS = 1_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

export function embeddingsApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || undefined;
}

// Gemini Embedding 2 pricing (input-only)
const EMBEDDING_USD_PER_M_TOKENS = 0.2;

/**
 * Turn a failed Gemini response into a health verdict. The distinction that
 * matters to a human is "you ran out of credits" vs "your key is wrong" vs
 * "Google is unhappy" — each needs a different fix.
 */
function classifyFailure(
  httpStatus: number,
  body: string
): { status: ProviderStatus; message: string } {
  // Surface Google's own explanation when it sent one.
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Non-JSON error body — keep the raw prefix.
  }

  if (httpStatus === 429) {
    return {
      status: "quota_exhausted",
      message: `Gemini quota exhausted (HTTP 429). ${detail}`,
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: "auth_failed",
      message: `Gemini rejected the API key (HTTP ${httpStatus}). ${detail}`,
    };
  }
  return {
    status: "error",
    message: `Gemini embeddings failed (HTTP ${httpStatus}). ${detail}`,
  };
}

/**
 * Which side of the retrieval pair this text is.
 *
 * Required, deliberately, rather than defaulted: a query and the passage that
 * answers it are not the same kind of text, and a call site that forgets to
 * say which it has poisons the vector space silently — no error, just worse
 * results forever. The type checker is the only thing that can catch that.
 *
 * Changing this value changes every vector, so document and query must move
 * together and stored vectors must be regenerated.
 */
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export type EmbedOptions = {
  taskType: EmbeddingTaskType;
  /** Records token usage + cost into the API log. */
  log?: UsageLogger;
  /** Records provider reachability so the settings page can alarm on it. */
  health?: HealthReporter;
  /**
   * Retry 429s with backoff. Off for interactive health probes, which must
   * answer promptly rather than spend ~110s discovering the quota is gone.
   */
  retryOnRateLimit?: boolean;
};

/** Embed a batch of texts. Returns one vector per input, in order. */
export async function embedTexts(
  texts: string[],
  apiKey: string,
  options: EmbedOptions
): Promise<number[][]> {
  const { taskType, log, health, retryOnRateLimit = true } = options;
  const startedAt = Date.now();
  let retryCount = 0;
  const reportUsage = async (report: {
    status: "ok" | "error";
    promptTokens?: number;
    error?: string;
    errorCode?: string;
  }) => {
    if (!log) return;
    const promptTokens = report.promptTokens ?? 0;
    await log({
      provider: "google",
      operation: "embeddings",
      model: EMBEDDING_MODEL,
      status: report.status,
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
      costUsd: (promptTokens * EMBEDDING_USD_PER_M_TOKENS) / 1e6,
      durationMs: Date.now() - startedAt,
      error: report.error,
      errorCode: report.errorCode,
      buildSha: process.env.BUILD_SHA?.slice(0, 7),
      retryCount: retryCount || undefined,
    });
  };

  const clipped = texts.map((t) => {
    if (t.length <= PROVIDER_MAX_EMBED_CHARS) return t;
    console.warn(
      `Embedding input of ${t.length} chars exceeds the provider ceiling ` +
        `(${PROVIDER_MAX_EMBED_CHARS}) and was cut. Expected only for a single ` +
        `transcript segment longer than that; anything else means chunking broke.`
    );
    return t.slice(0, PROVIDER_MAX_EMBED_CHARS);
  });
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: clipped.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            // snake_case alongside camelCase `taskType` because that is what
            // this call has always sent and the v1beta endpoint accepts
            // either. Keep them as they are unless a probe says otherwise: a
            // field name the API does not recognize is IGNORED, not rejected,
            // so getting it wrong fails silently.
            taskType,
            output_dimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      }
    );
    // Rate limited (TPM/RPM): back off and retry a few times.
    if (
      res.status === 429 &&
      retryOnRateLimit &&
      attempt < RETRY_DELAYS_MS.length
    ) {
      retryCount++;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const verdict = classifyFailure(res.status, await res.text());
    await reportUsage({
      status: "error",
      error: verdict.message,
      errorCode: verdict.status,
    });
    await health?.({
      provider: "google",
      status: verdict.status,
      message: verdict.message,
    });
    throw new Error(verdict.message);
  }
  const data = (await res.json()) as {
    embeddings: Array<{ values: number[] }>;
    usageMetadata?: { promptTokenCount?: number };
  };
  // Prefer the API's reported token count; estimate ~4 chars/token otherwise.
  const promptTokens =
    data.usageMetadata?.promptTokenCount ??
    Math.round(clipped.reduce((sum, t) => sum + t.length, 0) / 4);
  await reportUsage({ status: "ok", promptTokens });
  await health?.({ provider: "google", status: "ok" });
  const vectors = (data.embeddings ?? []).map((e) => e.values);
  if (vectors.length !== texts.length) {
    throw new Error(
      `Gemini embeddings returned ${vectors.length} vectors for ${texts.length} inputs`
    );
  }
  return vectors;
}

/**
 * The next batch of chunks to embed, each already composed into the exact
 * string the provider will see.
 *
 * Composition happens HERE rather than in the action because it reads the
 * database: the document's own metadata, and the names a human has confirmed
 * for this recording's diarized labels. Nothing composed is stored, so a
 * corrected title or a newly named speaker improves every subsequent embed
 * with no schema change and no backfill — and the chunk row keeps the raw
 * passage a journalist reads in a search result.
 */
export const chunksNeedingEmbedding = internalQuery({
  args: {
    documentId: v.id("documents"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return [];

    const speakerNames = new Map<string, string>();
    if (isRecordingDocument(document)) {
      for (const row of await ctx.db
        .query("documentSpeakers")
        .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
        .collect()) {
        if (row.name.trim()) speakerNames.set(row.label, row.name);
      }
    }

    // documentDate is what the text establishes, createdDate what the source
    // claims; either dates the passage better than nothing, and the first is
    // the stronger statement where both exist.
    const context: ChunkContext = {
      title: document.displayName ?? document.name,
      kind: document.primaryKind,
      date: document.documentDate ?? document.createdDate,
      place: document.documentPlace,
      author: document.author,
    };

    const out: Array<{ _id: Id<"chunks">; embedInput: string }> = [];
    for await (const chunk of ctx.db
      .query("chunks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))) {
      if (chunk.embedding) continue;
      if (!chunk.text.trim()) continue;
      out.push({
        _id: chunk._id,
        embedInput: embeddingText(
          context,
          applySpeakerNames(chunk.text, speakerNames)
        ),
      });
      if (out.length >= args.limit) break;
    }
    return out;
  },
});

export const storeChunkEmbeddings = internalMutation({
  args: {
    entries: v.array(
      v.object({
        chunkId: v.id("chunks"),
        embedding: v.array(v.float64()),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const entry of args.entries) {
      // The chunk can be gone: a re-parse between this batch's query and its
      // write deletes and rewrites every chunk of the document.
      if ((await ctx.db.get(entry.chunkId)) === null) continue;
      await ctx.db.patch(entry.chunkId, { embedding: entry.embedding });
    }
  },
});

/**
 * Build this document's chunks if it has none.
 *
 * `ingestParseResults` is not the only path that commits pages. The native-PDF
 * fast path in `runPipeline` takes pages written earlier by
 * `nativeText.ingestNativePages` and schedules embedding directly, never
 * touching ingest.ts — so hooking only that one chokepoint left those
 * documents with pages, no chunks, and silently no semantic search.
 *
 * It lives here rather than in chunks.ts because this is the precondition of
 * the embedding path specifically: every caller that wants embeddings already
 * schedules `embedDocument`, so that stays the whole contract. A no-op on the
 * ordinary path, where ingest has already built them.
 */
export const ensureChunksBuilt = internalMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chunks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .first();
    if (existing) return null;
    await rebuildForDocument(ctx, args.documentId);
    return null;
  },
});

/**
 * Embed every un-embedded chunk of a document (scheduled after
 * parse/transcribe). No-op without an API key.
 */
export const embedDocument = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const apiKey = embeddingsApiKey();
    if (!apiKey) {
      await healthReporter(ctx)({
        provider: "google",
        status: "not_configured",
        message: "GEMINI_API_KEY is not set on this Convex deployment.",
      });
      return;
    }
    // Every path that wants embeddings schedules this action, so this is where
    // "the chunks exist" is guaranteed — the native-PDF fast path commits its
    // pages through nativeText and never passes ingestParseResults. A no-op
    // on the ordinary path, where ingest already built them.
    await ctx.runMutation(internal.embeddings.ensureChunksBuilt, {
      documentId: args.documentId,
    });
    // Documents are bounded in chunk count; loop batches until drained.
    for (;;) {
      const chunks = await ctx.runQuery(
        internal.embeddings.chunksNeedingEmbedding,
        { documentId: args.documentId, limit: BATCH_SIZE }
      );
      if (chunks.length === 0) break;
      const vectors = await embedTexts(
        chunks.map((c) => c.embedInput),
        apiKey,
        {
          taskType: "RETRIEVAL_DOCUMENT",
          log: usageLogger(ctx, { documentId: args.documentId }),
          health: healthReporter(ctx),
        }
      );
      await ctx.runMutation(internal.embeddings.storeChunkEmbeddings, {
        entries: chunks.map((c, i) => ({
          chunkId: c._id,
          embedding: vectors[i],
        })),
      });
      if (chunks.length < BATCH_SIZE) break;
      await new Promise((r) => setTimeout(r, BATCH_PACING_MS));
    }
  },
});

/**
 * Probe Gemini with a trivial embedding call and record the verdict.
 *
 * This is what the settings page's "Check now" button runs: it answers
 * "are we out of credits *right now*?" without waiting for the next upload
 * to find out. Rate-limit retries are off so the answer comes back in
 * seconds rather than ~110s of backoff.
 */
export const checkHealth = authedAction({
  args: {},
  handler: async (ctx): Promise<{ status: ProviderStatus; message?: string }> => {
    const health = healthReporter(ctx);
    const apiKey = embeddingsApiKey();

    if (!apiKey) {
      const message = "GEMINI_API_KEY is not set on this Convex deployment.";
      await health({ provider: "google", status: "not_configured", message });
      return { status: "not_configured", message };
    }

    try {
      // No usage log — a 2-token probe would only clutter the API log.
      await embedTexts(["health check"], apiKey, {
        // Probe shape follows the interactive path it is standing in for.
        taskType: "RETRIEVAL_QUERY",
        health,
        retryOnRateLimit: false,
      });
      return { status: "ok" };
    } catch (e) {
      // embedTexts already reported the classified status; surface the text.
      return {
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },
});
