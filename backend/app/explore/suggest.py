"""Context-aware search-bar suggestions, driven by the discovered schema."""

from __future__ import annotations

from typing import Any, Callable

from .builder import GLOBAL_VALUES, SearchError, Token, chain_values_query, parse_chain, values_query
from .phrases import Phrase, match_phrase
from .schema import GENERIC_LABEL, GraphSchema

PER_CATEGORY = 10
VALUE_KEYS = ["name", "full_name", "title", "heading", "chunk_id"]

Run = Callable[[str, dict[str, Any]], Any]


def _rank(name: str, q: str) -> tuple[int, int, str]:
    n, ql = name.lower(), q.lower()
    return (0 if n == ql else 1 if n.startswith(ql) else 2, len(name), name)


def _match(name: str, q: str) -> bool:
    return not q or q.lower() in name.lower()


def _context(tokens: list[Token], schema: GraphSchema) -> dict[str, Any]:
    """Describe what may come next after `tokens`."""
    if not tokens:
        return {"state": "start", "label": None}
    if tokens[0].kind in ("text", "phrase"):
        return {"state": "closed"}
    nodes, rels = parse_chain(tokens, schema)  # raises SearchError on invalid input
    last = tokens[-1]
    cur = nodes[-1]
    if last.kind == "rel":
        prev = nodes[-2].label
        return {"state": "after_rel", "label": prev, "rel": last.value, "direction": last.direction, "hops": len(rels)}
    if last.kind == "property":
        return {"state": "after_property", "label": cur.label, "key": last.value, "hops": len(rels)}
    return {"state": "after_node", "label": cur.label, "hops": len(rels)}


def suggest(
    q: str,
    tokens: list[Token],
    schema: GraphSchema,
    run: Run,
    phrases: list[Phrase],
) -> list[dict[str, Any]]:
    q = q.strip()
    try:
        ctx = _context(tokens, schema)
    except SearchError as exc:
        return [{"category": "error", "title": str(exc), "tokens": []}]
    out: list[dict[str, Any]] = []
    state = ctx["state"]
    if state == "closed":
        return out

    def add_labels(names: list[str]) -> None:
        hits = sorted((n for n in names if _match(n, q)), key=lambda n: (n == GENERIC_LABEL, *_rank(n, q)))
        for n in hits[:PER_CATEGORY]:
            out.append({"category": "node", "title": n, "chip": n, "count": schema.labels.get(n),
                        "tokens": [{"kind": "label", "value": n}]})

    def add_rels(pairs: list[tuple[str, str]]) -> None:
        hits = sorted((p for p in pairs if _match(p[0], q)), key=lambda p: _rank(p[0], q))
        for t, d in hits[:PER_CATEGORY]:
            arrow = "←" if d == "in" else "→"
            out.append({"category": "relationship", "title": t, "chip": t, "subtitle": f"{arrow} direction",
                        "count": schema.rel_types.get(t),
                        "tokens": [{"kind": "rel", "value": t, "direction": d}]})

    if state == "start":
        add_labels(list(schema.labels))
        add_rels([(t, "out") for t in schema.rel_types])
        _add_phrases(out, q, schema, run, phrases)
        if len(q) >= 2:
            _add_global_values(out, q, schema, run)
    elif state == "after_rel":
        add_labels(schema.end_labels(ctx["label"], ctx["rel"], ctx["direction"]))
    elif state == "after_node":
        if ctx["hops"] < 4:
            add_rels(schema.rels_for_label(ctx["label"]))
        label = ctx["label"]
        props = schema.node_props.get(label, {}) if label else {k: [] for k in schema.all_node_props()}
        keys = sorted((k for k in props if _match(k, q) and schema.is_scalar_prop(label, k)), key=lambda k: _rank(k, q))
        for k in keys[:PER_CATEGORY]:
            out.append({"category": "property", "title": k, "chip": label, "subtitle": ", ".join(props.get(k, [])),
                        "tokens": [{"kind": "property", "value": k}]})
    elif state == "after_property":
        try:
            # Values that fit the whole chain, e.g. only tables that really FEED a View.
            cypher, params = chain_values_query(tokens, schema, PER_CATEGORY)
            rows = run(cypher, {**params, "q": q}).records
        except SearchError:
            rows = []
        for r in rows:
            v = str(r["value"])
            out.append({"category": "value", "title": v, "chip": ctx["label"], "subtitle": ctx["key"],
                        "tokens": [{"kind": "value", "value": v}]})
        if q and not any(s["title"].lower() == q.lower() for s in out):
            out.append({"category": "value", "title": q, "subtitle": "use typed value",
                        "tokens": [{"kind": "value", "value": q}]})

    if q and state == "start":
        out.append({"category": "text", "title": f'Search for "{q}"', "subtitle": "text in name, title, text …",
                    "tokens": [{"kind": "text", "value": q}]})
    return out


def _add_global_values(out: list[dict[str, Any]], q: str, schema: GraphSchema, run: Run) -> None:
    keys = [k for k in VALUE_KEYS if schema.has_node_prop(k)]
    if not keys:
        return
    for r in run(GLOBAL_VALUES, {"keys": keys, "q": q, "limit": PER_CATEGORY}).records:
        label, key, value = r["label"], r["key"], r["value"]
        tokens = [{"kind": "property", "value": key}, {"kind": "value", "value": value}]
        if label and schema.has_label(label):
            tokens.insert(0, {"kind": "label", "value": label})
        out.append({"category": "value", "title": value, "chip": label, "subtitle": f"{label or 'node'}.{key}",
                    "tokens": tokens})


def _add_phrases(out: list[dict[str, Any]], q: str, schema: GraphSchema, run: Run, phrases: list[Phrase]) -> None:
    n = 0
    for ph in phrases:
        m = match_phrase(ph.name, q)
        if m is None:
            continue
        kind, partial = m
        if kind == "param" and ph.params:
            param = ph.params[0]
            values: list[str] = []
            if param.source:
                label, key = param.source.split(".", 1)
                try:
                    rows = run(values_query(label, key, schema), {"q": partial or "", "limit": PER_CATEGORY}).records
                    values = [str(r["value"]) for r in rows]
                except SearchError:
                    values = []
            if partial and partial not in values:
                values.append(partial)
            prefix = ph.name[: ph.name.index("$")]
            for v in values[:PER_CATEGORY]:
                out.append({"category": "phrase", "title": f"{prefix}{v}", "subtitle": ph.description,
                            "tokens": [{"kind": "phrase", "value": ph.id, "params": {param.name: v}}]})
                n += 1
        elif not ph.params:
            out.append({"category": "phrase", "title": ph.name, "subtitle": ph.description,
                        "tokens": [{"kind": "phrase", "value": ph.id, "params": {}}]})
            n += 1
        else:
            # Parameterised phrase: selecting it fills the input so the user can type the value.
            prefix = ph.name[: ph.name.index("$")]
            out.append({"category": "phrase", "title": ph.name, "subtitle": ph.description, "tokens": [],
                        "fill": prefix})
            n += 1
        if n >= PER_CATEGORY:
            break
