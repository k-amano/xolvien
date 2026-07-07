# Document YAML Format (v1.1)

The common YAML format for all auto-generated documents (Sprint 3). Every
document type — requirements definition, external design, internal design,
specification, test report — is stored as **one YAML string conforming to this
single format**, and rendered to Excel/HTML by **one generic renderer**.

> **v1.1 (2026-07-07):** extended for deliverable-grade output based on
> government/enterprise document requirements: cell merging
> (`colspan`/`rowspan`), multi-row table headers, row headers
> (`row_header_cols`), structured cover page and revision history, page
> breaks, and `code`/`note` blocks plus image sizing. All additions are
> optional fields or type widenings — **every v1 document remains valid**, so
> `format_version` stays `1`.

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
cover:                     # optional — cover-page metadata (see below)
  version: "1.0.0"
  date: "2026-07-07"
  organization: "Sample Inc."
  department: "System Development Dept."
  author: "Taro Yamada"
  reviewers: ["Jiro Sato"]
  approver: "Manager Tanaka"
  subtitle: "Detailed Design"
revisions:                 # optional — structured revision history
  - version: "1.0.0"
    date: "2026-07-07"
    author: "Taro Yamada"
    summary: "Initial version"
sections:                  # ordered; at least one
  - ...                    # see §2
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `format_version` | int | yes | This spec is version `1`. Renderers reject unknown versions. |
| `doc_type` | enum | yes | One of the five types above. Used to select the per-type prompt at generation and shown on the cover/header at render. |
| `title` | string | yes | Document title. |
| `language` | enum | yes | `ja` or `en`. Selects the renderer's localized fixed strings (table/figure caption prefixes, missing-image placeholder); the string table itself lives in the renderer's i18n resource, not in this spec. |
| `cover` | object | no | Cover-page metadata: `subtitle`, `version`, `date`, `organization`, `department`, `author`, `reviewers` (array), `approver` — all optional strings. Without it the cover shows the title only. |
| `revisions` | array | no | Revision history entries: `version`, `date`, `summary` (required), `author` (optional). Enables an auto-generated revision-history page. |
| `sections` | array | yes | Top-level chapters, in order. |

`cover` and `revisions` exist for deliverable finishing and are typically
filled by the user or the platform; **auto-generation omits them** (the
generation prompt forbids Claude from inventing authors/approvers).

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
| `page_break_before` | boolean | no | Start this section on a new page (HTML print CSS / Excel page break). Default false. |
| `blocks` | array | no | Ordered content blocks rendered before any child sections. |
| `sections` | array | no | Child sections. **Maximum nesting depth is 3** (`1.1.1`); the validator rejects deeper trees. |

A section may contain only `blocks`, only `sections`, or both. Sections with
neither are allowed by the schema but discouraged (they render as an empty
heading).

## 3. Content blocks

`blocks` is an ordered array of typed objects discriminated by `type`. The
seven types — `text`, `table`, `list`, `figure`, `image`, `code`, `note` —
may appear **in any order and any number of times** within a section.

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
| `header` | array | yes | A list of column-name strings, **or a list of header rows** for multi-tier headers (see below). The last header row is the most granular and defines the grid's column count. |
| `row_header_cols` | int | no | Number of leftmost columns rendered with header styling (background, centered) — for item-name/value tables. Default 0. |
| `rows` | array of arrays | yes | Each cell is a scalar (string / number / boolean / null → rendered as text; null → empty) **or a merge object** (see below). Rows narrower than the grid are padded with empty cells (or continue a `rowspan`); a row occupying more columns than the grid is a validation error. Newlines inside a cell are allowed. |

**Cell merging** — a cell may be an object `{value, colspan?, rowspan?}`:

```yaml
- type: table
  caption: "Input/output parameters"
  header: ["Kind", "Name", "Type", "Description"]
  rows:
    - [{value: "Input", rowspan: 3}, "name", "string", "User name"]
    - ["email", "string", "Email address"]        # merged cell continues; omit it
    - ["password", "string", "Password"]
    - [{value: "Output", rowspan: 2}, "user_id", "int", "Registered user ID"]
    - ["created_at", "datetime", "Creation time"]
```

Rows covered by a `rowspan` from above **omit** the spanned cell entirely.
HTML renders `colspan`/`rowspan` attributes; Excel uses `merge_cells()`.

**Multi-row headers** — `header` may be a list of rows, each cell a string or
a merge object:

```yaml
- type: table
  caption: "Entity definition"
  header:
    - [{value: "Basic info", colspan: 2}, {value: "Validation", colspan: 2}]
    - ["Name", "Type", "Constraint", "Description"]
  rows:
    - ["id", "int", "auto-numbered", "User ID"]
    - ["name", "string", "required, max 100 chars", "User name"]
```

**Row headers** — `row_header_cols: 1` styles the leftmost column as a
header:

```yaml
- type: table
  caption: "Feature information"
  row_header_cols: 1
  header: ["Item", "Value"]
  rows:
    - ["Feature ID", "USER-001"]
    - ["Status", "Approved"]
```

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
  width: "60%"                        # optional — CSS-style width
  align: center                       # optional — left | center | right
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

### 3.6 `code`

Verbatim source code for technical documents (distinct from `figure`, which
is diagram notation).

```yaml
- type: code
  language: python            # optional — syntax-highlight hint
  caption: "Validation logic" # optional
  content: |
    def validate_email(email: str) -> bool:
        return "@" in email and "." in email
```

- **HTML**: `<pre><code>` (highlighted when `language` is given). **Excel**:
  preformatted monospace cell block.

### 3.7 `note`

Supplementary remarks and cautions (the ubiquitous asterisked footnote-style
annotations in deliverable documents).

```yaml
- type: note
  style: warning              # optional — info | warning | important
  content: |
    This feature requires administrator privileges.
```

- `style` controls the visual treatment (icon/border color); default is
  `info`-like neutral styling when omitted.

## 4. Validation

The backend validates every document Claude produces against the JSON Schema
below (YAML is parsed, then validated) **before** saving to the document
file. On failure, generation retries with the validation errors appended to
the prompt (max 2 retries), then surfaces an error.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": [
    "format_version",
    "doc_type",
    "title",
    "language",
    "sections"
  ],
  "additionalProperties": false,
  "properties": {
    "format_version": {
      "const": 1
    },
    "doc_type": {
      "enum": [
        "requirements",
        "external_design",
        "internal_design",
        "specification",
        "test_report"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "language": {
      "enum": [
        "ja",
        "en"
      ]
    },
    "revisions": {
      "$ref": "#/$defs/revisions"
    },
    "cover": {
      "$ref": "#/$defs/cover"
    },
    "sections": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/sectionL1"
      }
    }
  },
  "$defs": {
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "version",
          "date",
          "summary"
        ],
        "additionalProperties": false,
        "properties": {
          "version": {
            "type": "string"
          },
          "date": {
            "type": "string"
          },
          "author": {
            "type": "string"
          },
          "summary": {
            "type": "string"
          }
        }
      }
    },
    "cover": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "subtitle": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "date": {
          "type": "string"
        },
        "organization": {
          "type": "string"
        },
        "department": {
          "type": "string"
        },
        "author": {
          "type": "string"
        },
        "reviewers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "approver": {
          "type": "string"
        }
      }
    },
    "cellValue": {
      "oneOf": [
        {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ]
        },
        {
          "type": "object",
          "required": [
            "value"
          ],
          "additionalProperties": false,
          "properties": {
            "value": {
              "type": [
                "string",
                "number",
                "boolean",
                "null"
              ]
            },
            "colspan": {
              "type": "integer",
              "minimum": 1
            },
            "rowspan": {
              "type": "integer",
              "minimum": 1
            }
          }
        }
      ]
    },
    "headerRow": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/cellValue"
      }
    },
    "sectionL1": {
      "type": "object",
      "required": [
        "title"
      ],
      "additionalProperties": false,
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1
        },
        "page_break_before": {
          "type": "boolean"
        },
        "blocks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/block"
          }
        },
        "sections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/sectionL2"
          }
        }
      }
    },
    "sectionL2": {
      "type": "object",
      "required": [
        "title"
      ],
      "additionalProperties": false,
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1
        },
        "page_break_before": {
          "type": "boolean"
        },
        "blocks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/block"
          }
        },
        "sections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/sectionL3"
          }
        }
      }
    },
    "sectionL3": {
      "type": "object",
      "required": [
        "title"
      ],
      "additionalProperties": false,
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1
        },
        "page_break_before": {
          "type": "boolean"
        },
        "blocks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/block"
          }
        }
      }
    },
    "block": {
      "oneOf": [
        {
          "$ref": "#/$defs/textBlock"
        },
        {
          "$ref": "#/$defs/tableBlock"
        },
        {
          "$ref": "#/$defs/listBlock"
        },
        {
          "$ref": "#/$defs/figureBlock"
        },
        {
          "$ref": "#/$defs/imageBlock"
        },
        {
          "$ref": "#/$defs/codeBlock"
        },
        {
          "$ref": "#/$defs/noteBlock"
        }
      ]
    },
    "textBlock": {
      "type": "object",
      "required": [
        "type",
        "content"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "text"
        },
        "content": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "tableBlock": {
      "type": "object",
      "required": [
        "type",
        "header",
        "rows"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "table"
        },
        "caption": {
          "type": "string"
        },
        "header": {
          "oneOf": [
            {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string"
              }
            },
            {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/headerRow"
              }
            }
          ]
        },
        "row_header_cols": {
          "type": "integer",
          "minimum": 0
        },
        "rows": {
          "type": "array",
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/cellValue"
            }
          }
        }
      }
    },
    "listBlock": {
      "type": "object",
      "required": [
        "type",
        "style",
        "items"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "list"
        },
        "style": {
          "enum": [
            "bullet",
            "number"
          ]
        },
        "items": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/listItemL1"
          }
        }
      }
    },
    "listItemL1": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "required": [
            "text"
          ],
          "additionalProperties": false,
          "properties": {
            "text": {
              "type": "string"
            },
            "children": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/listItemL2"
              }
            }
          }
        }
      ]
    },
    "listItemL2": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "required": [
            "text"
          ],
          "additionalProperties": false,
          "properties": {
            "text": {
              "type": "string"
            },
            "children": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string"
              }
            }
          }
        }
      ]
    },
    "figureBlock": {
      "type": "object",
      "required": [
        "type",
        "format",
        "code"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "figure"
        },
        "format": {
          "const": "mermaid"
        },
        "caption": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "imageBlock": {
      "type": "object",
      "required": [
        "type",
        "path"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "image"
        },
        "path": {
          "type": "string",
          "minLength": 1
        },
        "caption": {
          "type": "string"
        },
        "alt": {
          "type": "string"
        },
        "width": {
          "type": "string"
        },
        "align": {
          "enum": [
            "left",
            "center",
            "right"
          ]
        }
      }
    },
    "codeBlock": {
      "type": "object",
      "required": [
        "type",
        "content"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "code"
        },
        "language": {
          "type": "string"
        },
        "caption": {
          "type": "string"
        },
        "content": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "noteBlock": {
      "type": "object",
      "required": [
        "type",
        "content"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "note"
        },
        "style": {
          "enum": [
            "info",
            "warning",
            "important"
          ]
        },
        "content": {
          "type": "string",
          "minLength": 1
        }
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
    page_break_before: true
    blocks:
      - type: table
        caption: "Feature information"
        row_header_cols: 1
        header: ["Item", "Value"]
        rows:
          - ["Feature ID", "STOCK-001"]
          - ["Status", "Approved"]
      - type: table
        caption: "Entity definition"
        header:
          - [{value: "Basic info", colspan: 2}, {value: "Validation", colspan: 2}]
          - ["Name", "Type", "Constraint", "Description"]
        rows:
          - ["id", "int", "auto-numbered", "Item ID"]
          - ["name", "string", "required, max 100 chars", "Item name"]
      - type: table
        caption: "Input/output parameters"
        header: ["Kind", "Name", "Type", "Description"]
        rows:
          - [{value: "Input", rowspan: 2}, "name", "string", "Item name"]
          - ["quantity", "int", "Received quantity"]
          - ["Output", "stock", "Stock", "Updated stock record"]
      - type: figure
        format: mermaid
        caption: "Screen transition diagram"
        code: |
          flowchart LR
            L[Login] --> S[Stock list]
            S --> D[Item detail]
            S --> I[Inbound registration]
      - type: note
        style: warning
        content: |
          Inbound registration requires administrator privileges.
  - title: "Non-functional Requirements"
    page_break_before: true
    blocks:
      - type: text
        content: |
          The system assumes up to 10 concurrent users.
      - type: code
        language: python
        caption: "Validation logic"
        content: |
          def validate_quantity(qty: int) -> bool:
              return qty >= 1
      - type: image
        path: "docs/mockups/list.png"
        caption: "Stock list screen mockup"
        width: "60%"
        align: center
```

## 6. Rendering contract (summary)

The generic renderer walks the tree once and, for each output format, maps:

| Element | HTML | Excel (openpyxl) |
|---|---|---|
| cover / revisions | Cover page + revision-history table before the body | Cover sheet / leading rows |
| Section | `<h1>`–`<h3>` with derived number | Bold heading row, indent by level, derived number |
| `page_break_before` | `page-break-before: always` (print CSS) | Manual page break |
| text | `<p>` per paragraph (escaped) | Wrapped text cell(s) |
| table | `<table>` with `<caption>`; `colspan`/`rowspan` attributes; multi-row `<thead>`; `row_header_cols` as `<th scope="row">` | Header-styled rows + bordered grid, `merge_cells()` for spans, header styling on row-header columns, caption above |
| list | `<ul>`/`<ol>` nested | One row per item, indented, bullet/number prefixes |
| figure | Mermaid render, numbered caption | Preformatted code block + numbered caption |
| image | Base64-embedded `<img>` (`width`/`align` respected), numbered caption | Embedded image + numbered caption |
| code | `<pre><code>` (highlight hint from `language`) | Preformatted monospace cell block |
| note | Styled callout box per `style` | Shaded cell block with a style marker |

Figure/table/image numbers are counted per document in reading order.
Templates control page frame (cover, header/footer, styles); the block
renderer controls content. Custom templates therefore override look & feel
without knowing anything about individual doc types.

## 7. Generation contract (summary)

- The per-`doc_type` prompt instructs Claude to output **only** a fenced
  ```yaml code block conforming to this spec, and prescribes the expected
  chapter outline for that type (see spec.md §6.2) — the outline is a prompt
  concern, not a schema constraint.
- Generated documents omit `cover` and `revisions` (the prompt forbids
  inventing authors/approvers); those fields are for user- or
  platform-supplied metadata.
- The backend extracts the fenced block, parses, validates (§4), retries with
  error feedback up to 2 times, and stores the raw YAML as a file at
  `{document_data_path}/tasks/{task_id}/{doc_type}_{YYYYMMDD_HHMMSS}.yaml`
  (default `backend/documents/`). Every generation is kept — the newest
  timestamp per `doc_type` is the current version.
