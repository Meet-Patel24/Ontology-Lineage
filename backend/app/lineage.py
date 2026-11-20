"""Mode-independent lineage computations on a :class:`SubGraph`."""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

from .graphmodel import GEdge, GNode, SubGraph

# When several transformations are rolled up into one table-level edge, the
# edge is coloured by the most "interesting" one.
TRANSFORMATION_PRIORITY = ["MASKED", "AGGREGATED", "DERIVED", "CAST", "DIRECT"]
FABRIC_PREFIX = "Fabric"


def dominant_transformation(values: set[str]) -> str | None:
    for t in TRANSFORMATION_PRIORITY:
        if t in values:
            return t
    return next(iter(sorted(values)), None)


def seed_columns(sub: SubGraph, start: GNode) -> set[str]:
    """Columns lineage starts from for a given start node."""
    if start.label == "Column":
        return {start.id}
    if start.label in ("Table", "View"):
        return {e.target for e in sub.edges_of("HAS_COLUMN") if e.source == start.id}
    if start.label == "BusinessConcept":
        tables = {e.source for e in sub.edges_of("REPRESENTS") if e.target == start.id}
        return {e.target for e in sub.edges_of("HAS_COLUMN") if e.source in tables}
    return set()


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

STRUCTURAL_TYPES = {"FEEDS", "REPRESENTS", "CONTAINS", "READS_FROM", "WRITES_TO", "PRECEDES", "INVOKES"}


def column_level(sub: SubGraph, start: GNode) -> SubGraph:
    """Columns + FLOWS_TO; keeps a non-column start node with its HAS_COLUMN edges."""
    out = SubGraph()
    for n in sub.nodes.values():
        if n.label == "Column" or n.id == start.id:
            out.add_node(n)
    for e in sub.edges.values():
        if e.type == "FLOWS_TO":
            out.add_edge(e)
        elif e.type == "HAS_COLUMN" and e.source == start.id:
            out.add_edge(e)
        elif e.type in STRUCTURAL_TYPES and e.source in sub.nodes and e.target in sub.nodes:
            out.add_node(sub.nodes[e.source])
            out.add_node(sub.nodes[e.target])
            out.add_edge(e)
    return out


def table_level(sub: SubGraph, start: GNode) -> tuple[SubGraph, set[str]]:
    """Roll column FLOWS_TO edges up to table -> table edges.

    Returns the new graph and the ids to highlight as start nodes.
    """
    owners = sub.owner_map()
    out = SubGraph()
    for n in sub.nodes.values():
        if n.label not in ("Column", "PolicyChunk"):  # policy sections are collapsed into GOVERNS edges
            out.add_node(n)

    grouped: dict[tuple[str, str], list[GEdge]] = defaultdict(list)
    for e in sub.edges_of("FLOWS_TO"):
        s, t = owners.get(e.source), owners.get(e.target)
        if s and t and s != t:
            grouped[(s, t)].append(e)
    for (s, t), edges in grouped.items():
        transformations = {str(e.props.get("transformation") or "DIRECT") for e in edges}
        pipelines = sorted({str(e.props["pipeline"]) for e in edges if e.props.get("pipeline")})
        activities = sorted({str(e.props["activity"]) for e in edges if e.props.get("activity")})
        dominant = dominant_transformation(transformations)
        out.add_edge(
            GEdge(
                key=f"tbl:{s}->{t}",
                source=s,
                target=t,
                type="FLOWS_TO",
                props={
                    "transformation": dominant,
                    "transformations": sorted(transformations),
                    "label": " / ".join(t_ for t_ in TRANSFORMATION_PRIORITY if t_ in transformations),
                    "pipelines": pipelines,
                    "activities": activities,
                    "column_flows": [
                        {
                            "from": _col_name(sub, e.source),
                            "to": _col_name(sub, e.target),
                            "transformation": e.props.get("transformation"),
                            "expression": e.props.get("expression"),
                        }
                        for e in edges
                    ],
                    "count": len(edges),
                },
            )
        )
    for e in sub.edges.values():
        if e.type in STRUCTURAL_TYPES and e.source in out.nodes and e.target in out.nodes:
            out.add_edge(e)

    start_ids = {start.id}
    if start.label == "Column" and start.id in owners:
        start_ids.add(owners[start.id])
    # Drop the start column itself from the table view; highlight its table instead.
    if start.label == "Column":
        out.nodes.pop(start.id, None)
    return out, start_ids


def _col_name(sub: SubGraph, col_id: str) -> str:
    n = sub.nodes.get(col_id)
    if not n:
        return col_id
    table = n.props.get("table")
    return f"{table}.{n.name}" if table else n.name


# ---------------------------------------------------------------------------
# Impact analysis
# ---------------------------------------------------------------------------


def impact(sub: SubGraph, start: GNode) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Rows describing every downstream column flow, plus a summary."""
    owners = sub.owner_map()
    seeds = seed_columns(sub, start)
    out_edges: dict[str, list[GEdge]] = defaultdict(list)
    for e in sub.edges_of("FLOWS_TO"):
        out_edges[e.source].append(e)

    rows: list[dict[str, Any]] = []
    seen_edges: set[str] = set()
    dist: dict[str, int] = {s: 0 for s in seeds}
    queue = deque(seeds)
    while queue:
        cur = queue.popleft()
        for e in out_edges.get(cur, []):
            if e.key in seen_edges:
                continue
            seen_edges.add(e.key)
            tgt = sub.nodes.get(e.target)
            src = sub.nodes.get(e.source)
            rows.append(
                {
                    "depth": dist[cur] + 1,
                    "source_table": _table_name(sub, owners.get(e.source)) or (src.props.get("table") if src else None),
                    "source_column": src.name if src else e.source,
                    "target_table": _table_name(sub, owners.get(e.target)) or (tgt.props.get("table") if tgt else None),
                    "target_column": tgt.name if tgt else e.target,
                    "target_id": e.target,
                    "target_platform": (tgt.props.get("platform") if tgt else None),
                    "transformation": e.props.get("transformation"),
                    "expression": e.props.get("expression"),
                    "pipeline": e.props.get("pipeline"),
                    "activity": e.props.get("activity"),
                }
            )
            if e.target not in dist:
                dist[e.target] = dist[cur] + 1
                queue.append(e.target)

    impacted_columns = {r["target_id"] for r in rows} - seeds
    start_tables = {owners.get(s) for s in seeds} | {start.id}
    impacted_tables = {owners[c] for c in impacted_columns if c in owners} - start_tables
    # Views fed (directly or indirectly) by the start table.
    for e in sub.edges_of("FEEDS"):
        if e.target not in start_tables:
            impacted_tables.add(e.target)
    pipelines = {r["pipeline"] for r in rows if r["pipeline"]}
    transformations: dict[str, int] = defaultdict(int)
    for r in rows:
        transformations[str(r["transformation"] or "DIRECT")] += 1

    summary = {
        "tables": len(impacted_tables),
        "columns": len(impacted_columns),
        "pipelines": len(pipelines),
        "table_names": sorted(_table_name(sub, t) or t for t in impacted_tables),
        "pipeline_names": sorted(pipelines),
        "transformations": dict(sorted(transformations.items())),
        "sentence": (
            f"A change here affects {_plural(len(impacted_tables), 'table')}, "
            f"{_plural(len(impacted_columns), 'column')} and {_plural(len(pipelines), 'pipeline')}."
        ),
    }
    rows.sort(key=lambda r: (r["depth"], r["target_table"] or "", r["target_column"]))
    return rows, summary


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _table_name(sub: SubGraph, table_id: str | None) -> str | None:
    if not table_id:
        return None
    t = sub.nodes.get(table_id)
    if not t:
        return table_id
    return str(t.props.get("full_name") or t.name)


# ---------------------------------------------------------------------------
# PII tracker
# ---------------------------------------------------------------------------


def _is_fabric(sub: SubGraph, col: GNode | None, owners: dict[str, str]) -> bool:
    if col is None:
        return False
    platform = col.props.get("platform")
    if not platform and col.id in owners and owners[col.id] in sub.nodes:
        platform = sub.nodes[owners[col.id]].props.get("platform")
    return str(platform or "").startswith(FABRIC_PREFIX)


def pii(sub: SubGraph) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    owners = sub.owner_map()
    classifications: dict[str, list[str]] = defaultdict(list)
    for e in sub.edges_of("CLASSIFIED_AS"):
        c = sub.nodes.get(e.target)
        classifications[e.source].append(c.name if c else e.target)

    flows: dict[str, list[GEdge]] = defaultdict(list)
    for e in sub.edges_of("FLOWS_TO"):
        flows[e.source].append(e)

    sources = [
        n
        for n in sub.nodes.values()
        if n.label == "Column" and n.props.get("is_pii") is True and not _is_fabric(sub, n, owners)
    ]
    rows: list[dict[str, Any]] = []
    for src in sorted(sources, key=lambda n: (str(n.props.get("table")), n.name)):
        base = {
            "source_id": src.id,
            "source_table": _table_name(sub, owners.get(src.id)) or src.props.get("table"),
            "source_column": src.name,
            "classification": ", ".join(sorted(classifications.get(src.id, []))) or "PII",
            "comment": src.props.get("comment"),
        }
        out = flows.get(src.id, [])
        if not out:
            rows.append({**base, "treatment": None, "target_id": None, "target_table": None,
                         "target_column": None, "target_platform": None, "pipeline": None,
                         "activity": None, "expression": None, "status": "NOT MOVED"})
            continue
        for e in out:
            tgt = sub.nodes.get(e.target)
            transformation = str(e.props.get("transformation") or "DIRECT")
            violation = transformation in ("DIRECT", "CAST") and _is_fabric(sub, tgt, owners)
            rows.append(
                {
                    **base,
                    "treatment": transformation,
                    "target_id": e.target,
                    "target_table": _table_name(sub, owners.get(e.target)) or (tgt.props.get("table") if tgt else None),
                    "target_column": tgt.name if tgt else e.target,
                    "target_platform": tgt.props.get("platform") if tgt else None,
                    "target_classification": ", ".join(sorted(classifications.get(e.target, []))) or None,
                    "pipeline": e.props.get("pipeline"),
                    "activity": e.props.get("activity"),
                    "expression": e.props.get("expression"),
                    "status": "VIOLATION" if violation else "OK",
                }
            )
    summary = {
        "pii_columns": len(sources),
        "masked_flows": sum(1 for r in rows if r["treatment"] == "MASKED"),
        "flows": sum(1 for r in rows if r["treatment"]),
        "violations": sum(1 for r in rows if r["status"] == "VIOLATION"),
        "not_moved": sum(1 for r in rows if r["status"] == "NOT MOVED"),
        "ok": sum(1 for r in rows if r["status"] == "OK"),
    }
    return rows, summary


# ---------------------------------------------------------------------------
# Pipelines
# ---------------------------------------------------------------------------


def pipelines(sub: SubGraph) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    pipeline_of: dict[str, str] = {}
    for e in sub.edges_of("CONTAINS"):
        pipeline_of[e.target] = e.source
    reads: dict[str, list[str]] = defaultdict(list)
    writes: dict[str, list[str]] = defaultdict(list)
    precedes: dict[str, list[str]] = defaultdict(list)
    for e in sub.edges_of("READS_FROM", "WRITES_TO", "PRECEDES", "INVOKES"):
        tgt = sub.nodes.get(e.target)
        name = (str(tgt.props.get("full_name") or tgt.name) if tgt else e.target)
        {"READS_FROM": reads, "WRITES_TO": writes}.get(e.type, precedes)[e.source].append(name)

    rows = []
    for act_id, pl_id in pipeline_of.items():
        act, pl = sub.nodes.get(act_id), sub.nodes.get(pl_id)
        if act is None:
            continue
        rows.append(
            {
                "pipeline": pl.name if pl else pl_id,
                "pipeline_id": pl_id,
                "activity": act.name,
                "activity_id": act_id,
                "activity_type": act.props.get("activity_type"),
                "reads_from": sorted(reads.get(act_id, [])),
                "writes_to": sorted(writes.get(act_id, [])),
                "next": sorted(precedes.get(act_id, [])),
                "query": act.props.get("query"),
                "pre_copy_script": act.props.get("pre_copy_script"),
            }
        )
    rows.sort(key=lambda r: (r["pipeline"], r["activity"]))
    summary = {
        "pipelines": len({r["pipeline_id"] for r in rows}),
        "activities": len(rows),
        "sources": len({s for r in rows for s in r["reads_from"]}),
        "targets": len({s for r in rows for s in r["writes_to"]}),
    }
    return rows, summary


# ---------------------------------------------------------------------------
# Governing policies
# ---------------------------------------------------------------------------

POLICY_LABEL = "PolicyDocument"


def attach_policies(
    view: SubGraph,
    policies: SubGraph,
    owners: dict[str, str] | None = None,
    only_doc: str | None = None,
) -> int:
    """Add the policy documents that govern assets shown in ``view``.

    ``policies`` holds ``(PolicyDocument)-[:HAS_CHUNK]->(PolicyChunk)-[:GOVERNS]->(asset)`` paths.
    Chunks are collapsed: one ``GOVERNS`` edge per (document, asset) carrying the governing
    section headings. With ``owners`` (column -> table), a governed column is rolled up to its
    table whenever that table is shown, which keeps the graph readable; the column names are
    kept on the edge.
    Returns the number of policy documents added.
    """
    owners = owners or {}
    doc_of_chunk = {e.target: e.source for e in policies.edges_of("HAS_CHUNK")}
    grouped: dict[tuple[str, str], list[GEdge]] = defaultdict(list)
    for e in policies.edges_of("GOVERNS"):
        doc = doc_of_chunk.get(e.source)
        if doc is None or (only_doc is not None and doc != only_doc):
            continue
        owner = owners.get(e.target)
        target = owner if owner in view.nodes else e.target
        if target not in view.nodes:
            continue
        grouped[(doc, target)].append(e)

    docs: set[str] = set()
    for (doc, target), edges in grouped.items():
        if doc not in view.nodes:
            view.add_node(policies.nodes[doc])
        docs.add(doc)
        sections = sorted({_heading(policies, e.source) for e in edges})
        columns = sorted({_col_name(policies, e.target) for e in edges if e.target != target})
        scores = [float(e.props["score"]) for e in edges if isinstance(e.props.get("score"), (int, float))]
        view.add_edge(
            GEdge(
                key=f"gov:{doc}->{target}",
                source=doc,
                target=target,
                type="GOVERNS",
                props={
                    "policy": policies.nodes[doc].props.get("title"),
                    "sections": sections,
                    **({"columns": columns} if columns else {}),
                    **({"score": round(max(scores), 4)} if scores else {}),
                    "method": edges[0].props.get("method"),
                    "label": "GOVERNS",
                },
            )
        )
    return len(docs)


def _heading(sub: SubGraph, chunk_id: str) -> str:
    n = sub.nodes.get(chunk_id)
    return str((n.props.get("heading") or n.props.get("section_path")) if n else chunk_id)
