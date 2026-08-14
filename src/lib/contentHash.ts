/**
 * Hex SHA-256 of a file's bytes, used to recognize a file the project already
 * has before uploading it again.
 *
 * WebCrypto needs the whole file in memory at once, which is why this runs
 * against the same ceiling the upload preflights already enforce rather than
 * being applied to arbitrary input. `crypto.subtle` requires a secure context;
 * localhost and https both qualify, so the app never sees the undefined case,
 * and a thrown error here is treated as "unknown" by the caller rather than
 * blocking the upload.
 */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
