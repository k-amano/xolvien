"""Common document YAML format (v1) — schema, validation, extraction.

The normative spec is docs/document-format.md. This module holds its JSON
Schema plus the helpers the generation pipeline needs: pulling the fenced
YAML block out of a Claude response and validating the parsed document.
"""
import re
from typing import Any, List, Optional

import yaml
import jsonschema

DOC_TYPES = [
    "requirements",
    "external_design",
    "internal_design",
    "specification",
    "test_report",
]

DOCUMENT_SCHEMA: dict = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["format_version", "doc_type", "title", "language", "sections"],
    "additionalProperties": False,
    "properties": {
        "format_version": {"const": 1},
        "doc_type": {"enum": DOC_TYPES},
        "title": {"type": "string", "minLength": 1},
        "language": {"enum": ["ja", "en"]},
        "revisions": {"$ref": "#/$defs/revisions"},
        "cover": {"$ref": "#/$defs/cover"},
        "sections": {
            "type": "array",
            "minItems": 1,
            "items": {"$ref": "#/$defs/sectionL1"},
        },
    },
    "$defs": {
        "revisions": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["version", "date", "summary"],
                "additionalProperties": False,
                "properties": {
                    "version": {"type": "string"},
                    "date": {"type": "string"},
                    "author": {"type": "string"},
                    "summary": {"type": "string"},
                },
            },
        },
        "cover": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "subtitle": {"type": "string"},
                "version": {"type": "string"},
                "date": {"type": "string"},
                "organization": {"type": "string"},
                "department": {"type": "string"},
                "author": {"type": "string"},
                "reviewers": {"type": "array", "items": {"type": "string"}},
                "approver": {"type": "string"},
            },
        },
        "cellValue": {
            "oneOf": [
                {"type": ["string", "number", "boolean", "null"]},
                {
                    "type": "object",
                    "required": ["value"],
                    "additionalProperties": False,
                    "properties": {
                        "value": {"type": ["string", "number", "boolean", "null"]},
                        "colspan": {"type": "integer", "minimum": 1},
                        "rowspan": {"type": "integer", "minimum": 1},
                    },
                },
            ]
        },
        "headerRow": {
            "type": "array",
            "minItems": 1,
            "items": {"$ref": "#/$defs/cellValue"},
        },
        "sectionL1": {
            "type": "object",
            "required": ["title"],
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "page_break_before": {"type": "boolean"},
                "blocks": {"type": "array", "items": {"$ref": "#/$defs/block"}},
                "sections": {"type": "array", "items": {"$ref": "#/$defs/sectionL2"}},
            },
        },
        "sectionL2": {
            "type": "object",
            "required": ["title"],
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "page_break_before": {"type": "boolean"},
                "blocks": {"type": "array", "items": {"$ref": "#/$defs/block"}},
                "sections": {"type": "array", "items": {"$ref": "#/$defs/sectionL3"}},
            },
        },
        "sectionL3": {
            "type": "object",
            "required": ["title"],
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "page_break_before": {"type": "boolean"},
                "blocks": {"type": "array", "items": {"$ref": "#/$defs/block"}},
            },
        },
        "block": {
            "oneOf": [
                {"$ref": "#/$defs/textBlock"},
                {"$ref": "#/$defs/tableBlock"},
                {"$ref": "#/$defs/listBlock"},
                {"$ref": "#/$defs/figureBlock"},
                {"$ref": "#/$defs/imageBlock"},
                {"$ref": "#/$defs/codeBlock"},
                {"$ref": "#/$defs/noteBlock"},
            ]
        },
        "textBlock": {
            "type": "object",
            "required": ["type", "content"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "text"},
                "content": {"type": "string", "minLength": 1},
            },
        },
        "tableBlock": {
            "type": "object",
            "required": ["type", "header", "rows"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "table"},
                "caption": {"type": "string"},
                "header": {
                    "oneOf": [
                        {"type": "array", "minItems": 1, "items": {"type": "string"}},
                        {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/headerRow"}},
                    ]
                },
                "row_header_cols": {"type": "integer", "minimum": 0},
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/cellValue"},
                    },
                },
            },
        },
        "listBlock": {
            "type": "object",
            "required": ["type", "style", "items"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "list"},
                "style": {"enum": ["bullet", "number"]},
                "items": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/listItemL1"}},
            },
        },
        "listItemL1": {
            "oneOf": [
                {"type": "string"},
                {
                    "type": "object",
                    "required": ["text"],
                    "additionalProperties": False,
                    "properties": {
                        "text": {"type": "string"},
                        "children": {
                            "type": "array",
                            "minItems": 1,
                            "items": {"$ref": "#/$defs/listItemL2"},
                        },
                    },
                },
            ]
        },
        "listItemL2": {
            "oneOf": [
                {"type": "string"},
                {
                    "type": "object",
                    "required": ["text"],
                    "additionalProperties": False,
                    "properties": {
                        "text": {"type": "string"},
                        "children": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                    },
                },
            ]
        },
        "figureBlock": {
            "type": "object",
            "required": ["type", "format", "code"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "figure"},
                "format": {"const": "mermaid"},
                "caption": {"type": "string"},
                "code": {"type": "string", "minLength": 1},
            },
        },
        "imageBlock": {
            "type": "object",
            "required": ["type", "path"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "image"},
                "path": {"type": "string", "minLength": 1},
                "caption": {"type": "string"},
                "alt": {"type": "string"},
                "width": {"type": "string"},
                "align": {"enum": ["left", "center", "right"]},
            },
        },
        "codeBlock": {
            "type": "object",
            "required": ["type", "content"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "code"},
                "language": {"type": "string"},
                "caption": {"type": "string"},
                "content": {"type": "string", "minLength": 1},
            },
        },
        "noteBlock": {
            "type": "object",
            "required": ["type", "content"],
            "additionalProperties": False,
            "properties": {
                "type": {"const": "note"},
                "style": {"enum": ["info", "warning", "important"]},
                "content": {"type": "string", "minLength": 1},
            },
        },
    },
}

_validator = jsonschema.Draft202012Validator(DOCUMENT_SCHEMA)

_FENCED_YAML_RE = re.compile(r"```ya?ml\s*\n(.*?)```", re.DOTALL)


def extract_yaml_document(text: str) -> Optional[str]:
    """
    Pull the document YAML out of a Claude response.

    Takes the LAST fenced ```yaml block (agents sometimes think aloud in
    earlier blocks); falls back to the whole text when no fence is present.
    """
    matches = _FENCED_YAML_RE.findall(text)
    if matches:
        return matches[-1].strip() or None
    stripped = text.strip()
    return stripped or None


def validate_document(data: Any) -> List[str]:
    """
    Validate a parsed document against the v1 format.

    Returns a list of human-readable error strings (empty = valid). Includes
    the row-width check the JSON Schema cannot express.
    """
    errors: List[str] = []
    for err in _validator.iter_errors(data):
        path = "/".join(str(p) for p in err.absolute_path) or "(root)"
        errors.append(f"{path}: {err.message}")
        if len(errors) >= 10:  # enough signal for a retry prompt
            break

    if not errors and isinstance(data, dict):
        _check_table_widths(data.get("sections", []), "sections", errors)
    return errors


def _effective_width(row: list) -> int:
    """Number of columns a row of cells occupies (colspan-aware)."""
    total = 0
    for cell in row:
        total += cell.get("colspan", 1) if isinstance(cell, dict) else 1
    return total


def _table_column_count(header: list) -> int:
    """
    Column count of a table. For multi-row headers the LAST row is the most
    granular and defines the grid width.
    """
    if header and isinstance(header[0], list):
        return _effective_width(header[-1])
    return len(header)


def _check_table_widths(sections: list, path: str, errors: List[str]) -> None:
    # Rows may be NARROWER than the grid (rowspan continuation rows omit the
    # spanned cells); occupying MORE columns than the grid is always an error.
    for si, section in enumerate(sections):
        for bi, block in enumerate(section.get("blocks") or []):
            if block.get("type") != "table":
                continue
            width = _table_column_count(block["header"])
            for ri, row in enumerate(block["rows"]):
                if _effective_width(row) > width:
                    errors.append(
                        f"{path}/{si}/blocks/{bi}/rows/{ri}: row occupies "
                        f"{_effective_width(row)} columns (colspan included) but the "
                        f"table has {width} columns"
                    )
        _check_table_widths(section.get("sections") or [], f"{path}/{si}/sections", errors)
