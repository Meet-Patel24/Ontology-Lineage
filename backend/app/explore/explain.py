"""Explain why a token search returned nothing, and offer fixes.

Each part of the pattern is checked separately, e.g.
"Table with name = 'loans' exists (1), but none of them has a FEEDS relationship
to a View. Tables that do: accounts, branches, customers."
"""

from __future__ import annotations

from typing import Any, Callable

from .builder import Token, _Node, chain_pattern, parse_chain, values_query
from .schema import GraphSchema

Run = Callable[[str, dict[str, Any]], Any]
MAX_FIXES = 8


def _name(node: _Node) -> str:
    return node.label or "node"


def _with_value(tokens: list[Token], node_index: int, filter_index: int, value: str) -> list[dict[str, Any]]:
    """Copy of `tokens` with one filter value replaced."""
    out: list[dict[str, Any]] = []
    node_i, filt_i = 0, -1
    for t in tokens:
        d = t.model_dump()
        if t.kind == "rel":
            node_i += 1
            filt_i = -1
        elif t.kind == "property":
            filt_i += 1
        elif t.kind == "value" and node_i == node_index and filt_i == filter_index:
            d["value"] = value
        out.append(d)
    return out


def _relation_phrase(nodes: list[_Node], rels: list[Token], i: int) -> str:
    """How node i relates to the rest of the pattern, in words."""
    if len(rels) != 1:
        return "matches the rest of the pattern"
    other = nodes[1 - i]
    rel = rels[0]
    direction = rel.direction
    if i == 1 and direction != "both":  # look at the relationship from the second node's side
        direction = "in" if direction == "out" else "out"
    target = f"a {_name(other)}"
    if direction == "out":
        return f"has a {rel.value} relationship to {target}"
    if direction == "in":
        return f"has a {rel.value} relationship from {target}"
    return f"is connected to {target} by {rel.value}"


def _count(run: Run, pattern: str, where: list[str], params: dict[str, Any], var: str = "n0") -> int:
    where_sql = f" WHERE {' AND '.join(where)}" if where else ""
    rows = run(f"MATCH {pattern}{where_sql} RETURN count(DISTINCT {var}) AS c", params).records
    return int(rows[0]["c"]) if rows else 0


def diagnose(tokens: list[Token], schema: GraphSchema, run: Run) -> dict[str, Any]:
    nodes, rels = parse_chain(tokens, schema)

    # 1. Does each filtered node exist on its own?
    standalone: dict[tuple[int, int], int] = {}
    for i, node in enumerate(nodes):
        for j, (key, value) in enumerate(node.filters):
            if value is None:
                continue
            params: dict[str, Any] = {}
            pattern, where = chain_pattern([_Node(node.label, [[key, value]])], [], params)
            # chain_pattern names the param v0_0; this is a single-node pattern
            c = _count(run, pattern, where, params)
            standalone[(i, j)] = c
            if c == 0:
                similar = run(values_query(node.label, key, schema), {"q": str(value)[:3], "limit": MAX_FIXES}).records
                if not similar:
                    similar = run(values_query(node.label, key, schema), {"q": "", "limit": MAX_FIXES}).records
                vals = [str(r["value"]) for r in similar]
                return {
                    "message": f"No {_name(node)} with {key} = '{value}' exists."
                    + (f" Similar values: {', '.join(vals[:5])}." if vals else ""),
                    "fixes": [{"title": v, "tokens": _with_value(tokens, i, j, v)} for v in vals],
                }

    # 2. The filtered node exists, but not in combination with the rest of the pattern.
    for (i, j), c in standalone.items():
        key, value = nodes[i].filters[j]
        params = {"limit": MAX_FIXES}
        pattern, where = chain_pattern(nodes, rels, params, skip=(i, j))
        prop = f"n{i}.`{key.replace('`', '``')}`"
        where_sql = " AND ".join([*where, f"{prop} IS NOT NULL"])
        rows = run(f"MATCH {pattern} WHERE {where_sql} RETURN DISTINCT toString({prop}) AS value ORDER BY value LIMIT $limit", params).records
        vals = [str(r["value"]) for r in rows]
        name = _name(nodes[i])
        msg = f"{name} with {key} = '{value}' exists ({c}), but none of them {_relation_phrase(nodes, rels, i)}."
        if vals:
            msg += f" {name}s that do: {', '.join(vals)}."
        else:
            msg += f" No {name} matches the rest of the pattern."
        return {"message": msg, "fixes": [{"title": v, "tokens": _with_value(tokens, i, j, v)} for v in vals]}

    # 3. No value filters: find the first hop that breaks.
    if not rels:
        return {"message": f"There are no {_name(nodes[0])} nodes{' with these properties' if nodes[0].filters else ''}.", "fixes": []}
    for h in range(1, len(rels) + 1):
        params = {}
        pattern, where = chain_pattern(nodes[: h + 1], rels[:h], params)
        if _count(run, pattern, where, params) == 0:
            rel = rels[h - 1]
            a, b = _name(nodes[h - 1]), _name(nodes[h])
            arrow = {"out": "to", "in": "from", "both": "connected to"}[rel.direction]
            return {"message": f"No {a} has a {rel.value} relationship {arrow} a {b}" + (" further along this pattern." if h > 1 else "."), "fixes": []}
    return {"message": "No results for this pattern.", "fixes": []}
