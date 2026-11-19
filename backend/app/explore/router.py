"""/api/explore: the Bloom page backend. Read-only; identifiers are schema-whitelisted."""

from __future__ import annotations

import json
from typing import Any, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ValidationError

from ..guard import ensure_read_only
from ..neo4j_client import Neo4jClient, QueryResult
from . import builder
from .builder import HARD_MAX_LIMIT, SearchError, Token
from .explain import diagnose
from .phrases import Phrase, PhraseIn, PhraseStore
from .schema import GraphSchema, SchemaCache, discover
from .suggest import suggest

# Long numeric lists (vector embeddings) are summarised instead of shipped to the browser.
MAX_LIST_IN_PROPERTIES = 64


def _compact(value: Any) -> Any:
    if isinstance(value, list) and len(value) > MAX_LIST_IN_PROPERTIES and all(
        isinstance(x, (int, float)) for x in value[:MAX_LIST_IN_PROPERTIES]
    ):
        kind = "float" if any(isinstance(x, float) for x in value[:8]) else "number"
        return f"<list of {len(value)} {kind}s>"
    return value


def to_explore_graph(graph: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    nodes = [
        {"elementId": n["elementId"], "labels": n["labels"], "properties": {k: _compact(v) for k, v in n["properties"].items()}}
        for n in graph["nodes"]
    ]
    rels = [
        {
            "elementId": r["elementId"],
            "type": r["type"],
            "start": r["startNodeElementId"],
            "end": r["endNodeElementId"],
            "properties": {k: _compact(v) for k, v in r["properties"].items()},
        }
        for r in graph["relationships"]
    ]
    return {"nodes": nodes, "relationships": rels}


def cap_nodes(g: dict[str, list[dict[str, Any]]], limit: int) -> tuple[dict[str, list[dict[str, Any]]], bool]:
    if len(g["nodes"]) <= limit:
        return g, False
    keep = g["nodes"][:limit]
    ids = {n["elementId"] for n in keep}
    rels = [r for r in g["relationships"] if r["start"] in ids and r["end"] in ids]
    return {"nodes": keep, "relationships": rels}, True


def merge_graphs(a: dict[str, list[dict[str, Any]]], b: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    seen_n = {n["elementId"] for n in a["nodes"]}
    seen_r = {r["elementId"] for r in a["relationships"]}
    return {
        "nodes": a["nodes"] + [n for n in b["nodes"] if n["elementId"] not in seen_n],
        "relationships": a["relationships"] + [r for r in b["relationships"] if r["elementId"] not in seen_r],
    }


def literal(v: Any) -> str:
    return json.dumps(v) if not isinstance(v, str) else "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"


def inline(cypher: str, params: dict[str, Any]) -> str:
    """Readable Cypher for display / "Open in Query" (params inlined, longest names first)."""
    for k in sorted(params, key=len, reverse=True):
        cypher = cypher.replace(f"${k}", literal(params[k]))
    return cypher


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class SearchBody(BaseModel):
    tokens: list[Token] = Field(max_length=20)
    limit: int = Field(default=300, ge=1, le=HARD_MAX_LIMIT)


class OverviewBody(BaseModel):
    limit: int = Field(default=1000, ge=1, le=HARD_MAX_LIMIT)


class ExpandBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=HARD_MAX_LIMIT)
    relTypes: list[str] | None = Field(default=None, max_length=50)
    direction: Literal["in", "out", "both"] = "both"
    limit: int = Field(default=100, ge=1, le=HARD_MAX_LIMIT)


class PathsBody(BaseModel):
    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)
    maxHops: int = Field(default=6, ge=1, le=6)


class LineageBody(BaseModel):
    id: str = Field(min_length=1)
    limit: int = Field(default=300, ge=1, le=HARD_MAX_LIMIT)


class RunPhraseBody(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    limit: int = Field(default=300, ge=1, le=HARD_MAX_LIMIT)


# ---------------------------------------------------------------------------


def create_explore_router(
    get_client: Callable[[], Neo4jClient],
    phrase_store: PhraseStore,
    require_user: Callable[..., Any],
) -> APIRouter:
    r = APIRouter(prefix="/api/explore", tags=["explore (Bloom)"], dependencies=[Depends(require_user)])
    caches: dict[int, SchemaCache] = {}

    def client() -> Neo4jClient:
        return get_client()

    def schema_for(c: Neo4jClient, refresh: bool = False) -> GraphSchema:
        cache = caches.get(id(c))
        if cache is None:
            cache = caches[id(c)] = SchemaCache(lambda: discover(lambda q: c.run_read(q, {}, max_rows=100_000)))
        return cache.get(refresh=refresh)

    def run_graph(c: Neo4jClient, cypher: str, params: dict[str, Any], max_rows: int) -> QueryResult:
        ensure_read_only(cypher)  # belt and braces: everything we generate must pass the guard too
        return c.run_read(cypher, params, max_rows=max_rows)

    def bad(exc: Exception) -> HTTPException:
        return HTTPException(400, str(exc))

    @r.get("/schema", summary="Discovered labels, relationship types (with label pairs) and properties")
    def get_schema(refresh: bool = False, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        return schema_for(c, refresh).to_dict()

    @r.get("/suggest", summary="Grouped suggestions for the search bar")
    def get_suggest(
        q: str = Query("", max_length=200),
        tokens: str = Query("[]", max_length=20_000, description="JSON array of tokens already entered"),
        c: Neo4jClient = Depends(client),
    ) -> dict[str, Any]:
        try:
            toks = [Token(**t) for t in json.loads(tokens or "[]")]
        except (json.JSONDecodeError, TypeError, ValidationError) as exc:
            raise HTTPException(422, f"Invalid tokens: {exc}") from exc
        sch = schema_for(c)
        items = suggest(q, toks, sch, lambda cy, p: c.run_read(cy, p, max_rows=50), phrase_store.list())
        return {"suggestions": items}

    @r.post("/search", summary="Run a token search")
    def post_search(body: SearchBody, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        sch = schema_for(c)
        try:
            built = builder.build_search(body.tokens, sch, body.limit)
        except SearchError as exc:
            raise bad(exc) from exc
        res = run_graph(c, built.cypher, built.params, max_rows=body.limit + 1)
        truncated = len(res.records) > body.limit or res.truncated
        g = to_explore_graph(res.graph)
        if built.kind in ("nodes", "text"):
            ids = [n["elementId"] for n in g["nodes"]][: body.limit]
            g["nodes"] = g["nodes"][: body.limit]
            if ids:
                rels = run_graph(c, builder.RELATIONSHIPS_BETWEEN, {"ids": ids, "limit": 5000}, 5000)
                g = merge_graphs(g, to_explore_graph(rels.graph))
        g, capped = cap_nodes(g, body.limit)
        shown = {k: v for k, v in built.params.items() if k != "limit"}
        out: dict[str, Any] = {**g, "truncated": truncated or capped, "cypher": inline(built.cypher, {**shown, "limit": body.limit})}
        if not g["nodes"] and built.kind in ("nodes", "paths"):
            out["diagnosis"] = diagnose(body.tokens, sch, lambda cy, p: run_graph(c, cy, p, 50))
        return out

    @r.post("/overview", summary="Whole graph up to a limit, with all relationships between the returned nodes")
    def post_overview(body: OverviewBody, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        res = run_graph(c, builder.OVERVIEW, {"limit": body.limit}, 1)
        g = to_explore_graph(res.graph)
        # Only nodes from `ns` and relationships whose both ends were returned.
        returned = set()
        for rec in res.records:
            for n in rec.get("ns") or []:
                if isinstance(n, dict) and n.get("elementId"):
                    returned.add(n["elementId"])
        if returned:
            g["nodes"] = [n for n in g["nodes"] if n["elementId"] in returned]
        ids = {n["elementId"] for n in g["nodes"]}
        g["relationships"] = [r for r in g["relationships"] if r["start"] in ids and r["end"] in ids]
        total = c.run_read(builder.COUNT_NODES, {}, max_rows=1).records
        total_nodes = int(total[0]["total"]) if total else len(ids)
        return {
            **g,
            "truncated": total_nodes > len(ids),
            "total_nodes": total_nodes,
            "cypher": inline(builder.OVERVIEW, {"limit": body.limit}),
        }

    @r.post("/expand", summary="Expand neighbours of nodes")
    def post_expand(body: ExpandBody, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        try:
            cy = builder.build_expand(schema_for(c), body.relTypes, body.direction)
        except SearchError as exc:
            raise bad(exc) from exc
        res = run_graph(c, cy, {"ids": body.ids, "limit": body.limit + 1}, body.limit + 1)
        g = to_explore_graph(res.graph)
        return {**g, "truncated": len(res.records) > body.limit, "cypher": inline(cy, {"limit": body.limit})}

    @r.post("/paths", summary="Shortest path(s) between two nodes")
    def post_paths(body: PathsBody, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        cy = builder.build_paths(body.maxHops)
        res = run_graph(c, cy, {"from": body.from_, "to": body.to}, 25)
        return {**to_explore_graph(res.graph), "truncated": False, "cypher": inline(cy, {"from": body.from_, "to": body.to})}

    @r.post("/lineage", summary="Upstream + downstream FLOWS_TO lineage of a node")
    def post_lineage(body: LineageBody, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        if not schema_for(c).has_rel("FLOWS_TO"):
            raise HTTPException(400, "This database has no FLOWS_TO relationships.")
        res = run_graph(c, builder.LINEAGE, {"id": body.id, "limit": body.limit}, 10)
        g, capped = cap_nodes(to_explore_graph(res.graph), body.limit)
        return {**g, "truncated": capped, "cypher": inline(builder.LINEAGE, {"id": body.id, "limit": body.limit})}

    @r.get("/node/{element_id:path}", summary="Node properties and neighbour counts by type/direction")
    def get_node(element_id: str, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        res = c.run_read(builder.NODE_DETAIL, {"id": element_id}, max_rows=1)
        if not res.records:
            raise HTTPException(404, "Node not found.")
        node = to_explore_graph(res.graph)["nodes"][0]
        deg = c.run_read(builder.NODE_DEGREES, {"id": element_id}, max_rows=500).records
        return {**node, "neighbours": [{"type": d["type"], "direction": d["direction"], "count": d["count"]} for d in deg]}

    @r.get("/values", summary="Distinct property values (autocomplete)")
    def get_values(
        key: str = Query(min_length=1, max_length=200),
        label: str | None = Query(None, max_length=200),
        q: str = Query("", max_length=200),
        c: Neo4jClient = Depends(client),
    ) -> dict[str, Any]:
        try:
            cy = builder.values_query(label or None, key, schema_for(c))
        except SearchError as exc:
            raise bad(exc) from exc
        return {"values": [r["value"] for r in c.run_read(cy, {"q": q, "limit": 10}, max_rows=10).records]}

    # -- phrases ------------------------------------------------------------------

    @r.get("/phrases", summary="List search phrases")
    def list_phrases() -> list[Phrase]:
        return phrase_store.list()

    @r.post("/phrases", summary="Create a search phrase", status_code=201)
    def create_phrase(body: PhraseIn) -> Phrase:
        return phrase_store.create(body)

    @r.put("/phrases/{phrase_id}", summary="Update a search phrase")
    def update_phrase(phrase_id: str, body: PhraseIn) -> Phrase:
        p = phrase_store.update(phrase_id, body)
        if p is None:
            raise HTTPException(404, "Phrase not found.")
        return p

    @r.delete("/phrases/{phrase_id}", summary="Delete a search phrase", status_code=204)
    def delete_phrase(phrase_id: str) -> None:
        if not phrase_store.delete(phrase_id):
            raise HTTPException(404, "Phrase not found.")

    @r.post("/phrases/{phrase_id}/run", summary="Run a search phrase")
    def run_phrase(phrase_id: str, body: RunPhraseBody, c: Neo4jClient = Depends(client)) -> dict[str, Any]:
        ph = phrase_store.get(phrase_id)
        if ph is None:
            raise HTTPException(404, "Phrase not found.")
        missing = [p.name for p in ph.params if p.name not in body.params or body.params[p.name] in (None, "")]
        if missing:
            raise HTTPException(400, f"Missing value for ${', $'.join(missing)}.")
        params = {p.name: body.params[p.name] for p in ph.params}
        res = run_graph(c, ph.cypher, params, max_rows=body.limit + 1)
        g, capped = cap_nodes(to_explore_graph(res.graph), body.limit)
        return {**g, "truncated": capped or res.truncated, "cypher": inline(ph.cypher, params)}

    return r
