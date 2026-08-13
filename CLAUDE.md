<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

## Interfaze usage rules (verified against interfaze.ai/docs, 2026-08-12)

- **Precontext entries are per-task-invocation, not per-page.** Docs: repeated tasks yield multiple entries with the same `name`. `ocrToPages` (`convex/interfaze.ts`) branching on `ocrs.length > 1` as "one entry per page" is unsound by spec and corrupts text + geometry today. Collapse duplicates; only use per-result when entry count == page count.
- **One task per call.** `task: "ocr"` cannot also return `object_detection`. A full completion *can* return both (precontext may mix task types). Objects + OCR = either one full call or two task calls.
- **`total_pages` is undocumented.** The sections-as-pages height division is inference; assert it, fail loudly, never emit empty pages.
- **Size ceilings:** URL-in-prompt 80MB; base64 / file object 20MB; 5-min request timeout; 1M context; 32k output tokens; 50 rps. Pass big files by URL. Our `maxTokens: 8192` is self-imposed, not the API cap.
- **Don't re-upload for text work.** Extract should go text-in, chunked (`LIMITS.maxInlineTextBytesPerFile` = 250,000).
- **Non-streaming only.** Streamed completions hardcode `vcache: false` and drop `usage`, which zeroes the cost ledger (`apiLogs`, `apiUsageTotals`, `providerHealth`).
