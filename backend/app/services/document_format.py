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

_SECTION_L3 = {
    "type": "object",
    "required": ["title"],
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string", "minLength": 1},
        "blocks": {"type": "array", "items": {"$ref": "#/$defs/block"}},
    },
}

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
        "sections": {
            "type": "array",
            "minItems": 1,
            "items": {"$ref": "#/$defs/sectionL1"},
        },
    },
    "$defs": {
        "sectionL1": {
            "type": "object",
            "required": ["title"],
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string", "minLength": 1},
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
                "blocks": {"type": "array", "items": {"$ref": "#/$defs/block"}},
                "sections": {"type": "array", "items": {"$ref": "#/$defs/sectionL3"}},
            },
        },
        "sectionL3": _SECTION_L3,
        "block": {
            "oneOf": [
                {"$ref": "#/$defs/textBlock"},
                {"$ref": "#/$defs/tableBlock"},
                {"$ref": "#/$defs/listBlock"},
                {"$ref": "#/$defs/figureBlock"},
                {"$ref": "#/$defs/imageBlock"},
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
                "header": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"type": ["string", "number", "boolean", "null"]},
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


def _check_table_widths(sections: list, path: str, errors: List[str]) -> None:
    for si, section in enumerate(sections):
        for bi, block in enumerate(section.get("blocks") or []):
            if block.get("type") != "table":
                continue
            width = len(block["header"])
            for ri, row in enumerate(block["rows"]):
                if len(row) > width:
                    errors.append(
                        f"{path}/{si}/blocks/{bi}/rows/{ri}: row has {len(row)} cells "
                        f"but the header defines {width} columns"
                    )
        _check_table_widths(section.get("sections") or [], f"{path}/{si}/sections", errors)
