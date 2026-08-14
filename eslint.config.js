import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // convex/_generated is written by `convex dev`; linting it only produces
  // warnings about disable directives we do not control and cannot keep.
  globalIgnores(['dist', 'convex/_generated']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },

  // ------------------------------------------------------------------
  // The design-system fence.
  //
  // Prose in CLAUDE.md shapes intent; only these rules fail the build, and
  // that difference is the whole reason they exist. The layer decays by
  // *addition* — someone writes a new inline dialog rather than editing the
  // shared one — which no review of a single diff reliably catches.
  //
  // src/components/ui/** is exempted below: that is where raw elements and
  // Base UI imports are supposed to live.
  // ------------------------------------------------------------------
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/components/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@base-ui/react/*'],
              message:
                'Import Base UI only inside src/components/ui/. Wrap the primitive there so styling, data-slot and variants stay in one place, then import the wrapper.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="aria-modal"]',
          message:
            'aria-modal by hand means a hand-rolled dialog. Use Dialog/DialogContent from @/components/ui/dialog, or AlertDialog via useConfirm().',
        },
        {
          selector:
            'JSXAttribute[name.name="role"][value.value=/^(dialog|alertdialog|combobox|listbox|tablist|tab|tabpanel|menu|menuitem|switch|tooltip)$/]',
          message:
            'Base UI wires this role together with focus trap, focus restore and scoped Escape. Hand-rolled versions get the role right and the focus wrong. Use the primitive in @/components/ui/ (add the wrapper if it is missing). Disable with a reason on the line if Base UI genuinely has no equivalent.',
        },
        {
          selector:
            'CallExpression[callee.object.name="window"][callee.property.name=/^(confirm|alert|prompt)$/]',
          message:
            'Native prompts sit outside the app focus model and never restore focus. Use useConfirm() from @/components/ui/confirm-dialog.',
        },
        {
          // Arbitrary type sizes still compile even with --text-*: initial
          // cleared, so the theme cannot enforce the scale — this can.
          selector: 'Literal[value=/(^|\\s)text-\\[/]',
          message:
            'Off-scale type. Use text-2xs|xs|sm|base|lg|xl|3xl, or name a new step in @theme in src/index.css.',
        },
        {
          // `text-sm/6` emits font-size and line-height only, silently
          // dropping the step's letter-spacing and font-weight.
          selector: 'Literal[value=/(^|\\s)text-(2xs|xs|sm|base|lg|xl|3xl)\\//]',
          message:
            'The text-*/N shorthand drops the step\'s tracking and weight rather than overriding them. Use `text-sm leading-6` if you must break the grid.',
        },
      ],
    },
  },

  // The wrapper layer is where raw elements and Base UI imports belong.
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },
])
