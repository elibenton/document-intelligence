# Draft bug report for Interfaze — not yet sent

**To:** support@interfaze.ai
**Suggested subject:** OCR returns empty `message.content` with billed completion tokens for image-only PDFs

> This is a draft for you to review and send. Attach
> `test-corpus/variants/enc-dct-jpeg.pdf` (14 KB) as the minimal reproduction, or
> any single-page PDF that contains one image and no text layer.

---

Hello,

We're using Interfaze for OCR over scanned legal documents and have hit a
reproducible failure where the API returns a successful response containing no
content, while still billing for output tokens.

## Summary

For a PDF whose pages are images with no embedded text layer, `task: "ocr"`
returns HTTP 200 with `finish_reason: "stop"`, no `refusal`, no `precontext`, and
`message.content` set to the empty string — but a non-zero `completion_tokens`.
Something was generated and did not reach us.

The same pages sent as PNG images OCR perfectly, so this is specific to the PDF
input path, not to the documents or the model's ability to read them.

## Minimal reproduction

A single-page PDF, 14 KB, containing one `/DCTDecode` image and nothing else.

```js
import { Interfaze, inputs } from "interfaze";

const client = new Interfaze({ apiKey: process.env.INTERFAZE_API_KEY });

const res = await client.chat.completions.create({
  task: "ocr",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Extract all text and data." },
      inputs.file(await inputs.dataUrl(bytes, "application/pdf"), {
        filename: "enc-dct-jpeg.pdf",
      }),
    ],
  }],
});

console.log(JSON.stringify(res.choices[0].message.content));  // ""
console.log(res.usage);
```

Observed response:

```jsonc
{
  "choices": [{
    "finish_reason": "stop",
    "message": { "role": "assistant", "content": "", "refusal": null }
  }],
  "precontext": [],
  "vcache": false,
  "usage": { "prompt_tokens": 1286, "completion_tokens": 577 }
}
```

`completion_tokens: 577` with `content: ""`. On our original 17-page production
document the same shape appears with `completion_tokens: 8790`.

It is deterministic: `bypassCache: true` returns the same thing, and it does not
depend on document size — 1, 5, 10 and 17-page versions all behave identically.

## What we established while narrowing it

We generated a matrix of PDF variants and ran each through `task: "ocr"`. The
relevant results:

| Input | `content` |
|---|---|
| PDF, one page of painted text | full text, accurate |
| PDF, one page of scanned image, no text layer | **empty** |
| The same image as a PNG via `inputs.image` | full text, accurate |
| PDF with text drawn in rendering mode 3 (invisible) | **empty** |
| PDF, page with text **and** a full-page image drawn over it | **empty** |
| PDF, page with text and a half-page image clear of it | full text |
| PDF, page with text and a small corner image | full text |

The image encoding makes no difference — CCITT G4, DCTDecode, FlateDecode grey,
Flate bilevel, DeviceRGB, DeviceCMYK, Indexed and `/ImageMask` are all empty.

Our reading is that the PDF path extracts the embedded text layer and never
performs OCR on embedded raster images, and that text which is invisible or
covered by a page-sized image is discarded along with it. Since that is exactly
how every scanner's "searchable PDF" is laid out, it affects most scanned
documents we receive.

## What we'd like

1. **Don't bill, and don't return 200, for an empty completion.** Whatever
   produced those 577 tokens should either reach us or surface as an error. A
   silent empty string is indistinguishable from "this document has no text",
   which is what we initially believed and reported to our own users.
2. **Confirm whether OCR of raster images inside a PDF is supposed to work.** If
   it is not supported, we'll rasterize to images ourselves — but we'd like that
   documented, because the current behaviour reads as a bug rather than a limit.
3. If it *is* supposed to work, this is the reproduction.

## A second, separate issue: silent 50-page truncation

While testing we found that PDFs over 50 pages are truncated with no indication.
Files of 45, 60, 150 and 520 pages of plain text returned 45, 50, 50 and 50 pages
respectively — the 60, 150 and 520-page responses were identical in length and
token count. There is no error, no `finish_reason` change, and nothing in the
response marking the result as partial. A 520-page document silently losing 470
pages is difficult to detect downstream. Could a truncation indicator be added, or
the limit documented?

Thanks — happy to share the full variant corpus and raw responses if useful.

---

## Notes for us (strip before sending)

- Reproduction file: `test-corpus/variants/enc-dct-jpeg.pdf`.
- Original production document:
  `test-corpus/Order-and-Decision_HDO3-Holdings_C11-0001341-LIC_6.10.2024.pdf`
  (17pp, 0.42 MB, Sharp copier scan, 17× `/CCITTFaxDecode`).
- Full evidence and the variant matrix: `docs/pdf-edge-cases.md`.
- Raw responses: `test-corpus/results/raw/`.
