# Vendored CSL styles

Fetched 2026-08-14 from the Citation Style Language project, unmodified:

| File | Style | Source |
| --- | --- | --- |
| `apa.csl` | APA Style 7th edition | [styles](https://github.com/citation-style-language/styles)`/apa.csl` |
| `chicago-notes-bibliography.csl` | Chicago Manual of Style 18th edition (notes and bibliography) | `styles/chicago-notes-bibliography.csl` |
| `modern-language-association.csl` | MLA Handbook 9th edition (in-text citations) | `styles/modern-language-association.csl` |
| `locales-en-US.xml` | en-US locale | [locales](https://github.com/citation-style-language/locales)`/locales-en-US.xml` |

All four are **CC BY-SA 3.0**. The rendering engine (`citeproc`, npm) is
CPAL-1.0 OR AGPL-1.0 — see the licence note in `../format.ts`.

They are checked in rather than fetched at runtime for two reasons: the app has
no network access to them at render time, and a style that changes underneath a
published bibliography would silently reformat citations someone has already
quoted.

Upstream renames these files. `chicago-note-bibliography.csl` (singular "note")
404s now — the current name is `chicago-notes-bibliography.csl`. Check the file
actually parsed as XML after any re-fetch; a 404 body is 14 bytes of plain text
and fails only when citeproc tries to use it.
