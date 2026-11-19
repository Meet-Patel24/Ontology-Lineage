"""Bloom explorer: token -> Cypher builder, identifier validation, suggestions, limits, phrases."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.explore import builder
from app.explore.builder import SearchError, Token, build_search
from app.explore.phrases import DEFAULT_PHRASES, PhraseIn, PhraseStore, match_phrase
from app.explore.schema import GraphSchema, discover
from app.explore.suggest import suggest
from app.guard import check_read_only
from app.main import create_app
from app.neo4j_client import QueryResult


def make_schema() -> GraphSchema:
    s = GraphSchema(
        labels={"Asset": 161, "Column": 126, "Table": 11, "View": 1, "PolicyChunk": 12, "PolicyDocument": 1, "Pipeline": 5, "Activity": 6},
        rel_types={"FLOWS_TO": 69, "GOVERNS": 126, "HAS_CHUNK": 12, "NEXT_CHUNK": 11, "HAS_COLUMN": 126, "CONTAINS": 6, "FEEDS": 3},
        patterns={
            ("PolicyChunk", "GOVERNS", "Column"),
            ("PolicyDocument", "HAS_CHUNK", "PolicyChunk"),
            ("PolicyChunk", "NEXT_CHUNK", "PolicyChunk"),
            ("Column", "FLOWS_TO", "Column"),
            ("Table", "HAS_COLUMN", "Column"),
            ("Pipeline", "CONTAINS", "Activity"),
            ("Table", "FEEDS", "View"),
        },
        node_props={
            "Column": {"name": ["STRING"], "table": ["STRING"], "is_pii": ["BOOLEAN"], "id": ["STRING"]},
            "Table": {"name": ["STRING"], "full_name": ["STRING"], "platform": ["STRING"], "id": ["STRING"]},
            "View": {"name": ["STRING"]},
            "PolicyChunk": {"heading": ["STRING"], "text": ["STRING"], "embedding": ["LIST<FLOAT NOT NULL>"]},
            "PolicyDocument": {"title": ["STRING"]},
            "Pipeline": {"name": ["STRING"]},
            "Activity": {"name": ["STRING"]},
            "Asset": {"id": ["STRING"], "name": ["STRING"]},
        },
    )
    return s


T = Token


# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------


def test_label_only() -> None:
    q = build_search([T(kind="label", value="PolicyChunk")], make_schema(), 300)
    assert q.kind == "nodes"
    assert q.cypher.startswith("MATCH (n0:`PolicyChunk`)")
    assert q.params == {"limit": 301}


def test_label_property_value_is_parameterised() -> None:
    toks = [T(kind="label", value="Column"), T(kind="property", value="name"), T(kind="value", value="risk_bucket")]
    q = build_search(toks, make_schema(), 50)
    assert "risk_bucket" not in q.cypher
    assert "toLower(toString(n0.`name`)) = toLower($v0_0)" in q.cypher
    assert q.params["v0_0"] == "risk_bucket"


def test_property_without_value_means_not_null() -> None:
    toks = [T(kind="label", value="Table"), T(kind="property", value="platform")]
    assert "n0.`platform` IS NOT NULL" in build_search(toks, make_schema(), 10).cypher


def test_relationship_chain_and_directions() -> None:
    toks = [
        T(kind="label", value="PolicyDocument"),
        T(kind="rel", value="HAS_CHUNK"),
        T(kind="label", value="PolicyChunk"),
        T(kind="rel", value="GOVERNS", direction="out"),
        T(kind="label", value="Column"),
        T(kind="rel", value="FLOWS_TO", direction="in"),
        T(kind="rel", value="HAS_COLUMN", direction="both"),
    ]
    q = build_search(toks, make_schema(), 300)
    assert q.kind == "paths"
    assert q.cypher.splitlines()[0] == (
        "MATCH p = (n0:`PolicyDocument`)-[r0:`HAS_CHUNK`]->(n1:`PolicyChunk`)-[r1:`GOVERNS`]->(n2:`Column`)"
        "<-[r2:`FLOWS_TO`]-(n3)-[r3:`HAS_COLUMN`]-(n4)"
    )
    assert "RETURN p" in q.cypher


def test_relationship_only_search() -> None:
    q = build_search([T(kind="rel", value="GOVERNS")], make_schema(), 10)
    assert q.cypher.startswith("MATCH p = (n0)-[r0:`GOVERNS`]->(n1)")


def test_max_four_hops() -> None:
    toks = [T(kind="label", value="Column")] + [T(kind="rel", value="FLOWS_TO")] * 5
    with pytest.raises(SearchError, match="At most 4"):
        build_search(toks, make_schema(), 10)


@pytest.mark.parametrize(
    "token",
    [
        T(kind="label", value="Column`) DETACH DELETE n //"),
        T(kind="label", value="column"),  # exact match only
        T(kind="label", value="Nope"),
    ],
)
def test_unknown_or_malicious_label_rejected(token: Token) -> None:
    with pytest.raises(SearchError, match="Unknown label"):
        build_search([token], make_schema(), 10)


def test_malicious_relationship_and_property_rejected() -> None:
    with pytest.raises(SearchError, match="Unknown relationship"):
        build_search([T(kind="label", value="Column"), T(kind="rel", value="FLOWS_TO]->() DELETE x //")], make_schema(), 10)
    with pytest.raises(SearchError, match="Unknown property"):
        build_search([T(kind="label", value="Column"), T(kind="property", value="name` = 1 SET n.x")], make_schema(), 10)
    # property that exists on another label but not on this one
    with pytest.raises(SearchError, match="Unknown property 'heading' on :Column"):
        build_search([T(kind="label", value="Column"), T(kind="property", value="heading")], make_schema(), 10)


def test_value_injection_stays_a_parameter() -> None:
    evil = "x') DETACH DELETE n //"
    toks = [T(kind="label", value="Column"), T(kind="property", value="name"), T(kind="value", value=evil)]
    q = build_search(toks, make_schema(), 10)
    assert evil not in q.cypher
    assert check_read_only(q.cypher).ok


def test_grammar_errors() -> None:
    sch = make_schema()
    with pytest.raises(SearchError, match="Two labels"):
        build_search([T(kind="label", value="Column"), T(kind="label", value="Table")], sch, 10)
    with pytest.raises(SearchError, match="value must follow"):
        build_search([T(kind="label", value="Column"), T(kind="value", value="x")], sch, 10)
    with pytest.raises(SearchError, match="Nothing to search"):
        build_search([], sch, 10)
    with pytest.raises(SearchError, match="cannot be combined"):
        build_search([T(kind="text", value="loan"), T(kind="label", value="Column")], sch, 10)


def test_limits_are_clamped() -> None:
    sch = make_schema()
    assert build_search([T(kind="label", value="Column")], sch, 999_999).params["limit"] == builder.HARD_MAX_LIMIT + 1
    assert build_search([T(kind="label", value="Column")], sch, 0).params["limit"] == 2


def test_text_search_uses_contains_without_index() -> None:
    q = build_search([T(kind="text", value="Risk")], make_schema(), 20)
    assert q.kind == "text" and "CONTAINS toLower($q)" in q.cypher
    assert q.params["q"] == "Risk"
    assert set(q.params["keys"]) <= set(builder.TEXT_SEARCH_KEYS)


def test_text_search_uses_fulltext_index_when_present() -> None:
    sch = make_schema()
    sch.fulltext_indexes = [{"name": "assetText", "labels": ["Asset"], "properties": ["name"]}]
    q = build_search([T(kind="text", value="risk:bucket")], sch, 20)
    assert "db.index.fulltext.queryNodes" in q.cypher
    assert q.params["q"] == "risk\\:bucket*"


def test_expand_builder_validates_types() -> None:
    sch = make_schema()
    assert "-[r:`GOVERNS`|`FLOWS_TO`]-" in builder.build_expand(sch, ["GOVERNS", "FLOWS_TO"], "both")
    assert "<-[r]-" in builder.build_expand(sch, None, "in")
    with pytest.raises(SearchError):
        builder.build_expand(sch, ["X`]-() DELETE n //"], "out")


def test_every_generated_query_is_read_only() -> None:
    sch = make_schema()
    for cy in [builder.build_paths(9), builder.LINEAGE, builder.RELATIONSHIPS_BETWEEN, builder.GLOBAL_VALUES,
               builder.values_query("Column", "name", sch), builder.build_expand(sch, None, "both")]:
        assert check_read_only(cy).ok, cy
    assert "*..6" in builder.build_paths(9)  # max hops clamped


# ---------------------------------------------------------------------------
# suggestions
# ---------------------------------------------------------------------------


class FakeRun:
    def __init__(self, rows: list[dict[str, Any]] | None = None):
        self.rows = rows or []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, cypher: str, params: dict[str, Any]) -> QueryResult:
        self.calls.append((cypher, params))
        rows = [] if "UNWIND $keys" in cypher else self.rows  # global value search returns nothing here
        return QueryResult(["value"], rows, {"nodes": [], "relationships": []}, {}, False)


def phrases():
    from app.explore.phrases import Phrase

    return [Phrase(**p, builtin=True) for p in DEFAULT_PHRASES]


def test_suggest_labels_for_prefix() -> None:
    items = suggest("Pol", [], make_schema(), FakeRun(), phrases())
    nodes = [i["title"] for i in items if i["category"] == "node"]
    assert nodes[:2] == ["PolicyChunk", "PolicyDocument"]
    assert any(i["category"] == "phrase" and i["title"] == "Policy clauses for $column" for i in items)
    assert items[-1]["category"] == "text"


def test_suggest_only_connected_relationships_after_label() -> None:
    items = suggest("", [T(kind="label", value="PolicyChunk")], make_schema(), FakeRun(), phrases())
    rels = {(i["title"], i["tokens"][0]["direction"]) for i in items if i["category"] == "relationship"}
    assert rels == {("GOVERNS", "out"), ("HAS_CHUNK", "in"), ("NEXT_CHUNK", "in"), ("NEXT_CHUNK", "out")}
    props = [i["title"] for i in items if i["category"] == "property"]
    assert "embedding" not in props and "heading" in props


def test_suggest_only_valid_end_labels_after_relationship() -> None:
    toks = [T(kind="label", value="PolicyChunk"), T(kind="rel", value="GOVERNS", direction="out")]
    items = suggest("", toks, make_schema(), FakeRun(), phrases())
    assert [i["title"] for i in items] == ["Column"]
    toks = [T(kind="label", value="Column"), T(kind="rel", value="GOVERNS", direction="in")]
    assert [i["title"] for i in suggest("", toks, make_schema(), FakeRun(), phrases())] == ["PolicyChunk"]


def test_suggest_values_after_property() -> None:
    run = FakeRun([{"value": "risk_bucket"}, {"value": "risk_bucket_flag"}])
    toks = [T(kind="label", value="Column"), T(kind="property", value="name")]
    items = suggest("risk", toks, make_schema(), run, phrases())
    assert [i["title"] for i in items] == ["risk_bucket", "risk_bucket_flag", "risk"]
    cypher, params = run.calls[0]
    assert "MATCH (n0:`Column`)" in cypher and params["q"] == "risk"


def test_suggest_phrase_param_values() -> None:
    run = FakeRun([{"value": "risk_bucket"}])
    items = suggest("Policy clauses for ris", [], make_schema(), run, phrases())
    ph = [i for i in items if i["category"] == "phrase"]
    assert ph[0]["title"] == "Policy clauses for risk_bucket"
    assert ph[0]["tokens"] == [{"kind": "phrase", "value": "policy-clauses-for-column", "params": {"column": "risk_bucket"}}]


def test_match_phrase() -> None:
    assert match_phrase("Lineage of $column", "lin") == ("fill", None)
    assert match_phrase("Lineage of $column", "lineage of risk") == ("param", "risk")
    assert match_phrase("Where does PII flow", "pii") == ("fill", None)
    assert match_phrase("Where does PII flow", "zzz") is None


def test_suggest_error_for_invalid_tokens() -> None:
    items = suggest("", [T(kind="label", value="Nope")], make_schema(), FakeRun(), phrases())
    assert items[0]["category"] == "error"


# ---------------------------------------------------------------------------
# schema discovery
# ---------------------------------------------------------------------------


def test_discover_parses_procedures() -> None:
    def run(q: str) -> QueryResult:
        recs: list[dict[str, Any]] = []
        graph: dict[str, Any] = {"nodes": [], "relationships": []}
        if "UNWIND labels" in q:
            recs = [{"label": "PolicyChunk", "count": 12}, {"label": "Column", "count": 3}, {"label": "NewLabel", "count": 1}]
        elif "type(r)" in q:
            recs = [{"type": "GOVERNS", "count": 5}]
        elif "visualization" in q:
            graph = {
                "nodes": [{"elementId": "-1", "labels": ["PolicyChunk"], "properties": {"name": "PolicyChunk"}},
                          {"elementId": "-2", "labels": ["Column"], "properties": {"name": "Column"}}],
                "relationships": [{"elementId": "-3", "type": "GOVERNS", "startNodeElementId": "-1", "endNodeElementId": "-2", "properties": {}}],
            }
        elif "nodeTypeProperties" in q:
            recs = [{"nodeLabels": ["PolicyChunk"], "propertyName": "text", "propertyTypes": ["String"]}]
        elif "relTypeProperties" in q:
            recs = [{"relType": ":`GOVERNS`", "propertyName": None, "propertyTypes": None}]
        return QueryResult([], recs, graph, {}, False)

    s = discover(run)
    assert s.has_label("NewLabel")  # new labels appear without code changes
    assert ("PolicyChunk", "GOVERNS", "Column") in s.patterns
    assert s.node_props["PolicyChunk"] == {"text": ["String"]} and s.node_props["NewLabel"] == {}
    assert "GOVERNS" in s.rel_props


# ---------------------------------------------------------------------------
# phrases
# ---------------------------------------------------------------------------


def test_phrase_store_crud(tmp_path) -> None:
    store = PhraseStore(tmp_path / "phrases.json")
    assert [p.id for p in store.list()] == [p["id"] for p in DEFAULT_PHRASES]
    assert (tmp_path / "phrases.json").exists()
    created = store.create(PhraseIn(name="Columns of $table", cypher="MATCH (t {full_name:$table})-[:HAS_COLUMN]->(c) RETURN t, c",
                                    params=[{"name": "table", "source": "Table.full_name"}]))
    assert store.get(created.id).name == "Columns of $table"
    updated = store.update(created.id, PhraseIn(name="Cols of $table", cypher="MATCH (t {full_name:$table}) RETURN t"))
    assert updated.name == "Cols of $table" and updated.params[0].name == "table"
    assert store.delete(created.id) and not store.delete(created.id)
    assert store.get(created.id) is None


def test_phrase_validation() -> None:
    with pytest.raises(ValueError, match="read-only"):
        PhraseIn(name="Bad", cypher="MATCH (n) DETACH DELETE n")
    with pytest.raises(ValueError, match="not used"):
        PhraseIn(name="Lineage of $col", cypher="MATCH (n) RETURN n")
    with pytest.raises(ValueError):
        PhraseIn(name="x", cypher="RETURN $a", params=[{"name": "a", "source": "Column.name`) DELETE"}])
    p = PhraseIn(name="By $a", cypher="RETURN $a")
    assert [x.name for x in p.params] == ["a"]


def test_default_phrases_are_valid_and_read_only() -> None:
    for p in DEFAULT_PHRASES:
        PhraseIn(**{k: v for k, v in p.items() if k != "id"})


# ---------------------------------------------------------------------------
# API (fake live client)
# ---------------------------------------------------------------------------


class FakeClient:
    def __init__(self):
        self.calls: list[str] = []
        self.schema = make_schema()

    def run_read(self, query, params=None, max_rows=None, timeout=None):
        self.calls.append(query)
        graph = {"nodes": [], "relationships": []}
        records: list[dict[str, Any]] = []
        if "UNWIND labels" in query:
            records = [{"label": k, "count": v} for k, v in self.schema.labels.items()]
        elif "RETURN type(r) AS type, count(*)" in query:
            records = [{"type": k, "count": v} for k, v in self.schema.rel_types.items()]
        elif "visualization" in query:
            ids = {lbl: str(-i) for i, lbl in enumerate(self.schema.labels, 1)}
            graph = {
                "nodes": [{"elementId": i, "labels": [l], "properties": {"name": l}} for l, i in ids.items()],
                "relationships": [
                    {"elementId": f"r{n}", "type": t, "startNodeElementId": ids[s], "endNodeElementId": ids[e], "properties": {}}
                    for n, (s, t, e) in enumerate(self.schema.patterns)
                ],
            }
        elif "nodeTypeProperties" in query:
            records = [{"nodeLabels": [l], "propertyName": k, "propertyTypes": t}
                       for l, props in self.schema.node_props.items() for k, t in props.items()]
        elif query.startswith("MATCH (n0:`PolicyChunk`)"):
            graph = {"nodes": [{"$type": "node", "elementId": "4:x:1", "labels": ["PolicyChunk"],
                                "properties": {"heading": "Scope", "embedding": [0.1] * 384}}], "relationships": []}
            records = [{"n0": {}}]
        return QueryResult([], records, graph, {}, False)

    def health(self):
        return {"connected": True}

    def close(self):
        pass


@pytest.fixture()
def api(tmp_path):
    fake = FakeClient()
    app = create_app(Settings(mode="live", static_dir="__none__"), client=fake,  # type: ignore[arg-type]
                     phrase_store=PhraseStore(tmp_path / "p.json"))
    with TestClient(app) as tc:
        yield tc, fake


def test_api_suggest_and_search(api) -> None:
    tc, fake = api
    r = tc.get("/api/explore/suggest", params={"q": "Pol", "tokens": "[]"})
    assert r.status_code == 200
    assert [s["title"] for s in r.json()["suggestions"] if s["category"] == "node"][:2] == ["PolicyChunk", "PolicyDocument"]
    r = tc.post("/api/explore/search", json={"tokens": [{"kind": "label", "value": "PolicyChunk"}], "limit": 300})
    assert r.status_code == 200
    body = r.json()
    assert body["nodes"][0]["properties"]["embedding"] == "<list of 384 floats>"
    assert body["truncated"] is False and "PolicyChunk" in body["cypher"]


def test_api_rejects_injection_without_touching_db(api) -> None:
    tc, fake = api
    tc.get("/api/explore/schema")
    before = len(fake.calls)
    r = tc.post("/api/explore/search", json={"tokens": [{"kind": "label", "value": "Column`) DETACH DELETE n //"}]})
    assert r.status_code == 400 and "Unknown label" in r.json()["error"]["message"]
    assert len(fake.calls) == before


def test_api_limits_and_phrases(api) -> None:
    tc, _ = api
    assert tc.post("/api/explore/search", json={"tokens": [{"kind": "label", "value": "Column"}], "limit": 5000}).status_code == 422
    assert tc.post("/api/explore/expand", json={"ids": ["a"], "limit": 2001}).status_code == 422
    r = tc.post("/api/explore/phrases", json={"name": "Wipe", "cypher": "MATCH (n) DELETE n"})
    assert r.status_code == 422
    r = tc.post("/api/explore/phrases", json={"name": "Chunks", "cypher": "MATCH (c:PolicyChunk) RETURN c"})
    assert r.status_code == 201
    pid = r.json()["id"]
    assert any(p["id"] == pid for p in tc.get("/api/explore/phrases").json())
    assert tc.post("/api/explore/phrases/policy-clauses-for-column/run", json={"params": {}}).status_code == 400
    assert tc.delete(f"/api/explore/phrases/{pid}").status_code == 204


def test_api_schema_refresh(api) -> None:
    tc, fake = api
    tc.get("/api/explore/schema")
    n = len(fake.calls)
    tc.get("/api/explore/schema")  # cached
    assert len(fake.calls) == n
    fake.schema.labels["BrandNewLabel"] = 1
    body = tc.get("/api/explore/schema", params={"refresh": True}).json()
    assert any(l["name"] == "BrandNewLabel" for l in body["labels"])
    assert json.dumps(body)  # serialisable


# ---------------------------------------------------------------------------
# Context-aware values, no-results diagnosis, overview (Bloom follow-up)
# ---------------------------------------------------------------------------

FEEDS_TOKENS = [T(kind="label", value="View"), T(kind="rel", value="FEEDS", direction="in"), T(kind="label", value="Table")]


def test_chain_values_query_respects_whole_pattern() -> None:
    cy, params = builder.chain_values_query([*FEEDS_TOKENS, T(kind="property", value="name")], make_schema())
    assert cy.startswith("MATCH (n0:`View`)<-[r0:`FEEDS`]-(n1:`Table`)")
    assert "DISTINCT n1.`name` AS value" in cy and "CONTAINS toLower($q)" in cy
    assert check_read_only(cy).ok and params == {"limit": 10}


def test_chain_values_keeps_earlier_filters_and_skips_the_pending_one() -> None:
    toks = [T(kind="label", value="Table"), T(kind="property", value="platform"), T(kind="value", value="PostgreSQL"),
            T(kind="property", value="name")]
    cy, params = builder.chain_values_query(toks, make_schema())
    assert "toLower(toString(n0.`platform`)) = toLower($v0_0)" in cy and params["v0_0"] == "PostgreSQL"
    assert "n0.`name` IS NOT NULL" in cy and "$v0_1" not in cy
    with pytest.raises(SearchError):
        builder.chain_values_query([T(kind="label", value="Table")], make_schema())


def test_suggest_values_use_the_chain() -> None:
    run = FakeRun([{"value": "customers"}, {"value": "accounts"}, {"value": "branches"}])
    items = suggest("", [*FEEDS_TOKENS, T(kind="property", value="name")], make_schema(), run, phrases())
    assert [i["title"] for i in items] == ["customers", "accounts", "branches"]
    assert "<-[r0:`FEEDS`]-" in run.calls[0][0]


class ScriptedRun:
    """Answers diagnosis queries by pattern."""

    def __init__(self, answers: list[tuple[str, list[dict[str, Any]]]]):
        self.answers = answers
        self.calls: list[str] = []

    def __call__(self, cypher: str, params: dict[str, Any]) -> QueryResult:
        self.calls.append(cypher)
        for needle, rows in self.answers:
            if needle in cypher:
                return QueryResult([], rows, {"nodes": [], "relationships": []}, {}, False)
        return QueryResult([], [], {"nodes": [], "relationships": []}, {}, False)


def test_diagnose_value_exists_but_not_in_pattern() -> None:
    from app.explore.explain import diagnose

    toks = [*FEEDS_TOKENS, T(kind="property", value="name"), T(kind="value", value="loans")]
    run = ScriptedRun([
        ("MATCH (n0:`Table`) WHERE", [{"c": 1}]),
        ("RETURN DISTINCT toString(n1.`name`)", [{"value": "accounts"}, {"value": "branches"}, {"value": "customers"}]),
    ])
    d = diagnose(toks, make_schema(), run)
    assert d["message"] == (
        "Table with name = 'loans' exists (1), but none of them has a FEEDS relationship to a View. "
        "Tables that do: accounts, branches, customers."
    )
    assert [f["title"] for f in d["fixes"]] == ["accounts", "branches", "customers"]
    assert d["fixes"][0]["tokens"][-1] == {"kind": "value", "value": "accounts", "direction": "out", "params": {}}
    assert all(check_read_only(c).ok for c in run.calls)


def test_diagnose_value_does_not_exist() -> None:
    from app.explore.explain import diagnose

    toks = [T(kind="label", value="Table"), T(kind="property", value="name"), T(kind="value", value="loanz")]
    run = ScriptedRun([("count(DISTINCT n0)", [{"c": 0}]), ("WITH DISTINCT n.`name`", [{"value": "loans"}])])
    d = diagnose(toks, make_schema(), run)
    assert d["message"].startswith("No Table with name = 'loanz' exists.") and d["fixes"][0]["title"] == "loans"


def test_diagnose_missing_relationship_hop() -> None:
    from app.explore.explain import diagnose

    toks = [T(kind="label", value="Pipeline"), T(kind="rel", value="CONTAINS"), T(kind="label", value="Activity")]
    d = diagnose(toks, make_schema(), ScriptedRun([("count(DISTINCT n0)", [{"c": 0}])]))
    assert d["message"] == "No Pipeline has a CONTAINS relationship to a Activity."


class OverviewClient(FakeClient):
    def run_read(self, query, params=None, max_rows=None, timeout=None):
        if query.startswith("MATCH (n) WITH n LIMIT $limit"):
            self.overview_params = params
            node = lambda i: {"$type": "node", "elementId": f"n{i}", "labels": ["Table"], "properties": {"name": f"t{i}"}}
            outside = {"$type": "node", "elementId": "x", "labels": ["Table"], "properties": {}}
            graph = {
                "nodes": [node(1), node(2), outside],
                "relationships": [
                    {"$type": "relationship", "elementId": "r1", "type": "FEEDS", "startNodeElementId": "n1", "endNodeElementId": "n2", "properties": {}},
                    {"$type": "relationship", "elementId": "r2", "type": "FEEDS", "startNodeElementId": "n1", "endNodeElementId": "x", "properties": {}},
                ],
            }
            return QueryResult(["ns", "rels"], [{"ns": [node(1), node(2)], "rels": []}], graph, {}, False)
        if query == builder.COUNT_NODES:
            return QueryResult(["total"], [{"total": 530}], {"nodes": [], "relationships": []}, {}, False)
        return super().run_read(query, params, max_rows, timeout)


def test_api_overview(tmp_path) -> None:
    fake = OverviewClient()
    app = create_app(Settings(mode="live", static_dir="__none__"), client=fake,  # type: ignore[arg-type]
                     phrase_store=PhraseStore(tmp_path / "p.json"))
    with TestClient(app) as tc:
        body = tc.post("/api/explore/overview", json={"limit": 2}).json()
        assert fake.overview_params == {"limit": 2}
        assert [n["elementId"] for n in body["nodes"]] == ["n1", "n2"]
        assert [r["elementId"] for r in body["relationships"]] == ["r1"]  # only between returned nodes
        assert body["total_nodes"] == 530 and body["truncated"] is True
        assert tc.post("/api/explore/overview", json={"limit": 5000}).status_code == 422
    assert check_read_only(builder.OVERVIEW).ok
