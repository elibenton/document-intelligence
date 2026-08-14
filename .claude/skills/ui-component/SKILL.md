---
name: ui-component
description: Add or change a UI component in Haystack — any new screen, panel, dialog, popover, button, form control, or Tailwind styling under src/. Routes to the shared Base UI primitive instead of hand-rolling, and to the keyboard verification protocol. Use before writing JSX, not after. Triggers on "add a button/dialog/modal/dropdown/tab/menu/form", "new panel or screen", "style this component", "make this look like…", or any edit to src/components/** or src/pages/**.
---

# Adding or changing UI

## 1. Does the primitive exist? (before writing JSX)

```
ls src/components/ui/
```

Base UI wrappers: `button`, `input`, `textarea`, `dialog`, `tabs`, `badge`,
`popover`, `tooltip`, `toast`, `confirm-dialog`. App primitives: `page-shell`
(+ `SectionHeading`), `empty-state`, `alert`, `search-field`, `spinner`,
`skeleton`, `progress`, `SplitPane`, `theme-toggle`.

- **It exists** → import it. Done.
- **Base UI has it, we haven't wrapped it** → add the wrapper to `ui/` first,
  in the style of `popover.tsx`, then import it. Base UI 1.3 ships `Combobox`,
  `Autocomplete`, `Menu`, `ContextMenu`, `Select`, `Checkbox`, `RadioGroup`,
  `Switch`, `Toolbar`, `ScrollArea`, `Collapsible`, `Accordion`, `NumberField`,
  `Slider`, `Field`/`Fieldset`/`Form`, `PreviewCard`, `Meter`, `Drawer`. Check
  before concluding it doesn't.
- **Base UI genuinely has no primitive** (canvas overlays, PDF geometry, the
  resizable panes) → raw elements are correct. Say why in the commit and in an
  `eslint-disable` with a reason.

**Never** inline a one-off `Modal`, `Chip` or `IconButton` in a screen file.

## 2. Never hand-write ARIA a primitive would wire

If you are typing `role=`, `aria-modal`, or a `useEffect` for Escape / focus /
outside-click — go back to step 1. Base UI gives you the role *and* the focus
trap, focus restore, scoped Escape and outside-press. Hand-rolled versions
reliably get the first and miss the rest. eslint will stop you.

`aria-label`, `aria-labelledby` and `sr-only` text on a primitive: always fine,
often required.

Two things Base UI does **not** give you, so they stay yours: an accessible
name, and colour contrast.

## 3. Stay on the scale

Tokens live in `src/index.css`. Tailwind v4, no `tailwind.config`.

- Type: `text-2xs | xs | sm | base | lg | xl | 3xl`. Not `text-[11px]`, and not
  the `text-sm/6` slash form — it drops the step's tracking and weight.
- Colour: semantic tokens (`bg-card`, `text-muted-foreground`, `border-border`,
  `text-destructive`, `text-success`, `text-warning`). No raw palette colours
  for status.
- Icons: `size-3 | size-3.5 | size-4`, using `size-N` not `h-N w-N` — the
  two-class form has already drifted in this repo (`h-4 w-5` existed).
- Control heights: `size-5` (chip-internal), `h-7` (dense toolbars), `h-8`
  (default), `h-9` (primary), `h-12` (hero).

Computed geometry from measured PDF/canvas coordinates goes in `style={{…}}`
and is not a token. That is the one legitimate escape.

## 4. Verify — keyboard first, screenshot second

```
npx tsc -b && npm run lint
```

`npm run lint` has **2 known pre-existing errors** in `src/components/viewer/`.
The gate is "still exactly 2", not "clean".

Then run the app (`preview_start` with the `app` config in `.claude/launch.json`)
and, for anything interactive:

- Tab and Shift-Tab through every control — focus ring visible at each stop
- Enter / Space do what a click does
- Escape closes the overlay, and **focus returns to the trigger**
- The overlay does not close a *parent* overlay along with itself

A screenshot proves none of this. If you couldn't run the keyboard pass, say so
rather than reporting it verified.

If you changed anything in `src/index.css`, also assert the Tabs gate — the
`data-horizontal`/`data-vertical` variants are re-homed from a deleted package
and fail silently:

```
npm run build && grep -o 'data-orientation' dist/assets/index-*.css | wc -l   # must be 12
```

## 5. Before committing

Invoke the `ui-reviewer` subagent on the diff. Commit atomically straight to
`main` — no branch, no PR. `npm run deploy` is a separate act from committing.
