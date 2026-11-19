"""The /api/query endpoint with a fake live client (no database needed)."""

from fastapi.testclient import TestClient
from neo4j.exceptions import ClientError

from app.config import Settings
from app.main import create_app
from app.neo4j_client import QueryResult


class FakeClient:
    def __init__(self, error: Exception | None = None):
        self.calls: list[tuple[str, dict]] = []
        self.error = error

    def run_read(self, query, params=None, max_rows=None, timeout=None):
        self.calls.append((query, params or {}))
        if self.error:
            raise self.error
        return QueryResult(
            ["x"], [{"x": 1}], {"nodes": [], "relationships": []},
            {"query_type": "r", "available_after_ms": 1, "consumed_after_ms": 2}, False,
        )

    def health(self):
        return {"connected": True, "host": "fake", "database": "neo4j", "user": "neo4j"}

    def close(self):
        pass


def make_client(fake: FakeClient) -> TestClient:
    return TestClient(create_app(Settings(mode="live", static_dir="__none__"), client=fake))  # type: ignore[arg-type]


def test_write_query_is_rejected_before_execution() -> None:
    fake = FakeClient()
    with make_client(fake) as tc:
        r = tc.post("/api/query", json={"query": "CREATE (n:Test)"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "LineageStudio.ReadOnly"
    assert "read-only" in r.json()["error"]["message"]
    assert fake.calls == []


def test_read_query_runs_with_params() -> None:
    fake = FakeClient()
    with make_client(fake) as tc:
        r = tc.post("/api/query", json={"query": "MATCH (n) WHERE n.id = $id RETURN n", "params": {"id": "x"}})
    assert r.status_code == 200
    assert r.json()["records"] == [{"x": 1}]
    assert fake.calls == [("MATCH (n) WHERE n.id = $id RETURN n", {"id": "x"})]


def test_neo4j_error_is_reported_without_stack_trace() -> None:
    err = ClientError("Invalid input 'MATCHH'")
    err.code = "Neo.ClientError.Statement.SyntaxError"  # type: ignore[misc]
    with make_client(FakeClient(err)) as tc:
        r = tc.post("/api/query", json={"query": "MATCHH (n) RETURN n"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "Neo.ClientError.Statement.SyntaxError"
    assert "Traceback" not in r.text


def test_empty_query_rejected() -> None:
    with make_client(FakeClient()) as tc:
        r = tc.post("/api/query", json={"query": "   "})
    assert r.status_code == 422
