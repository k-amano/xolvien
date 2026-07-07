# Document YAML Format (v1)

The common YAML format for all auto-generated documents (Sprint 3). Every
document type — requirements definition, external design, internal design,
specification, test report — is stored as **one YAML string conforming to this
single format**, and rendered to Excel/HTML by **one generic renderer**.

> **Design decision (changed from the original spec §6.3):** the original spec
> defined a fixed schema *per doc_type* (named top-level keys per document,
> templates referencing fields by name). That couples every template to every
> document type and makes adding a document type a schema+template+renderer
> change. Instead, v1 uses a **content-oriented common format**: a section
> tree whose leaves are ordered content blocks. Per-type differences live in
> the *generation prompt* (which chapters and blocks Claude must produce),
> not in the storage schema. One renderer handles every current and future
> document type.

## 1. Top-level structure

```yaml
format_version: 1          # integer, always 1 for this spec
doc_type: requirements     # requirements | external_design | internal_design
                           #   | specification | test_report
title: "Inventory Management System — Requirements Definition"
language: en               # ja | en — language of the content
sections:                  # ordered; at least one
  - ...                    # see §2
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `format_version` | int | yes | This spec is version `1`. Renderers reject unknown versions. |
| `doc_type` | enum | yes | One of the five types above. Used to select the per-type prompt at generation and shown on the cover/header at render. |
| `title` | string | yes | Document title. |
| `language` | enum | yes | `ja` or `en`. Selects the renderer's localized fixed strings (table/figure caption prefixes, missing-image placeholder); the string table itself lives in the renderer's i18n resource, not in this spec. |
| `sections` | array | yes | Top-level chapters, in order. |

System metadata (task id, generation timestamp) is **not** stored inside the
YAML — it is carried by the storage layer (the file's location
`documents/tasks/{task_id}/` and the timestamp in its name). The renderer
receives it as a separate `meta` context alongside the parsed YAML, so
templates can put it on the cover page without the YAML duplicating platform
state.

## 2. Sections (chapters)

A section is a recursive node. **Numbering is derived from position at render
time** (`1.`, `1.1`, `1.1.1`) — never written in the YAML. This makes
generated documents renumbering-safe: inserting a chapter never produces
inconsistent numbers.

```yaml
sections:
  - title: "Overview"             # -> rendered as "1. Overview"
    blocks: [ ... ]               # ordered content blocks (§3), optional
    sections:                     # child sections, optional
      - title: "Background"       # -> "1.1 Background"
        blocks: [ ... ]
        sections:
          - title: "Current Issues"   # -> "1.1.1 Current Issues"
            blocks: [ ... ]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Section heading text, **without** a number. |
| `blocks` | array | no | Ordered content blocks rendered before any child sections. |
| `sections` | array | no | Child sections. **Maximum nesting depth is 3** (`1.1.1`); the validator rejects deeper trees. |

A section may contain only `blocks`, only `sections`, or both. Sections with
neither are allowed by the schema but discouraged (they render as an empty
heading).

## 3. Content blocks

`blocks` is an ordered array of typed objects discriminated by `type`. The
five types — `text`, `table`, `list`, `figure`, `image` — may appear **in any
order and any number of times** within a section.

### 3.1 `text`

```yaml
- type: text
  content: |
    The system provides a single point of management for stock inflow and outflow.

    Target users are warehouse staff and administrators.
```

- `content` (string, required): **plain text**. A blank line separates
  paragraphs. No Markdown/HTML — renderers escape everything verbatim, so
  generated content can never break a template. (Rationale: Excel cells have
  no rich-text mapping for arbitrary Markdown; keeping one plain-text rule
  guarantees HTML and Excel render the same content.)

### 3.2 `table`

```yaml
- type: table
  caption: "Feature list"      # optional
  header: ["ID", "Feature", "Priority"]
  rows:
    - ["F-001", "Stock lookup", "High"]
    - ["F-002", "Inbound registration", "High"]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `caption` | string | no | Rendered as "Table N: {caption}" (localized per `language`; N numbered per document). |
| `header` | array of strings | yes | Column headers. Defines the column count. |
| `rows` | array of arrays | yes | Cells are scalars only (string / number / boolean / null → rendered as text; null → empty). Rows shorter than `header` are padded with empty cells; longer rows are a validation error. Newlines inside a cell are allowed (line break within the cell). |

### 3.3 `list`

```yaml
- type: list
  style: bullet               # bullet | number
  items:
    - "Search uses partial matching"
    - text: "Supported browsers"
      children:
        - "Chrome (latest)"
        - "Edge (latest)"
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `style` | enum | yes | `bullet` or `number` (1. 2. 3.). Applies to the whole block; nested levels inherit it. |
| `items` | array | yes | Each item is either a plain string, or `{text: string, children: [items...]}` for nesting. **Maximum list depth is 3.** |

### 3.4 `figure`

Text-described diagrams (flow, sequence, ER, state...). v1 supports **Mermaid
only** — it is the one notation Claude reliably produces and HTML renders
natively.

```yaml
- type: figure
  format: mermaid             # v1: "mermaid" only (field kept for future formats)
  caption: "Stock update flow"   # optional
  code: |
    flowchart TD
      A[Inbound registration] --> B{In stock?}
      B -- yes --> C[Add quantity]
      B -- no  --> D[Create new record]
```

- Rendered as "Figure N: {caption}" (localized per `language`).
- **HTML**: rendered with Mermaid (inlined at render time, CSP-safe).
- **Excel (v1)**: the Mermaid source is emitted as preformatted text in a
  bordered cell block with the figure caption — readable, if not graphical.
  Pre-rendering Mermaid to PNG for Excel is a possible v2 improvement; the
  YAML needs no change for it.

### 3.5 `image`

Raster images that already exist as files — typically E2E screenshots.

```yaml
- type: image
  path: "e2e/screenshots/login.png"   # required
  caption: "Login screen"             # optional
  alt: "Screenshot of the login form" # optional
```

- `path` is **workspace-relative** (relative to `/workspace/repo` in the task
  container). At generation time the backend copies each referenced file into
  a per-document asset snapshot (`backend/doc_assets/{task_id}/{doc_type}/`);
  rendering resolves `path` against that snapshot, so documents stay
  renderable after the container or workspace is gone.
- A `path` that cannot be resolved at generation time is kept in the YAML but
  rendered as a placeholder box with the caption and a localized
  "(image missing)" marker — generation never fails because a screenshot
  vanished.
- **HTML**: embedded as base64 `data:` URI (self-contained file). **Excel**:
  embedded via openpyxl.

## 4. Validation

The backend validates every document Claude produces against the JSON Schema
below (YAML is parsed, then validated) **before** saving to `task_documents`.
On failure, generation retries with the validation errors appended to the
prompt (max 2 retries), then surfaces an error.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["format_version", "doc_type", "title", "language", "sections"],
  "additionalProperties": false,
  "properties": {
    "format_version": { "const": 1 },
    "doc_type": { "enum": ["requirements", "external_design", "internal_design", "specification", "test_report"] },
    "title": { "type": "string", "minLength": 1 },
    "language": { "enum": ["ja", "en"] },
    "sections": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/sectionL1" } }
  },
  "$defs": {
    "sectionL1": {
      "type": "object",
      "required": ["title"],
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "blocks": { "type": "array", "items": { "$ref": "#/$defs/block" } },
        "sections": { "type": "array", "items": { "$ref": "#/$defs/sectionL2" } }
      }
    },
    "sectionL2": {
      "type": "object",
      "required": ["title"],
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "blocks": { "type": "array", "items": { "$ref": "#/$defs/block" } },
        "sections": { "type": "array", "items": { "$ref": "#/$defs/sectionL3" } }
      }
    },
    "sectionL3": {
      "type": "object",
      "required": ["title"],
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "blocks": { "type": "array", "items": { "$ref": "#/$defs/block" } }
      }
    },
    "block": {
      "oneOf": [
        { "$ref": "#/$defs/textBlock" },
        { "$ref": "#/$defs/tableBlock" },
        { "$ref": "#/$defs/listBlock" },
        { "$ref": "#/$defs/figureBlock" },
        { "$ref": "#/$defs/imageBlock" }
      ]
    },
    "textBlock": {
      "type": "object",
      "required": ["type", "content"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "text" },
        "content": { "type": "string", "minLength": 1 }
      }
    },
    "tableBlock": {
      "type": "object",
      "required": ["type", "header", "rows"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "table" },
        "caption": { "type": "string" },
        "header": { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "rows": {
          "type": "array",
          "items": {
            "type": "array",
            "items": { "type": ["string", "number", "boolean", "null"] }
          }
        }
      }
    },
    "listBlock": {
      "type": "object",
      "required": ["type", "style", "items"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "list" },
        "style": { "enum": ["bullet", "number"] },
        "items": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/listItemL1" } }
      }
    },
    "listItemL1": {
      "oneOf": [
        { "type": "string" },
        {
          "type": "object",
          "required": ["text"],
          "additionalProperties": false,
          "properties": {
            "text": { "type": "string" },
            "children": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/listItemL2" } }
          }
        }
      ]
    },
    "listItemL2": {
      "oneOf": [
        { "type": "string" },
        {
          "type": "object",
          "required": ["text"],
          "additionalProperties": false,
          "properties": {
            "text": { "type": "string" },
            "children": { "type": "array", "minItems": 1, "items": { "type": "string" } }
          }
        }
      ]
    },
    "figureBlock": {
      "type": "object",
      "required": ["type", "format", "code"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "figure" },
        "format": { "const": "mermaid" },
        "caption": { "type": "string" },
        "code": { "type": "string", "minLength": 1 }
      }
    },
    "imageBlock": {
      "type": "object",
      "required": ["type", "path"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "image" },
        "path": { "type": "string", "minLength": 1 },
        "caption": { "type": "string" },
        "alt": { "type": "string" }
      }
    }
  }
}
```

Additional checks the validator applies beyond the schema (row width vs
`header` length) are implemented in code.

## 5. Complete example

```yaml
format_version: 1
doc_type: requirements
title: "Inventory Management System — Requirements Definition"
language: en
sections:
  - title: "Overview"
    blocks:
      - type: text
        content: |
          The system provides a single point of management for stock inflow and
          outflow, and streamlines the monthly stocktaking process.
    sections:
      - title: "Background"
        blocks:
          - type: text
            content: |
              Inventory is currently tracked in spreadsheets; input errors and
              aggregation effort are the main problems.
          - type: list
            style: bullet
            items:
              - "An average of 12 stock-count transcription errors per month"
              - text: "Time required for stocktaking"
                children:
                  - "Current: 2 people x 3 days"
                  - "Target: 2 people x 1 day"
  - title: "Functional Requirements"
    blocks:
      - type: table
        caption: "Feature list"
        header: ["ID", "Feature", "Description", "Priority"]
        rows:
          - ["F-001", "Stock lookup", "Search items by partial name match", "High"]
          - ["F-002", "Inbound registration", "Add received quantity to stock", "High"]
      - type: figure
        format: mermaid
        caption: "Screen transition diagram"
        code: |
          flowchart LR
            L[Login] --> S[Stock list]
            S --> D[Item detail]
            S --> I[Inbound registration]
  - title: "Non-functional Requirements"
    blocks:
      - type: text
        content: |
          The system assumes up to 10 concurrent users.
      - type: image
        path: "docs/mockups/list.png"
        caption: "Stock list screen mockup"
```

## 6. Rendering contract (summary)

The generic renderer walks the tree once and, for each output format, maps:

| Element | HTML | Excel (openpyxl) |
|---|---|---|
| Section | `<h1>`–`<h3>` with derived number | Bold heading row, indent by level, derived number |
| text | `<p>` per paragraph (escaped) | Wrapped text cell(s) |
| table | `<table>` with `<caption>` | Header-styled row + bordered grid, caption above |
| list | `<ul>`/`<ol>` nested | One row per item, indented, bullet/number prefixes |
| figure | Mermaid render, numbered caption | Preformatted code block + numbered caption |
| image | Base64-embedded `<img>`, numbered caption | Embedded image + numbered caption |

Figure/table/image numbers are counted per document in reading order.
Templates control page frame (cover, header/footer, styles); the block
renderer controls content. Custom templates therefore override look & feel
without knowing anything about individual doc types.

## 7. Generation contract (summary)

- The per-`doc_type` prompt instructs Claude to output **only** a fenced
  ```yaml code block conforming to this spec, and prescribes the expected
  chapter outline for that type (see spec.md §6.2) — the outline is a prompt
  concern, not a schema constraint.
- The backend extracts the fenced block, parses, validates (§4), retries with
  error feedback up to 2 times, and stores the raw YAML as a file at
  `{document_data_path}/tasks/{task_id}/{doc_type}_{YYYYMMDD_HHMMSS}.yaml`
  (default `backend/documents/`). Every generation is kept — the newest
  timestamp per `doc_type` is the current version.
