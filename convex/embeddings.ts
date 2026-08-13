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
 */

import { internalAction, internalMutation, internalQuery, action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { UsageLogger } from "./interfazeCost";
import { usageLogger } from "./apiLogs";
import { healthReporter } from "./providerHealth";
import type { HealthReporter, ProviderStatus } from "./providerHealth";

export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 1536;

// Gemini Embedding 2 accepts 8192 tokens, but tokens-per-minute quotas are
// finite and a page's leading text carries most of its retrieval signal —
// 8k chars (~2k tokens) per page keeps batches comfortably inside them.
const MAX_EMBED_CHARS = 8_000;
// Per-request embedding batch (batchEmbedContents itself allows up to 100).
const BATCH_SIZE = 8;
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

export type EmbedOptions = {
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
  options: EmbedOptions = {}
): Promise<number[][]> {
  const { log, health, retryOnRateLimit = true } = options;
  const startedAt = Date.now();
  const reportUsage = async (report: {
    status: "ok" | "error";
    promptTokens?: number;
    error?: string;
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
    });
  };

  const clipped = texts.map((t) =>
    t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t
  );
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
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const verdict = classifyFailure(res.status, await res.text());
    await reportUsage({ status: "error", error: verdict.message });
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

export const pagesNeedingEmbedding = internalQuery({
  args: {
    documentId: v.id("documents"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const out: Array<{ _id: Id<"pages">; text: string }> = [];
    for await (const page of ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))) {
      if (page.embedding) continue;
      const text = page.text;
      if (!text.trim()) continue;
      out.push({ _id: page._id, text });
      if (out.length >= args.limit) break;
    }
    return out;
  },
});

export const storePageEmbeddings = internalMutation({
  args: {
    entries: v.array(
      v.object({
        pageId: v.id("pages"),
        embedding: v.array(v.float64()),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const entry of args.entries) {
      await ctx.db.patch(entry.pageId, { embedding: entry.embedding });
    }
  },
});

/**
 * Embed every un-embedded page of a document (scheduled after
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
    // Documents are bounded in page count; loop batches until drained.
    for (;;) {
      const pages = await ctx.runQuery(
        internal.embeddings.pagesNeedingEmbedding,
        { documentId: args.documentId, limit: BATCH_SIZE }
      );
      if (pages.length === 0) break;
      const vectors = await embedTexts(pages.map((p) => p.text), apiKey, {
        log: usageLogger(ctx, { documentId: args.documentId }),
        health: healthReporter(ctx),
      });
      await ctx.runMutation(internal.embeddings.storePageEmbeddings, {
        entries: pages.map((p, i) => ({ pageId: p._id, embedding: vectors[i] })),
      });
      if (pages.length < BATCH_SIZE) break;
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
export const checkHealth = action({
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
