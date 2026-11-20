"""A small, mode-independent graph model used by the lineage pages.

Both the live Neo4j repository and the in-memory snapshot repository produce a
:class:`SubGraph`; the lineage computations in :mod:`app.lineage` and the
conversion to the frontend "view" format only ever work with this model.

Node identity is the business ``id`` property (e.g. ``pg:bankdb.banking.loans``);
policy documents and chunks use ``doc_id`` / ``chunk_id``; anything else falls back
to the Neo4j ``elementId`` (for example the virtual nodes returned by
``db.schema.visualization``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

GENERIC_LABEL = "Asset"

# Order in which labels are preferred as the "primary" label of a node.
LABEL_PRIORITY = [
    "Column",
    "Table",
    "View",
    "Activity",
    "Pipeline",
    "Schema",
    "Database",
    "Lakehouse",
    "Warehouse",
    "BusinessConcept",
    "Classification",
    "PolicyDocument",
    "PolicyChunk",
]

# Business-key properties, in order of preference, that identify a node.
KEY_PROPERTIES = ("id", "doc_id", "chunk_id")


def node_key(props: dict[str, Any], element_id: str) -> str:
    for k in KEY_PROPERTIES:
        if props.get(k):
            return str(props[k])
    return str(element_id)


def primary_label(labels: Iterable[str]) -> str:
    labels = [lbl for lbl in labels if lbl != GENERIC_LABEL] or list(labels)
    for lbl in LABEL_PRIORITY:
        if lbl in labels:
            return lbl
    return sorted(labels)[0] if labels else "Node"


@dataclass
class GNode:
    id: str
    labels: list[str]
    props: dict[str, Any] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return primary_label(self.labels)

    @property
    def name(self) -> str:
        p = self.props
        return str(p.get("name") or p.get("title") or p.get("heading") or self.id)

    def has(self, label: str) -> bool:
        return label in self.labels


@dataclass
class GEdge:
    key: str
    source: str
    target: str
    type: str
    props: dict[str, Any] = field(default_factory=dict)


class SubGraph:
    def __init__(self) -> None:
        self.nodes: dict[str, GNode] = {}
        self.edges: dict[str, GEdge] = {}

    def add_node(self, node: GNode) -> None:
        if node.id not in self.nodes:
            self.nodes[node.id] = node

    def add_edge(self, edge: GEdge) -> None:
        if edge.key not in self.edges:
            self.edges[edge.key] = edge

    def merge(self, other: "SubGraph") -> None:
        for n in other.nodes.values():
            self.add_node(n)
        for e in other.edges.values():
            self.add_edge(e)

    def edges_of(self, *types: str) -> list[GEdge]:
        return [e for e in self.edges.values() if not types or e.type in types]

    def owner_map(self) -> dict[str, str]:
        """Column id -> owning table/view id, from HAS_COLUMN edges."""
        return {e.target: e.source for e in self.edges.values() if e.type == "HAS_COLUMN"}


def from_neo4j_graph(graph: dict[str, list[dict[str, Any]]]) -> SubGraph:
    """Build a :class:`SubGraph` from the serialised ``graph`` of a query result."""
    sub = SubGraph()
    eid_to_key: dict[str, str] = {}
    for n in graph.get("nodes", []):
        props = n.get("properties", {})
        key = node_key(props, n["elementId"])
        eid_to_key[n["elementId"]] = key
        sub.add_node(GNode(id=key, labels=list(n.get("labels", [])), props=props))
    for r in graph.get("relationships", []):
        s = eid_to_key.get(r["startNodeElementId"])
        t = eid_to_key.get(r["endNodeElementId"])
        if s is None or t is None:
            continue
        sub.add_edge(GEdge(key=r["elementId"], source=s, target=t, type=r["type"], props=r.get("properties", {})))
    return sub


# ---------------------------------------------------------------------------
# View format (what the frontend graph component consumes)
# ---------------------------------------------------------------------------


def node_caption(node: GNode) -> tuple[str, str | None]:
    p = node.props
    lbl = node.label
    if lbl == "Column":
        return str(p.get("name") or node.id), p.get("table")
    if lbl in ("Table", "View"):
        return str(p.get("full_name") or p.get("name") or node.id), p.get("platform")
    if lbl == "Activity":
        return str(p.get("name") or node.id), p.get("activity_type") or p.get("pipeline")
    if lbl in ("Pipeline", "Lakehouse", "Warehouse", "Database"):
        return str(p.get("name") or node.id), p.get("platform")
    if lbl == "PolicyDocument":
        return str(p.get("title") or p.get("doc_id") or node.id), "Policy document"
    if lbl == "PolicyChunk":
        return str(p.get("heading") or p.get("chunk_id") or node.id), "Policy section"
    return str(p.get("name") or node.id), None


def node_view(node: GNode, start_ids: set[str] | None = None, role: str | None = None) -> dict[str, Any]:
    caption, subtitle = node_caption(node)
    return {
        "id": node.id,
        "labels": [lbl for lbl in node.labels if lbl != GENERIC_LABEL] or node.labels,
        "label": node.label,
        "caption": caption,
        "subtitle": subtitle,
        "properties": node.props,
        "start": bool(start_ids and node.id in start_ids),
        "pii": bool(node.props.get("is_pii")),
        **({"role": role} if role else {}),
    }


def edge_label(edge: GEdge) -> str:
    if edge.type == "FLOWS_TO":
        return str(edge.props.get("label") or edge.props.get("transformation") or "FLOWS_TO")
    return edge.type


def edge_view(edge: GEdge, reverse_reads: bool = True) -> dict[str, Any]:
    source, target, reversed_ = edge.source, edge.target, False
    # READS_FROM is stored activity -> table; draw it table -> activity so arrows follow the data.
    if reverse_reads and edge.type == "READS_FROM":
        source, target, reversed_ = target, source, True
    return {
        "id": edge.key,
        "source": source,
        "target": target,
        "type": edge.type,
        "label": edge_label(edge),
        "properties": edge.props,
        "reversed": reversed_,
    }


def to_view(
    sub: SubGraph,
    start_ids: set[str] | None = None,
    reverse_reads: bool = True,
) -> dict[str, list[dict[str, Any]]]:
    nodes = [node_view(n, start_ids) for n in sub.nodes.values()]
    edges = [
        edge_view(e, reverse_reads)
        for e in sub.edges.values()
        if e.source in sub.nodes and e.target in sub.nodes
    ]
    return {"nodes": nodes, "edges": edges}


def to_neo4j_format(sub: SubGraph) -> dict[str, list[dict[str, Any]]]:
    """Render a SubGraph in the same shape as a serialised query result graph."""
    return {
        "nodes": [
            {"$type": "node", "elementId": n.id, "labels": n.labels, "properties": n.props}
            for n in sub.nodes.values()
        ],
        "relationships": [
            {
                "$type": "relationship",
                "elementId": e.key,
                "type": e.type,
                "startNodeElementId": e.source,
                "endNodeElementId": e.target,
                "properties": e.props,
            }
            for e in sub.edges.values()
            if e.source in sub.nodes and e.target in sub.nodes
        ],
    }
