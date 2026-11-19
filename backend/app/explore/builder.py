"""Turn search-bar tokens into parameterised, read-only Cypher.

Grammar (left to right)::

    search  := text | phrase | chain
    chain   := node (rel node){0,4}
    node    := [label] (property [value])*
    rel     := relationship type with a direction (out | in | both)

Labels, relationship types and property keys are only inserted after an exact
match against the discovered :class:`GraphSchema` and are always back-tick
quoted. Values are always passed as parameters.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from .schema import GraphSchema

MAX_HOPS = 4
HARD_MAX_LIMIT = 2000
TEXT_SEARCH_KEYS = ["name", "full_name", "table", "title", "text", "heading", "id"]

TokenKind = Literal["label", "rel", "property", "value", "text", "phrase"]
Direction = Literal["out", "in", "both"]


class Token(BaseModel):
    kind: TokenKind
    value: str = Field(default="", max_length=500)
    direction: Direction = "out"
    params: dict[str, Any] = Field(default_factory=dict)


class SearchError(ValueError):
    """Invalid token sequence or an identifier that is not in the schema."""


def quote(identifier: str) -> str:
    """Back-tick quote an identifier (only ever called on schema-validated names)."""
    return "`" + identifier.replace("`", "``") + "`"


@dataclass
class _Node:
    label: str | None = None
    filters: list[list[Any]] = field(default_factory=list)  # [key, value | None]


@dataclass
class BuiltQuery:
    kind: Literal["nodes", "paths", "text"]
    cypher: str
    params: dict[str, Any]


def _rel_pattern(var: str, rel_type: str, direction: str) -> str:
    body = f"[{var}:{quote(rel_type)}]"
    if direction == "in":
        return f"<-{body}-"
    if direction == "both":
        return f"-{body}-"
    return f"-{body}->"


def parse_chain(tokens: list[Token], schema: GraphSchema) -> tuple[list[_Node], list[Token]]:
    nodes = [_Node()]
    rels: list[Token] = []
    for t in tokens:
        cur = nodes[-1]
        if t.kind == "label":
            if not schema.has_label(t.value):
                raise SearchError(f"Unknown label '{t.value}'.")
            if cur.label is not None or cur.filters:
                raise SearchError("Two labels in a row: add a relationship between them.")
            cur.label = t.value
        elif t.kind == "property":
            if not schema.has_node_prop(t.value, cur.label):
                where = f" on :{cur.label}" if cur.label else ""
                raise SearchError(f"Unknown property '{t.value}'{where}.")
            cur.filters.append([t.value, None])
        elif t.kind == "value":
            if not cur.filters or cur.filters[-1][1] is not None:
                raise SearchError("A value must follow a property.")
            cur.filters[-1][1] = t.value
        elif t.kind == "rel":
            if not schema.has_rel(t.value):
                raise SearchError(f"Unknown relationship type '{t.value}'.")
            if len(rels) >= MAX_HOPS:
                raise SearchError(f"At most {MAX_HOPS} relationships can be chained.")
            rels.append(t)
            nodes.append(_Node())
        else:
            raise SearchError(f"'{t.kind}' tokens must be used on their own.")
    return nodes, rels


def chain_pattern(
    nodes: list[_Node],
    rels: list[Token],
    params: dict[str, Any],
    skip: tuple[int, int] | None = None,
) -> tuple[str, list[str]]:
    """MATCH pattern + WHERE conditions for a parsed chain.

    Filter values are added to `params`. `skip=(node index, filter index)` leaves
    one filter out (used to suggest / diagnose values for it).
    """
    where: list[str] = []
    parts: list[str] = []
    for i, node in enumerate(nodes):
        var = f"n{i}"
        parts.append(f"({var}{':' + quote(node.label) if node.label else ''})")
        for j, (key, value) in enumerate(node.filters):
            if skip == (i, j):
                continue
            prop = f"{var}.{quote(key)}"
            if value is None:
                where.append(f"{prop} IS NOT NULL")
            else:
                pname = f"v{i}_{j}"
                params[pname] = str(value)
                where.append(f"toLower(toString({prop})) = toLower(${pname})")
        if i < len(rels):
            parts.append(_rel_pattern(f"r{i}", rels[i].value, rels[i].direction))
    return "".join(parts), where


def chain_values_query(tokens: list[Token], schema: GraphSchema, limit: int = 10) -> tuple[str, dict[str, Any]]:
    """Values for the property being typed, restricted by the whole token chain.

    `tokens` must end with a property token. E.g. View <-FEEDS- Table name → only
    names of tables that really FEED a View.
    """
    if not tokens or tokens[-1].kind != "property":
        raise SearchError("Value suggestions need a property token at the end.")
    nodes, rels = parse_chain(tokens, schema)
    i, j = len(nodes) - 1, len(nodes[-1].filters) - 1
    key = nodes[i].filters[j][0]
    params: dict[str, Any] = {"limit": limit}
    pattern, where = chain_pattern(nodes, rels, params, skip=(i, j))
    prop = f"n{i}.{quote(key)}"
    where += [f"{prop} IS NOT NULL", f"toLower(toString({prop})) CONTAINS toLower($q)"]
    cypher = (
        f"MATCH {pattern}\nWHERE {' AND '.join(where)}\n"
        f"WITH DISTINCT {prop} AS value\n"
        "RETURN value ORDER BY CASE WHEN toLower(toString(value)) STARTS WITH toLower($q) THEN 0 ELSE 1 END, "
        "size(toString(value))\nLIMIT $limit"
    )
    return cypher, params


def build_search(tokens: list[Token], schema: GraphSchema, limit: int) -> BuiltQuery:
    if not tokens:
        raise SearchError("Nothing to search: type a label, e.g. PolicyChunk, and press Enter.")
    limit = max(1, min(int(limit), HARD_MAX_LIMIT))

    if any(t.kind in ("text", "phrase") for t in tokens):
        if len(tokens) != 1:
            raise SearchError("Free text and search phrases cannot be combined with other tokens.")
        if tokens[0].kind == "text":
            return build_text_search(tokens[0].value, schema, limit)
        raise SearchError("Run search phrases through /phrases/{id}/run.")

    nodes, rels = parse_chain(tokens, schema)
    if not rels and nodes[0].label is None and not nodes[0].filters:
        raise SearchError("Nothing to search.")

    params: dict[str, Any] = {"limit": limit + 1}
    pattern, where = chain_pattern(nodes, rels, params)
    where_sql = f"\nWHERE {' AND '.join(where)}" if where else ""
    if rels:
        cypher = f"MATCH p = {pattern}{where_sql}\nRETURN p\nLIMIT $limit"
        return BuiltQuery("paths", cypher, params)
    cypher = f"MATCH {pattern}{where_sql}\nRETURN n0\nLIMIT $limit"
    return BuiltQuery("nodes", cypher, params)


_LUCENE_SPECIAL = re.compile(r'([+\-&|!(){}\[\]^"~*?:\\/])')


def build_text_search(text: str, schema: GraphSchema, limit: int) -> BuiltQuery:
    text = text.strip()
    if not text:
        raise SearchError("Empty search text.")
    limit = max(1, min(int(limit), HARD_MAX_LIMIT))
    if schema.fulltext_indexes:
        idx = schema.fulltext_indexes[0]["name"]
        escaped = _LUCENE_SPECIAL.sub(r"\\\1", text)
        return BuiltQuery(
            "text",
            "CALL db.index.fulltext.queryNodes($index, $q) YIELD node, score\nRETURN node AS n0\nLIMIT $limit",
            {"index": idx, "q": f"{escaped}*", "limit": limit + 1},
        )
    keys = [k for k in TEXT_SEARCH_KEYS if schema.has_node_prop(k)] or ["name"]
    return BuiltQuery(
        "text",
        "MATCH (n0)\nWHERE any(k IN $keys WHERE n0[k] IS NOT NULL AND toLower(toString(n0[k])) CONTAINS toLower($q))\n"
        "RETURN n0\nLIMIT $limit",
        {"keys": keys, "q": text, "limit": limit + 1},
    )


def build_expand(schema: GraphSchema, rel_types: list[str] | None, direction: str) -> str:
    rel = ""
    if rel_types:
        for t in rel_types:
            if not schema.has_rel(t):
                raise SearchError(f"Unknown relationship type '{t}'.")
        rel = ":" + "|".join(quote(t) for t in rel_types)
    body = f"[r{rel}]"
    arrow = {"out": f"-{body}->", "in": f"<-{body}-", "both": f"-{body}-"}[direction]
    return f"MATCH (n) WHERE elementId(n) IN $ids\nMATCH p = (n){arrow}(m)\nRETURN p\nLIMIT $limit"


def build_paths(max_hops: int) -> str:
    hops = max(1, min(int(max_hops), 6))
    return (
        "MATCH (a) WHERE elementId(a) = $from\nMATCH (b) WHERE elementId(b) = $to\n"
        f"MATCH p = allShortestPaths((a)-[*..{hops}]-(b))\nRETURN p\nLIMIT 25"
    )


LINEAGE = (
    "MATCH (n) WHERE elementId(n) = $id\n"
    "RETURN n,\n"
    "  [p = (:Column)-[:FLOWS_TO*1..6]->(n) | p][..$limit] AS upstream,\n"
    "  [p = (n)-[:FLOWS_TO*1..6]->(:Column) | p][..$limit] AS downstream"
)

OVERVIEW = (
    "MATCH (n) WITH n LIMIT $limit\n"
    "WITH collect(n) AS ns\n"
    "UNWIND ns AS a\n"
    "OPTIONAL MATCH (a)-[r]->(b) WHERE b IN ns\n"
    "RETURN ns, collect(DISTINCT r) AS rels"
)
COUNT_NODES = "MATCH (n) RETURN count(n) AS total"

RELATIONSHIPS_BETWEEN = (
    "MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids\nRETURN r\nLIMIT $limit"
)

NODE_DETAIL = "MATCH (n) WHERE elementId(n) = $id RETURN n"
NODE_DEGREES = (
    "MATCH (n)-[r]-() WHERE elementId(n) = $id\n"
    "RETURN type(r) AS type, CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS direction, count(*) AS count\n"
    "ORDER BY type, direction"
)


def values_query(label: str | None, key: str, schema: GraphSchema) -> str:
    """Distinct values of label.key containing $q (validated identifiers)."""
    if label is not None and not schema.has_label(label):
        raise SearchError(f"Unknown label '{label}'.")
    if not schema.has_node_prop(key, label):
        raise SearchError(f"Unknown property '{key}'.")
    node = f"(n:{quote(label)})" if label else "(n)"
    prop = f"n.{quote(key)}"
    return (
        f"MATCH {node} WHERE {prop} IS NOT NULL AND toLower(toString({prop})) CONTAINS toLower($q)\n"
        f"WITH DISTINCT {prop} AS value\n"
        "RETURN value ORDER BY CASE WHEN toLower(toString(value)) STARTS WITH toLower($q) THEN 0 ELSE 1 END, "
        "size(toString(value))\nLIMIT $limit"
    )


GLOBAL_VALUES = (
    "UNWIND $keys AS k\n"
    "MATCH (n) WHERE n[k] IS NOT NULL AND toLower(toString(n[k])) CONTAINS toLower($q)\n"
    "WITH [l IN labels(n) WHERE l <> 'Asset'][0] AS label, k AS key, toString(n[k]) AS value\n"
    "WITH DISTINCT label, key, value\n"
    "RETURN label, key, value\n"
    "ORDER BY CASE WHEN toLower(value) STARTS WITH toLower($q) THEN 0 ELSE 1 END, size(value)\n"
    "LIMIT $limit"
)
