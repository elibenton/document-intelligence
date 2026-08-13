#!/usr/bin/env tsx
/**
 * Re-upload existing documents as fresh ones, so they run through the current
 * pipeline from scratch.
 *
 *   npx tsx scripts/reupload.ts --doc=<id>,<id> [--project=<id>] [--suffix=" (rerun)"]
 *
 * A row in `documents` records whatever pipeline was live when it was
 * ingested — a bench comparing today's stages against it is partly measuring
 * history. This takes the same bytes through generateUploadUrl →
 * createDocument, which is exactly what the browser does, and returns the new
 * document ids.
 *
 * The new file gets a new storageId and therefore a new URL, so nothing is
 * served from Interfaze's cache: this costs a full fresh parse per document.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadDocuments, localCopy } from "./lib/corpus";

const execFileAsync = promisify(execFile);

async function convexRun(fn: string, args: unknown): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "run", fn, JSON.stringify(args)],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (key: string) =>
    argv.find((a) => a.startsWith(`--${key}=`))?.split("=").slice(1).join("=");

  const ids = (get("doc") ?? "").split(",").filter(Boolean);
  if (ids.length === 0) {
    console.error("usage: reupload.ts --doc=<documentId>[,<documentId>...]");
    process.exit(1);
  }
  const suffix = get("suffix") ?? "";
  const projectOverride = get("project");

  const documents = await loadDocuments();
  for (const id of ids) {
    const source = documents.find((doc) => doc._id === id);
    if (!source) {
      console.log(`${id}  ✗ not found`);
      continue;
    }
    const copy = await localCopy(source);
    if (!copy) {
      console.log(`${source.name}  ✗ file missing from storage`);
      continue;
    }

    const uploadUrl = (await convexRun("upload:generateUploadUrl", {})) as string;
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": source.mimeType },
      body: new Blob([copy.bytes as unknown as ArrayBufferView], {
        type: source.mimeType,
      }),
    });
    if (!response.ok) {
      console.log(`${source.name}  ✗ upload failed (${response.status})`);
      continue;
    }
    const { storageId } = (await response.json()) as { storageId: string };

    const documentId = await convexRun("upload:createDocument", {
      projectId: projectOverride ?? source.projectId,
      name: `${source.name}${suffix}`,
      storageId,
      mimeType: source.mimeType,
    });

    console.log(
      `${source.name.slice(0, 44).padEnd(46)} → ${documentId}  ` +
        `(${(copy.bytes.byteLength / 1e6).toFixed(1)}MB)`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
