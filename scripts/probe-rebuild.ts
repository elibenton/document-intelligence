#!/usr/bin/env tsx
/**
 * Control for the "CCITT is not the cause" conclusion.
 *
 * That conclusion came from rasterizing the failing scan and rebuilding it as a
 * JPEG PDF with `pdfFromJpegPages` — which still returned empty OCR. But the
 * rebuild writer is our own hand-rolled PDF assembler and had never been
 * checked against Interfaze on its own. If a rebuild of a *known-good* document
 * also returns empty, the writer is the confound and the encoding hypothesis is
 * still live.
 *
 * Emits page 1 of each input, rebuilt, into test-corpus/variants/.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { rasterize } from "./lib/pdf";
import { pdfFromJpegPages } from "./lib/normalize";
import { createCanvas, Image } from "@napi-rs/canvas";

function toJpeg(png: Buffer, quality = 0.82): Buffer {
  const image = new Image();
  image.src = png;
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return canvas.toBuffer("image/jpeg", quality);
}

const OUT = "test-corpus/variants";

async function rebuildFirstPage(src: string, stem: string) {
  const data = new Uint8Array(await readFile(src));
  const [raster] = await rasterize(data, [0]);
  const pdf = pdfFromJpegPages([
    { jpeg: toJpeg(raster.png), width: raster.width, height: raster.height },
  ]);
  const dest = path.join(OUT, `${stem}.pdf`);
  await writeFile(dest, pdf);
  console.log(`${dest}  ${(pdf.length / 1e3).toFixed(0)}KB  ${raster.width}x${raster.height}`);
  return dest;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  // The failing scan — expected to stay empty if the trigger travels with it.
  await rebuildFirstPage(
    "test-corpus/Order-and-Decision_HDO3-Holdings_C11-0001341-LIC_6.10.2024.pdf",
    "control-rebuild-failing-p1"
  );
  // A document that OCRs fine today. If THIS rebuild is also empty, the
  // rebuild writer is the confound, not the source document.
  await rebuildFirstPage(
    "test-corpus/Matt smith 2022 contract.pdf",
    "control-rebuild-working-p1"
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
