"""Cypher used by the lineage pages.

Every query returns nodes / relationships / paths so that the same text can be
pasted into the Query page ("Open in Query") and rendered as a graph there.
Depth values are validated integers and are inlined because variable-length
bounds cannot be parameters.
"""

from __future__ import annotations

from typing import Literal

Direction = Literal["upstream", "downstream", "both"]

COLUMN_SEARCH_LABELS = ("Table", "View", "Column", "Pipeline", "BusinessConcept")

SEARCH = """MATCH (n:Asset)
WHERE (n:Table OR n:View OR n:Column OR n:Pipeline OR n:BusinessConcept)
  AND (toLower(coalesce(n.name, '')) CONTAINS $q
       OR toLower(coalesce(n.full_name, '')) CONTAINS $q
       OR toLower(n.id) CONTAINS $q)
RETURN n
ORDER BY CASE WHEN toLower(n.name) = $q THEN 0
              WHEN toLower(n.name) STARTS WITH $q THEN 1
              ELSE 2 END, size(n.id)
LIMIT $limit"""

RESOLVE = """MATCH (n:Asset)
WHERE n.id = $ref OR n.full_name = $ref OR n.id ENDS WITH $suffix
RETURN n
ORDER BY CASE WHEN n.id = $ref THEN 0 WHEN n.full_name = $ref THEN 1 ELSE 2 END, size(n.id)
LIMIT 1"""

# For every column on a path, also return the HAS_COLUMN path to its owning table.
_OWNERS = "[x IN coalesce(nodes(p), [s]) | [h = (:Asset)-[:HAS_COLUMN]->(x) | h]] AS owners"


def _check_depth(depth: int) -> int:
    depth = int(depth)
    if not 1 <= depth <= 10:
        raise ValueError("depth must be between 1 and 10")
    return depth


def _seed_pattern(label: str) -> str | None:
    """Pattern binding `s` to the column(s) lineage starts from."""
    if label == "Column":
        return "(s:Column {id: $id})"
    if label in ("Table", "View"):
        return "(:Asset {id: $id})-[:HAS_COLUMN]->(s:Column)"
    if label == "BusinessConcept":
        return "(:BusinessConcept {id: $id})<-[:REPRESENTS]-(:Asset)-[:HAS_COLUMN]->(s:Column)"
    return None


def lineage(label: str, direction: Direction, depth: int) -> str:
    d = _check_depth(depth)
    down = direction in ("downstream", "both")
    up = direction in ("upstream", "both")
    branches = ["MATCH (start:Asset {id: $id})\nRETURN start AS s, null AS p, [] AS owners"]

    seed = _seed_pattern(label)
    if seed:
        if down:
            branches.append(
                f"MATCH {seed}\nOPTIONAL MATCH p = (s)-[:FLOWS_TO*1..{d}]->(:Column)\nRETURN s, p, {_OWNERS}"
            )
        if up:
            branches.append(
                f"MATCH {seed}\nOPTIONAL MATCH p = (:Column)-[:FLOWS_TO*1..{d}]->(s)\nRETURN s, p, {_OWNERS}"
            )
    if label in ("Table", "View"):
        if down:
            branches.append(
                f"MATCH p = (:Asset {{id: $id}})-[:FEEDS*1..{d}]->(:Asset)\nRETURN null AS s, p, [] AS owners"
            )
        if up:
            branches.append(
                f"MATCH p = (:Asset)-[:FEEDS*1..{d}]->(:Asset {{id: $id}})\nRETURN null AS s, p, [] AS owners"
            )
    if label == "BusinessConcept":
        branches.append(
            "MATCH p = (:Asset)-[:REPRESENTS]->(:BusinessConcept {id: $id})\nRETURN null AS s, p, [] AS owners"
        )
    if label == "Pipeline":
        branches.append(
            "MATCH p = (:Pipeline {id: $id})-[:CONTAINS]->(:Activity)-[:READS_FROM|WRITES_TO]->(:Asset)\n"
            "RETURN null AS s, p, [] AS owners"
        )
    if label == "Activity":
        branches.append(
            "MATCH p = (:Pipeline)-[:CONTAINS]->(:Activity {id: $id})-[:READS_FROM|WRITES_TO]->(:Asset)\n"
            "RETURN null AS s, p, [] AS owners"
        )
    return "\nUNION\n".join(branches)


def impact(label: str, depth: int) -> str:
    return lineage(label, "downstream", depth)


PII = """MATCH (src:Column)
WHERE src.is_pii = true AND NOT coalesce(src.platform, '') STARTS WITH 'Fabric'
OPTIONAL MATCH c = (src)-[:CLASSIFIED_AS]->(:Classification)
OPTIONAL MATCH f = (src)-[:FLOWS_TO]->(tgt:Column)
OPTIONAL MATCH tc = (tgt)-[:CLASSIFIED_AS]->(:Classification)
RETURN src, c, f, tc,
       [x IN [src, tgt] WHERE x IS NOT NULL | [h = (:Asset)-[:HAS_COLUMN]->(x) | h]] AS owners"""

PIPELINES = """MATCH p = (:Pipeline)-[:CONTAINS]->(a:Activity)
OPTIONAL MATCH r = (a)-[:READS_FROM|WRITES_TO|PRECEDES|INVOKES]->(:Asset)
RETURN p, r"""

CONCEPTS = """MATCH (c:BusinessConcept)
OPTIONAL MATCH p = (c)-[:RELATED_TO]->(:BusinessConcept)
RETURN c, p"""

CONCEPTS_WITH_TABLES = (
    CONCEPTS + "\nUNION\nMATCH p = (:Asset)-[:REPRESENTS]->(:BusinessConcept)\nRETURN null AS c, p"
)

NEIGHBORS_BY_ELEMENT_ID = """MATCH (n) WHERE elementId(n) = $id
OPTIONAL MATCH p = (n)-[]-()
RETURN n, p
LIMIT $limit"""

NEIGHBORS_BY_ASSET_ID = """MATCH (n:Asset {id: $id})
OPTIONAL MATCH p = (n)-[]-()
RETURN n, p
LIMIT $limit"""

SCHEMA_VISUALIZATION = "CALL db.schema.visualization()"

LABEL_COUNTS = "MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label"
REL_COUNTS = "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type"
PROPERTY_KEY_COUNTS = """CALL {
  MATCH (n) UNWIND keys(n) AS key RETURN key
  UNION ALL
  MATCH ()-[r]->() UNWIND keys(r) AS key RETURN key
}
RETURN key, count(*) AS count ORDER BY key"""
