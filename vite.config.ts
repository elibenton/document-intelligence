import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "path";
import { createRequire } from "node:module";

/**
 * Serve pdf.js's sibling asset directories at a stable `/pdfjs/` URL.
 *
 * pdf.js ships its image decoders (OpenJPEG for JPEG 2000, qcms for colour
 * management), CMaps, ICC profiles and standard fonts as loose files it fetches
 * at runtime from directory URLs handed to `getDocument`. Without them a scanned
 * PDF whose pages are JPEG 2000 — every page of a Kit Kat Club ABC application,
 * for one — decodes to nothing and paints a blank white page, with the failure
 * arriving only as a console warning.
 *
 * They cannot be `import ... ?url`ed: the URLs are directories, and pdf.js
 * appends its own filenames to them, so Vite's content hashing would break the
 * names it expects. Copying the directories verbatim keeps them addressable, and
 * keeps dev and build on the same URL.
 */
function pdfjsAssets(): Plugin {
  const dirs = ["wasm", "cmaps", "standard_fonts", "iccs"];
  const root = path.dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json")
  );
  const contentTypes: Record<string, string> = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".icc": "application/vnd.iccprofile",
  };

  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]);
        const file = path.resolve(root, "." + rel);
        // Resolve first, then require the result to sit inside one of the four
        // directories. Checking the request string instead would serve
        // `/pdfjs/../package.json`, which normalizes back inside the package.
        const allowed = dirs.some((dir) =>
          file.startsWith(path.join(root, dir) + path.sep)
        );
        if (!allowed || !fs.existsSync(file)) return next();
        res.setHeader(
          "Content-Type",
          contentTypes[path.extname(file)] ?? "application/octet-stream"
        );
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of fs.readdirSync(path.join(root, dir))) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: fs.readFileSync(path.join(root, dir, name)),
          });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
