# HTML route (Word)

Owns the default route for a new Word document: the model designs the document in HTML and CSS and passes it as `author`'s `script`; a local Chrome or Edge lays it out at the printable width of its `@page` sheet; the runtime reads what the browser drew — each block's computed type, spacing, fills, rules, and widths — and writes native Word: paragraphs and runs, Heading styles, Word lists, tables on the grid the browser drew, pictures. The file stays editable in Word (no text boxes, no screenshots of text). The approach is dom-docx's (computed styles from Chromium; a flex row as a borderless table; a box as a one-cell table), set on Mixdog's own writer so Korean type, the audit, the brief, and the review apply unchanged.

## 1. The call
`office action:'author' path:<file.docx> script:<html> [overwrite:true] [mode:'portable'|'background'] [render:false]`
- Returns `session`, `audit`, `logs` (what could not be carried — each names its element), and unless `render:false` the rendered pages with `render.reviewToken` and `render.compare`: one image per page, the browser's print of the HTML on the left, the Word render on the right.
- The HTML is kept as `<file>.docx.mixdog-source.html`. **Default — fix by editing that file** and calling `author path:<file.docx>` with no `script` (no `overwrite` needed).
- Refusals land nothing: `html_failed` names the cause (a missing `@page` size, a browser that could not start).
- After landing, the document is an ordinary session: `batch` edits, `render`, `qa`, `finalize` as SKILL.md describes. A `<!-- BRIEF … -->` comment (the deck's keys: `subject/audience/action`, `sources`, `facts`) holds the document to its facts and asks the scored critique at finalize, as `design.brief` does.

## 2. Document contract
**Hard rule — the sheet is declared**: `@page { size: A4; margin: 20mm 20mm 18mm; }` (A3, A4, A5, B4, B5, letter, legal, each optionally `landscape`, or two lengths). The body is the text column: the runtime sets `body { margin: 0 }` and lays it out at the sheet's width between its margins. Pad inside boxes, never on `body`. → runtime `html_failed`
**Hard rule — Word's flow, not a canvas**: the document reads top to bottom. What maps:
| HTML / CSS | Word |
|---|---|
| `p`, a `div` of text, `h1`–`h3` | a paragraph in its own type and spacing; `h1`–`h3` take Heading 1–3 (the navigation pane and a contents field read them) |
| inline `strong`, `em`, `span` with colour or a background | runs in that type; an inline background is the run's shading |
| margins and padding between blocks | the paragraph's space before and after, as the browser measured the gap |
| a block with a top or bottom `border` (a rule under a title) | the paragraph's own rule, its padding the rule's gap |
| a block with a `border-left` (a pull quote, a callout) | the paragraph's left rule |
| a block with a `background` or a full `border` and padding (a callout, a box, the closing ask) | a one-cell table in that fill, rules, and padding |
| `display:flex` (row) or `display:grid` with side-by-side children (cards, a text column beside a side note) | a borderless table on the grid the browser drew: each child a cell in its own fill and padding, each gap an empty column |
| `<table>` | a Word table: the column widths, cell fills, per-side rules, padding, and alignment the browser drew; `thead` rows repeat on a new page; `break-inside: avoid` keeps it whole |
| `ul`, `ol`, nested to three levels | Word bullets and numbering (a new `ol` restarts at 1) |
| `hr` | a paragraph rule |
| `<img src>` (a local file or a `data:` PNG/JPEG) | a picture at its laid-out size; centred in its column, it is set centred |
| inline `<svg>`, `<canvas>`, `data-chart`, `data-icon`, or any element marked `data-docx-picture` | photographed at twice its size and placed as a picture (alt from `aria-label` or `data-alt`) |
| `break-before: page` / `break-after: page` | a page break; `break-after: avoid` keeps a block with the next |
| `<header>` / `<footer>` as children of `body` | the running header and footer; `{page}` and `{pages}` in the text are page fields (`{page} / {pages}`); `data-first-page="none"` leaves the first page without it (a cover) |

**Not carried** (reported in `logs`, never silently): `position: absolute|fixed` (left out), `transform` (drawn upright), CSS columns (one column), a picture inside a line of text (left out), `rowspan` (the cell keeps its first row), border radius and shadows (square, flat).
**Default — charts are `data-chart`**: the pdf skill's spec (type, labels, values or series, colors, format, labelColor, size, gap, axisLine…) drawn as SVG and placed as a picture; give the element a height. A chart the reader must edit belongs in a workbook.
**Default — type in pt, faces installed here**: `font-family` names an installed face first (`'Malgun Gothic'`, `'Noto Sans KR'`) — the face is written into the file; the reader's Word needs it too. Body 10–11 pt at `line-height` 1.6–1.75 for Hangul (Word holds each line at exactly that pitch), captions 8.5–9 pt, headings by a clear step. `word-break: keep-all` on `body`.

## 3. Design
The document's direction is the deck's: `${MIXDOG_SKILL_DIR}/../pptx/references/direction.md` §3, §5, §6 (style vocabulary, palette from one seed hue with one accent that has one job, type pairing) read for a page in the hand, and `writing.md` for the words. What a frontier report page does, and what to avoid:
- **The first page carries the decision**: eyebrow → assertion title (break it at a phrase with `<br>`, never leave one word on its own line) → one-line lede → a rule → a row of two to four figure cards (figure over label, each card one fill) → the conclusion in a callout. Pages after it: assertion headings, short paragraphs, an exhibit per section.
- **Exhibits are numbered and titled above, sourced below**: `그림 1. 월별 평균 대기 시간 (분)` in bold caption type over the chart or table, `출처: …` in muted caption type under it.
- **A side note beside the prose** (`display:grid; grid-template-columns: 1.6fr 1fr`) carries a definition, a method, or a quote; it fills the space a short paragraph leaves beside a chart.
- **Tables are sized to their content**, figures right-aligned with the header over them, a total row set apart (bold over a rule), hairlines between rows, no vertical rules.
- **No page half empty**: content that leaves most of the last page blank is regrouped (a side note, a closing ask box) or tightened, not padded. A page before the last that stops short — a table or figure kept whole moved on — is reported by `qa` and finalize as `page_bottom_empty`: keep `break-inside: avoid` for short tables and figures, and let a long table break with its `thead` repeating.
- Avoid the generated look `${MIXDOG_SKILL_DIR}/../pptx/references/html.md` §8 lists (cream paper and a terracotta accent, an all-caps label over every heading, identical shaded boxes everywhere, centred everything).

## 4. Review
Read every `render.compare` pair: the left is what the HTML meant, the right what Word drew. A difference in a box's fill or width, a table's columns, a picture's place, or a heading kept with its table is fixed in the HTML (or reported); the page breaks may fall differently — judge the Word side's breaks on their own. Then finalize as SKILL.md §1 step 5.
