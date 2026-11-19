"""Convert Neo4j driver values into JSON-safe structures.

Graph entities are tagged with a ``$type`` key so the frontend can render them:

* node:          {"$type": "node", "elementId", "labels", "properties"}
* relationship:  {"$type": "relationship", "elementId", "type",
                  "startNodeElementId", "endNodeElementId", "properties"}
* path:          {"$type": "path", "start", "end", "segments": [{start, relationship, end}],
                  "length"}

All nodes and relationships found anywhere in a result are also collected into
a de-duplicated ``graph`` structure by :class:`GraphCollector`.
"""

from __future__ import annotations

import base64
import datetime as _dt
import math
from decimal import Decimal
from typing import Any

from neo4j.graph import Node, Path, Relationship
from neo4j.spatial import Point
from neo4j.time import Date, DateTime, Duration, Time

_MAX_SAFE_INT = 2**53 - 1


def serialize_node(node: Node) -> dict[str, Any]:
    return {
        "$type": "node",
        "elementId": node.element_id,
        "labels": sorted(node.labels),
        "properties": {k: serialize_value(v) for k, v in node.items()},
    }


def serialize_relationship(rel: Relationship) -> dict[str, Any]:
    start, end = rel.start_node, rel.end_node
    return {
        "$type": "relationship",
        "elementId": rel.element_id,
        "type": rel.type,
        "startNodeElementId": start.element_id if start is not None else None,
        "endNodeElementId": end.element_id if end is not None else None,
        "properties": {k: serialize_value(v) for k, v in rel.items()},
    }


def serialize_path(path: Path) -> dict[str, Any]:
    segments = []
    nodes = list(path.nodes)
    for i, rel in enumerate(path.relationships):
        segments.append(
            {
                "start": serialize_node(nodes[i]),
                "relationship": serialize_relationship(rel),
                "end": serialize_node(nodes[i + 1]),
            }
        )
    return {
        "$type": "path",
        "start": serialize_node(path.start_node),
        "end": serialize_node(path.end_node),
        "segments": segments,
        "length": len(path),
    }


def serialize_point(p: Point) -> str:
    coords = ", ".join(f"{k}: {v}" for k, v in zip(("x", "y", "z"), tuple(p)))
    return f"point({{srid: {p.srid}, {coords}}})"


def serialize_value(value: Any) -> Any:  # noqa: PLR0911 - a type switch
    """Recursively convert *value* to something ``json.dumps`` accepts."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        # JavaScript cannot represent larger integers exactly.
        return value if abs(value) <= _MAX_SAFE_INT else str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return str(value)
        return value
    if isinstance(value, Node):
        return serialize_node(value)
    if isinstance(value, Relationship):
        return serialize_relationship(value)
    if isinstance(value, Path):
        return serialize_path(value)
    if isinstance(value, (DateTime, Date, Time)):
        return value.iso_format()
    if isinstance(value, Duration):
        return value.iso_format()
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, _dt.timedelta):
        return str(value)
    if isinstance(value, Point):
        return serialize_point(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, dict):
        return {str(k): serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [serialize_value(v) for v in value]
    return str(value)


class GraphCollector:
    """Collect de-duplicated nodes and relationships from arbitrary values."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.relationships: dict[str, dict[str, Any]] = {}

    def add(self, value: Any) -> None:
        if isinstance(value, Node):
            if value.element_id not in self.nodes:
                self.nodes[value.element_id] = serialize_node(value)
        elif isinstance(value, Relationship):
            if value.element_id not in self.relationships:
                self.relationships[value.element_id] = serialize_relationship(value)
            # Make sure both end points exist in the graph.
            for end in (value.start_node, value.end_node):
                if end is not None and end.element_id not in self.nodes:
                    self.nodes[end.element_id] = serialize_node(end)
        elif isinstance(value, Path):
            for n in value.nodes:
                self.add(n)
            for r in value.relationships:
                self.add(r)
        elif isinstance(value, dict):
            for v in value.values():
                self.add(v)
        elif isinstance(value, (list, tuple, set, frozenset)):
            for v in value:
                self.add(v)

    def to_dict(self) -> dict[str, list[dict[str, Any]]]:
        rels = [
            r
            for r in self.relationships.values()
            # Drop relationships whose end points we know nothing about.
            if r["startNodeElementId"] in self.nodes and r["endNodeElementId"] in self.nodes
        ]
        return {"nodes": list(self.nodes.values()), "relationships": rels}


def serialize_record(keys: list[str], values: list[Any], collector: GraphCollector) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in zip(keys, values):
        collector.add(v)
        out[k] = serialize_value(v)
    return out
