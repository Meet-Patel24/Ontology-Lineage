"""Snapshot-mode lineage functions and the API endpoints that use them."""

from app import cypher, lineage
from app.main import inline_params

RISK = "fabric:Ontology_Lineage.fact.loan_portfolio.risk_bucket"
LOANS = "pg:bankdb.banking.loans"
CUSTOMERS = "pg:bankdb.banking.customers"


def short(node_id: str) -> str:
    return node_id.rsplit(".", 1)[-1]


# -- repository ----------------------------------------------------------------


def test_resolve(repo) -> None:
    assert repo.resolve(RISK).id == RISK
    assert repo.resolve("fact.loan_portfolio.risk_bucket").id == RISK
    assert repo.resolve("banking.customers").id == CUSTOMERS
    assert repo.resolve("does.not.exist") is None


def test_search_ranks_exact_name_first(repo) -> None:
    hits = repo.search("risk_bucket")
    assert hits[0].id == RISK
    assert all(h.label in {"Table", "View", "Column", "Pipeline", "BusinessConcept"} for h in repo.search("a"))


def test_upstream_column_lineage_of_risk_bucket(repo) -> None:
    start = repo.resolve(RISK)
    sub = repo.lineage(start, "upstream", 3)
    flows = {(short(e.source), e.props["transformation"]) for e in sub.edges_of("FLOWS_TO")}
    assert flows == {("loan_status", "DERIVED"), ("outstanding_amount", "DERIVED"), ("principal_amount", "DERIVED")}
    # owning tables are included
    assert LOANS in sub.nodes


def test_downstream_depth_is_respected(repo) -> None:
    start = repo.resolve(f"{LOANS}.outstanding_amount")
    d1 = repo.lineage(start, "downstream", 1)
    d2 = repo.lineage(start, "downstream", 2)
    t1 = {e.target for e in d1.edges_of("FLOWS_TO")}
    t2 = {e.target for e in d2.edges_of("FLOWS_TO")}
    assert t1 < t2
    assert "fabric:Ontology_Lineage.fact.customer_360.high_risk_loans" in t2
    assert "fabric:Ontology_Lineage.fact.customer_360.high_risk_loans" not in t1


def test_table_level_rollup(repo) -> None:
    start = repo.resolve(LOANS)
    sub = repo.lineage(start, "downstream", 3)
    view, start_ids = lineage.table_level(sub, start)
    assert start_ids == {LOANS}
    assert all(n.label != "Column" for n in view.nodes.values())
    edge = view.edges[f"tbl:{LOANS}->fabric:Ontology_Lineage.fact.loan_portfolio"]
    assert edge.props["transformation"] == "DERIVED"  # DERIVED outranks CAST and DIRECT
    assert set(edge.props["transformations"]) == {"DERIVED", "CAST", "DIRECT"}
    assert edge.props["pipelines"] == ["PL_CP_Loan_Portfolio"]
    # view fed by the table
    assert any(e.type == "FEEDS" for e in view.edges.values())


def test_impact_of_customers(repo) -> None:
    start = repo.resolve(CUSTOMERS)
    rows, summary = lineage.impact(repo.lineage(start, "downstream", 6), start)
    assert summary["table_names"] == ["banking.vw_customer_accounts", "dim.customer", "fact.customer_360"]
    assert summary["pipelines"] == 2
    assert summary["sentence"].startswith("A change here affects 3 tables, ")
    assert min(r["depth"] for r in rows) == 1
    assert any(r["depth"] == 2 and r["target_table"] == "fact.customer_360" for r in rows)


def test_pii_tracker(repo) -> None:
    rows, summary = lineage.pii(repo.pii())
    assert summary["masked_flows"] == 5
    assert summary["violations"] == 0
    assert summary["not_moved"] == 2
    masked = [r for r in rows if r["treatment"] == "MASKED"]
    assert all(r["status"] == "OK" for r in masked)
    assert all(r["target_classification"] == "PII_MASKED" for r in masked)


def test_pii_violation_detected(demo_data) -> None:
    from app.snapshot import SnapshotRepository

    nodes, edges = demo_data
    edges = [*edges, {"from": f"{CUSTOMERS}.first_name", "rel": "FLOWS_TO",
                      "to": "fabric:Ontology_Lineage.dim.customer.city", "transformation": "DIRECT"}]
    rows, summary = lineage.pii(SnapshotRepository(nodes, edges).pii())
    assert summary["violations"] == 1
    assert [r["source_column"] for r in rows if r["status"] == "VIOLATION"] == ["first_name"]


def test_pipelines(repo) -> None:
    rows, summary = lineage.pipelines(repo.pipelines())
    assert summary["pipelines"] == 5
    loan = next(r for r in rows if r["pipeline"] == "PL_CP_Loan_Portfolio" and r["activity"] == "Copy data1")
    assert loan["reads_from"] == ["banking.loans"]
    assert loan["writes_to"] == ["fact.loan_portfolio"]


def test_cypher_builder() -> None:
    q = cypher.lineage("Column", "both", 4)
    assert q.count("UNION") == 2
    assert "FLOWS_TO*1..4" in q
    q = cypher.lineage("Table", "downstream", 2)
    assert "FEEDS*1..2" in q and "<-[:HAS_COLUMN]-" not in q.split("UNION")[1]
    assert inline_params("MATCH (n {id: $id})", {"id": "it's"}) == "MATCH (n {id: 'it\\'s'})"


# -- API -----------------------------------------------------------------------


def test_api_lineage_default_start(client) -> None:
    r = client.get("/api/lineage", params={"id": "fact.loan_portfolio.risk_bucket", "direction": "upstream"})
    assert r.status_code == 200
    body = r.json()
    assert body["start"]["id"] == RISK
    labels = {(short(e["source"]), e["label"]) for e in body["edges"] if e["type"] == "FLOWS_TO"}
    assert labels == {("loan_status", "DERIVED"), ("outstanding_amount", "DERIVED"), ("principal_amount", "DERIVED")}
    assert f"'{RISK}'" in body["cypher"]
    assert next(n for n in body["nodes"] if n["id"] == RISK)["start"] is True


def test_api_pipelines_reverse_reads(client) -> None:
    body = client.get("/api/pipelines").json()
    reads = [e for e in body["edges"] if e["type"] == "READS_FROM"]
    assert reads and all(e["reversed"] for e in reads)
    assert all(e["source"].startswith("pg:") or "Ontology_Lineage" in e["source"] for e in reads)


def test_api_errors(client) -> None:
    r = client.get("/api/lineage", params={"id": "nope"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "LineageStudio.NotFound"
    r = client.get("/api/lineage", params={"id": RISK, "depth": 9})
    assert r.status_code == 422
    r = client.post("/api/query", json={"query": "MATCH (n) RETURN n"})
    assert r.status_code == 503
    assert "snapshot mode" in r.json()["error"]["message"]


def test_api_schema_and_health(client) -> None:
    assert client.get("/api/health").json()["mode"] == "snapshot"
    schema = client.get("/api/schema").json()
    assert {"name": "FLOWS_TO"} .items() <= next(x for x in schema["relationship_types"] if x["name"] == "FLOWS_TO").items()
    graph = client.get("/api/schema/graph").json()
    assert "Asset" not in {n["id"] for n in graph["nodes"]}
