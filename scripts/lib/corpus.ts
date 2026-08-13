/**
 * Read the *already-uploaded* corpus out of the running deployment.
 *
 * The scan bench works from local files in test-corpus/; the TOC bench has to
 * work from what is actually in the app, because the thing under test is a
 * pipeline stage whose input (stored OCR page text) only exists there. Files
 * are pulled through the same storage URL production hands Interfaze and cached
 * on disk, so a repeat run costs nothing and hits the provider's cache.
 *
 * Everything here shells out to the Convex CLI rather than opening a client:
 * no deployment URL to configure, no auth to thread, and it reads exactly what
 * `npx convex data` would show a human looking for the same thing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const CACHE_DIR = "test-corpus/uploaded";
// `npx convex data` streams whole rows; page text is the big field, so pull
// pages in one go and index them rather than making a call per document.
const MAX_ROWS = 5000;

export interface CorpusDocument {
  _id: string;
  name: string;
  displayName?: string;
  mimeType: string;
  mediaType?: string;
  projectId?: string;
  pageCount?: number;
  status: string;
  storageId: string;
  /** The TOC the current Analyze pass produced, if it has run. 1-based pages. */
  tableOfContents?: { title: string; level: number; page: number }[];
}

export interface CorpusPage {
  documentId: string;
  /** 0-indexed, as stored. */
  pageNumber: number;
  text: string;
}

async function convexData<T>(table: string, limit = MAX_ROWS): Promise<T[]> {
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "data", table, "--limit", String(limit), "--format", "jsonLines"],
    { maxBuffer: 512 * 1024 * 1024 }
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function loadDocuments(): Promise<CorpusDocument[]> {
  return await convexData<CorpusDocument>("documents");
}

/** Stored OCR page text, grouped by document and ordered by page. */
export async function loadPageTexts(): Promise<Map<string, string[]>> {
  const pages = await convexData<CorpusPage>("pages");
  const byDocument = new Map<string, CorpusPage[]>();
  for (const page of pages) {
    const list = byDocument.get(page.documentId) ?? [];
    list.push(page);
    byDocument.set(page.documentId, list);
  }
  const texts = new Map<string, string[]>();
  for (const [documentId, list] of byDocument) {
    list.sort((a, b) => a.pageNumber - b.pageNumber);
    texts.set(documentId, list.map((page) => page.text ?? ""));
  }
  return texts;
}

/**
 * The storage URL production would hand Interfaze. Stable for a given
 * storageId, which is what makes the provider's cache reachable on a re-run.
 */
export async function fileUrl(storageId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npx", [
      "convex",
      "run",
      "documents:getUrl",
      JSON.stringify({ storageId }),
    ]);
    const value = stdout.trim();
    if (!value || value === "null") return null;
    return JSON.parse(value) as string;
  } catch {
    // A document whose stored file has been deleted is a fact about the corpus,
    // not a reason to abandon the run.
    return null;
  }
}

/** Download once, then serve from disk. Returns null for a document whose file is gone. */
export async function localCopy(
  document: CorpusDocument
): Promise<{ path: string; bytes: Uint8Array } | null> {
  await mkdir(CACHE_DIR, { recursive: true });
  // Display names carry suffixes after the extension ("contract.pdf [bench]"),
  // and path.extname would hand back ".pdf [bench]" — a cache filename that the
  // .gitignore *.pdf glob does not match. Take a real extension or nothing.
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(document.name)?.[0] ?? ".bin";
  const cached = path.join(CACHE_DIR, `${document._id}${extension}`);
  if (existsSync(cached)) {
    return { path: cached, bytes: new Uint8Array(await readFile(cached)) };
  }
  const url = await fileUrl(document.storageId);
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(cached, bytes);
  return { path: cached, bytes };
}

/** Read a deployment env var, falling back to the Convex CLI. */
export async function deploymentEnv(name: string): Promise<string> {
  if (process.env[name]) return process.env[name]!;
  const { stdout } = await execFileAsync("npx", ["convex", "env", "get", name]);
  return stdout.trim();
}
