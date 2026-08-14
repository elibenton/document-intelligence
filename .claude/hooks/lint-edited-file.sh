#!/bin/sh
# PostToolUse hook: lint the single file Claude just edited.
#
# The design-system fence in eslint.config.js only bites when someone runs
# `npm run lint` — which a coding session usually doesn't. This runs it on the
# one file that just changed, so a violation comes back while the code is still
# being written instead of at build time.
#
# Scoped to one file on purpose: this repo is often edited by more than one
# process at once, so a whole-repo error count is not a stable baseline.
#
# What it calls, and why each is safe:
#   eslint  — a devDependency, run from node_modules/.bin. In the project.
#   node    — NOT in the project, and NOT on the default PATH: it is mise-managed
#             here (~/.local/share/mise/installs/...), while a hook can inherit a
#             bare PATH of /usr/bin:/bin:... eslint's shim is `#!/usr/bin/env
#             node`, so without the PATH line below it dies with
#             "env: node: No such file or directory". Measured, not theoretical.
#   jq      — NOT in the project either, but it is /usr/bin/jq, Apple-shipped
#             with macOS and present even in a stripped environment. Swapping it
#             for `node -e` would make this hook *less* reliable, not more, and
#             would pay node's startup on every non-TypeScript edit.
#
# Both externals are checked before use. If either is missing the hook exits 0:
# a toolchain problem must never block an edit. Only genuine lint errors exit 2,
# which does not undo the edit — it hands eslint's output back as feedback.

# Resolved from the script's own location so a moved or renamed checkout keeps
# working; CLAUDE_PROJECT_DIR wins when the harness supplies it.
REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
ESLINT="$REPO/node_modules/.bin/eslint"

PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0

# Only TypeScript inside this repo. Skips markdown, scratchpad files, and
# anything outside the tree without spawning node.
case "$file" in
  "$REPO"/*.ts|"$REPO"/*.tsx) ;;
  *) exit 0 ;;
esac

[ -x "$ESLINT" ] || exit 0
command -v node >/dev/null 2>&1 || {
  echo "lint hook skipped: node not found on PATH" >&2
  exit 0
}

output=$(cd "$REPO" && "$ESLINT" --no-warn-ignored "$file" 2>&1)
case $? in
  0) exit 0 ;;                        # clean
  1) printf '%s\n' "$output" >&2      # lint errors — the case worth reporting
     exit 2 ;;
  *) printf 'lint hook could not run eslint:\n%s\n' "$output" >&2
     exit 0 ;;                        # fatal config/tooling error: never block
esac
