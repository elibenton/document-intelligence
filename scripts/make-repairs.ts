#!/usr/bin/env tsx
/**
 * Produce repaired copies of the variants, so the repair can be checked against
 * a real OCR call before it ships to users.
 *
 *   npx tsx scripts/make-repairs.ts
 *
 * This mirrors what `repairPdfTextLayer` does in the browser — pdf.js for text
 * and rasterization, then `buildTextUnderlayPdf` for assembly — but runs under
 * Node with @napi-rs/canvas so the bench can drive it. The assembly step is the
 * same shared function in both places; only the canvas differs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCanvas, Image } from "@napi-rs/canvas";
import { loadPdf } from "./lib/pdf";
import {
  buildTextUnderlayPdf,
  type UnderlayPage,
  type UnderlayTextItem,
} from "./lib/textUnderlay";

const OUT = "test-corpus/variants";
const TARGET_WIDTH = 1600;

async function repair(source: string): Promise<Uint8Array> {
  const { pdf } = await loadPdf(new Uint8Array(await readFile(source)));
  try {
    const canvasFactory = pdf.canvasFactory as {
      create: (w: number, h: number) => {
        canvas: { toBuffer: (mime: "image/png") => Buffer };
        context: CanvasRenderingContext2D;
      };
      destroy: (canvas: unknown) => void;
    };
    const pages: UnderlayPage[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(TARGET_WIDTH / viewport.width, 4);
      const scaled = page.getViewport({ scale });
      const pixelWidth = Math.ceil(scaled.width);
      const pixelHeight = Math.ceil(scaled.height);

      const cc = canvasFactory.create(pixelWidth, pixelHeight);
      cc.context.fillStyle = "#ffffff";
      cc.context.fillRect(0, 0, pixelWidth, pixelHeight);
      await page.render({
        canvas: cc.canvas as unknown as HTMLCanvasElement,
        viewport: scaled,
      }).promise;
      const png = cc.canvas.toBuffer("image/png");
      canvasFactory.destroy(cc);

      const image = new Image();
      image.src = png;
      const jpegCanvas = createCanvas(pixelWidth, pixelHeight);
      const context = jpegCanvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const jpeg = jpegCanvas.toBuffer("image/jpeg", 0.82);

      const content = await page.getTextContent();
      const items: UnderlayTextItem[] = content.items.flatMap((item) =>
        "str" in item && item.str.trim()
          ? [{ text: item.str, transform: item.transform as UnderlayTextItem["transform"] }]
          : []
      );
      page.cleanup();

      pages.push({
        jpeg: new Uint8Array(jpeg),
        width: viewport.width,
        height: viewport.height,
        pixelWidth,
        pixelHeight,
        items,
      });
    }

    return buildTextUnderlayPdf(pages);
  } finally {
    await pdf.destroy();
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        // The class the repair exists for: real text, invisible to the provider.
        "test-corpus/variants/content-hidden-ocr-layer.pdf",
        // A true image-only scan. The repair cannot invent text, so this one
        // must still come back empty — it is the negative control.
        "test-corpus/variants/enc-ccitt-g4.pdf",
      ];

  for (const source of targets) {
    const data = await repair(source);
    const dest = path.join(OUT, `repaired-${path.basename(source)}`);
    await writeFile(dest, data);
    console.log(`${dest}  ${(data.length / 1e6).toFixed(2)}MB`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
