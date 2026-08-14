import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The gate behind convex/ownership.ts.
 *
 * `authedQuery` proves there is a signed-in user; it says nothing about whether
 * that user owns the row they just named by id. Nothing in the type system
 * connects the two, so this test does: every authed endpoint that accepts a
 * `v.id(...)` argument must reach an ownership helper, or be listed in
 * UNSCOPED below with a reason.
 *
 * It is a source parse rather than a runtime harness on purpose. The failure it
 * exists to catch is a *new* endpoint written without the check — which is a
 * fact about the text of this directory, needs no deployment to detect, and
 * would otherwise be caught only by someone thinking to look.
 */

const DIR = __dirname;

/** Returns the contents of the {...} whose opening brace is at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return "";
}

type Endpoint = {
  file: string;
  name: string;
  builder: string;
  idArgs: string[];
  body: string;
};

function endpoints(): Endpoint[] {
  const found: Endpoint[] = [];
  const decl =
    /export const (\w+) = (authedQuery|authedMutation|authedAction|adminQuery)\(\{/g;
  for (const file of fs.readdirSync(DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    for (const m of src.matchAll(decl)) {
      const body = balanced(src, m.index! + m[0].length - 1);
      const argsAt = /\bargs:\s*\{/.exec(body);
      const args = argsAt ? balanced(body, argsAt.index + argsAt[0].length - 1) : "";
      const idArgs = [...args.matchAll(/v\.id\("(\w+)"\)/g)].map((x) => x[1]);
      found.push({ file, name: m[1], builder: m[2], idArgs, body });
    }
  }
  return found;
}

/**
 * Endpoints that take an id but legitimately do not walk to a project.
 * Every entry needs a reason; an entry without one is a bug hiding behind a
 * list. Keep it short — it is the exception surface.
 */
const UNSCOPED: Record<string, string> = {};

/**
 * The helper names, read out of ownership.ts rather than restated here — a
 * hardcoded list would silently stop recognising a helper the day one is
 * renamed, and every endpoint using it would start reading as unchecked.
 */
function helperNames(): string[] {
  const src = fs.readFileSync(path.join(DIR, "ownership.ts"), "utf8");
  return [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
}

describe("ownership coverage", () => {
  const all = endpoints();
  const helpers = helperNames();
  const callsHelper = new RegExp(`\\b(${helpers.join("|")})\\(`);

  it("finds the authed surface", () => {
    // Guards on the parsers themselves: if a refactor renames the builders, or
    // ownership.ts stops matching, these tests would otherwise pass by
    // checking nothing at all.
    expect(all.length).toBeGreaterThan(60);
    expect(helpers.length).toBeGreaterThan(5);
  });

  it("every authed endpoint taking an id checks ownership", () => {
    const missing = all
      .filter((e) => e.idArgs.length > 0)
      .filter((e) => !UNSCOPED[`${e.file.replace(/\.ts$/, "")}.${e.name}`])
      .filter((e) => !callsHelper.test(e.body))
      .map((e) => `${e.file}:${e.name} (${e.idArgs.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("no endpoint lists itself as unscoped without existing", () => {
    const names = new Set(
      all.map((e) => `${e.file.replace(/\.ts$/, "")}.${e.name}`)
    );
    expect(Object.keys(UNSCOPED).filter((k) => !names.has(k))).toEqual([]);
  });
});
