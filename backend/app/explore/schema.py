"""Runtime schema discovery (nothing about labels/types/properties is hard-coded).

The discovered :class:`GraphSchema` is the whitelist that every label,
relationship type and property key coming from the browser is checked against
before it is placed into Cypher.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

GENERIC_LABEL = "Asset"

SCHEMA_TTL_SECONDS = 300

LABEL_COUNTS = "MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count"
REL_COUNTS = "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count"
VISUALIZATION = "CALL db.schema.visualization()"
NODE_PROPS = (
    "CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes "
    "RETURN nodeLabels, propertyName, propertyTypes"
)
REL_PROPS = (
    "CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes "
    "RETURN relType, propertyName, propertyTypes"
)
FULLTEXT = "SHOW FULLTEXT INDEXES YIELD name, entityType, labelsOrTypes, properties, state RETURN *"


@dataclass
class GraphSchema:
    labels: dict[str, int] = field(default_factory=dict)
    rel_types: dict[str, int] = field(default_factory=dict)
    # (start label, relationship type, end label)
    patterns: set[tuple[str, str, str]] = field(default_factory=set)
    # label -> property -> list of type names
    node_props: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    rel_props: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    fulltext_indexes: list[dict[str, Any]] = field(default_factory=list)
    discovered_at: float = 0.0

    # -- validation ----------------------------------------------------------

    def has_label(self, name: str) -> bool:
        return name in self.labels

    def has_rel(self, name: str) -> bool:
        return name in self.rel_types

    def all_node_props(self) -> set[str]:
        return {p for props in self.node_props.values() for p in props}

    def has_node_prop(self, key: str, label: str | None = None) -> bool:
        if label is None:
            return key in self.all_node_props()
        return key in self.node_props.get(label, {})

    def is_scalar_prop(self, label: str | None, key: str) -> bool:
        types = (self.node_props.get(label, {}) if label else {}).get(key)
        if types is None:
            types = [t for props in self.node_props.values() for t in props.get(key, [])]
        return not any(t.upper().startswith("LIST") for t in types)

    # -- navigation (used by suggestions) -------------------------------------

    def rels_for_label(self, label: str | None) -> list[tuple[str, str]]:
        """(relationship type, direction) pairs that touch `label` (any label if None)."""
        out: set[tuple[str, str]] = set()
        for s, t, e in self.patterns:
            if label is None:
                out.add((t, "out"))
                continue
            if s == label:
                out.add((t, "out"))
            if e == label:
                out.add((t, "in"))
        return sorted(out)

    def end_labels(self, start: str | None, rel: str, direction: str) -> list[str]:
        out: set[str] = set()
        for s, t, e in self.patterns:
            if t != rel:
                continue
            if direction in ("out", "both") and (start is None or s == start):
                out.add(e)
            if direction in ("in", "both") and (start is None or e == start):
                out.add(s)
        return sorted(out)

    def to_dict(self) -> dict[str, Any]:
        rel_pairs: dict[str, list[dict[str, str]]] = {}
        for s, t, e in sorted(self.patterns):
            rel_pairs.setdefault(t, []).append({"start": s, "end": e})
        return {
            "labels": [{"name": k, "count": v} for k, v in sorted(self.labels.items())],
            "relationship_types": [
                {"name": k, "count": v, "pairs": rel_pairs.get(k, [])} for k, v in sorted(self.rel_types.items())
            ],
            "node_properties": {lbl: [{"name": k, "types": v} for k, v in sorted(p.items())] for lbl, p in sorted(self.node_props.items())},
            "relationship_properties": {
                t: [{"name": k, "types": v} for k, v in sorted(p.items())] for t, p in sorted(self.rel_props.items())
            },
            "fulltext_indexes": self.fulltext_indexes,
            "discovered_at": self.discovered_at,
        }


def _strip_rel_type(raw: str) -> str:
    # db.schema.relTypeProperties returns ":`FLOWS_TO`"
    raw = raw.lstrip(":")
    if raw.startswith("`") and raw.endswith("`"):
        raw = raw[1:-1].replace("``", "`")
    return raw


def discover(run: Callable[[str], Any]) -> GraphSchema:
    """Build the schema. `run(query)` returns a QueryResult (records + graph)."""
    sch = GraphSchema()
    for r in run(LABEL_COUNTS).records:
        sch.labels[r["label"]] = r["count"]
    for r in run(REL_COUNTS).records:
        sch.rel_types[r["type"]] = r["count"]

    viz = run(VISUALIZATION).graph
    name_of = {n["elementId"]: str(n["properties"].get("name") or (n["labels"] or [""])[0]) for n in viz["nodes"]}
    for rel in viz["relationships"]:
        s, e = name_of.get(rel["startNodeElementId"]), name_of.get(rel["endNodeElementId"])
        if s and e:
            sch.patterns.add((s, rel["type"], e))

    for r in run(NODE_PROPS).records:
        name = r["propertyName"]
        if not name:
            continue
        for lbl in r["nodeLabels"] or []:
            sch.node_props.setdefault(lbl, {})[name] = list(r["propertyTypes"] or [])
    for lbl in sch.labels:
        sch.node_props.setdefault(lbl, {})

    for r in run(REL_PROPS).records:
        t = _strip_rel_type(r["relType"] or "")
        sch.rel_props.setdefault(t, {})
        if r["propertyName"]:
            sch.rel_props[t][r["propertyName"]] = list(r["propertyTypes"] or [])

    try:
        for r in run(FULLTEXT).records:
            if r.get("state") == "ONLINE" and r.get("entityType") == "NODE":
                sch.fulltext_indexes.append(
                    {"name": r["name"], "labels": r["labelsOrTypes"], "properties": r["properties"]}
                )
    except Exception:  # noqa: BLE001 - SHOW may be unavailable to the user; full-text is optional
        pass

    sch.discovered_at = time.time()
    return sch


class SchemaCache:
    def __init__(self, loader: Callable[[], GraphSchema], ttl: float = SCHEMA_TTL_SECONDS):
        self._loader = loader
        self._ttl = ttl
        self._schema: GraphSchema | None = None
        self._lock = threading.Lock()

    def get(self, refresh: bool = False) -> GraphSchema:
        with self._lock:
            stale = self._schema is None or time.time() - self._schema.discovered_at > self._ttl
            if refresh or stale:
                self._schema = self._loader()
            return self._schema  # type: ignore[return-value]

    def set(self, schema: GraphSchema) -> None:
        with self._lock:
            self._schema = schema
