import type { Id } from "../../convex/_generated/dataModel";

/**
 * Run a batch of uploads a few at a time. A folder drop can be hundreds of
 * files; firing them all at once buries the browser's connection pool and the
 * per-file progress stops meaning anything.
 */
export async function uploadWithConcurrency(
  files: File[],
  upload: (file: File) => Promise<Id<"documents"> | undefined>
) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(4, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++];
        await upload(file);
      }
    }
  );
  await Promise.all(workers);
}
