import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");
cpSync("popup.html", "dist/popup.html");
cpSync("options.html", "dist/options.html");

const options = {
  entryPoints: [
    "src/background.ts",
    "src/capture.ts",
    "src/popup.ts",
    "src/options.ts",
  ],
  bundle: true,
  format: "iife",
  target: "chrome110",
  outdir: "dist",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
