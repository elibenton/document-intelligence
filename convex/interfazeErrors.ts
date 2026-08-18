/**
 * Failure codes and the classified-failure type.
 *
 * Split from the SDK client so the vocabulary the UI renders states for can be
 * imported without pulling in the `interfaze` SDK. Mapping a caught SDK error
 * onto one of these lives in convex/interfaze.ts (`classifyError`), which is
 * where the SDK's typed error classes are in scope.
 */

// ---------------------------------------------------------------------------
// Failure classification
//
// Provider failures are not interchangeable: running out of credits is an
// account-level condition that blocks every document until a human tops up,
// while a timeout is per-document and worth retrying. The SDK throws typed
// error classes; map them onto a small code the UI renders a specific state
// for.
// ---------------------------------------------------------------------------

export type FailureCode =
  | "insufficient_credits"
  | "invalid_api_key"
  | "rate_limited"
  | "timeout"
  /** Provider billed for OCR output and returned an empty string. */
  | "empty_ocr_response"
  /** Speech-to-text response was not the `{ result }` envelope it must be. */
  | "malformed_transcript"
  /** Provider billed for transcription and returned no speech at all. */
  | "empty_transcript";

/** A classified failure: our code + a message written in the user's terms. */
export class InterfazeFailure extends Error {
  readonly code?: FailureCode;
  readonly status?: number;

  constructor(
    message: string,
    options?: { code?: FailureCode; status?: number }
  ) {
    super(message);
    this.name = "InterfazeFailure";
    this.code = options?.code;
    this.status = options?.status;
  }
}

/** Read the failure code off an unknown caught value. */
export function failureCodeOf(e: unknown): FailureCode | undefined {
  return e instanceof InterfazeFailure ? e.code : undefined;
}
