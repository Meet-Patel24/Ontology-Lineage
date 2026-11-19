import datetime as dt
import json
import math
from decimal import Decimal

from neo4j.graph import Graph, Node, Path, Relationship
from neo4j.spatial import CartesianPoint, WGS84Point
from neo4j.time import Date, DateTime, Duration, Time

from app.serialization import GraphCollector, serialize_record, serialize_value


def make_graph():
    g = Graph()
    a = Node(g, "4:db:1", 1, {"Table", "Asset"}, {"id": "pg:bankdb.banking.loans", "name": "loans"})
    b = Node(g, "4:db:2", 2, {"Column", "Asset"}, {"id": "pg:bankdb.banking.loans.loan_status", "is_pii": False})
    c = Node(g, "4:db:3", 3, {"Column", "Asset"}, {"id": "fabric:x.risk_bucket"})
    has_col = g.relationship_type("HAS_COLUMN")(g, "5:db:10", 10, {})
    has_col._start_node, has_col._end_node = a, b
    flows = g.relationship_type("FLOWS_TO")(g, "5:db:11", 11, {"transformation": "DERIVED"})
    flows._start_node, flows._end_node = b, c
    return a, b, c, has_col, flows


def test_node() -> None:
    a, *_ = make_graph()
    out = serialize_value(a)
    assert out == {
        "$type": "node",
        "elementId": "4:db:1",
        "labels": ["Asset", "Table"],
        "properties": {"id": "pg:bankdb.banking.loans", "name": "loans"},
    }


def test_relationship() -> None:
    *_, flows = make_graph()
    out = serialize_value(flows)
    assert out["$type"] == "relationship"
    assert out["type"] == "FLOWS_TO"
    assert out["startNodeElementId"] == "4:db:2"
    assert out["endNodeElementId"] == "4:db:3"
    assert out["properties"] == {"transformation": "DERIVED"}


def test_path() -> None:
    a, b, c, has_col, flows = make_graph()
    p = Path(a, has_col, flows)
    out = serialize_value(p)
    assert out["$type"] == "path"
    assert out["length"] == 2
    assert out["start"]["elementId"] == "4:db:1"
    assert out["end"]["elementId"] == "4:db:3"
    assert [s["relationship"]["type"] for s in out["segments"]] == ["HAS_COLUMN", "FLOWS_TO"]
    assert out["segments"][1]["start"]["elementId"] == "4:db:2"


def test_temporal_and_spatial() -> None:
    assert serialize_value(Date(2024, 5, 17)) == "2024-05-17"
    assert serialize_value(DateTime(2024, 5, 17, 10, 30, 0)) == "2024-05-17T10:30:00.000000000"
    assert serialize_value(Time(10, 30, 15)) == "10:30:15.000000000"
    assert serialize_value(Duration(days=3, hours=4)) == "P3DT4H"
    assert serialize_value(dt.date(2024, 1, 2)) == "2024-01-02"
    assert serialize_value(dt.datetime(2024, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc)) == "2024-01-02T03:04:05+00:00"
    assert serialize_value(CartesianPoint((1.0, 2.0))) == "point({srid: 7203, x: 1.0, y: 2.0})"
    assert serialize_value(WGS84Point((4.9, 52.3, 10.0))) == "point({srid: 4979, x: 4.9, y: 52.3, z: 10.0})"


def test_scalars_and_collections() -> None:
    assert serialize_value(None) is None
    assert serialize_value(True) is True
    assert serialize_value(42) == 42
    assert serialize_value(2**60) == str(2**60)  # beyond JS safe integer range
    assert serialize_value(math.nan) == "nan"
    assert serialize_value(math.inf) == "inf"
    assert serialize_value(Decimal("1.50")) == "1.50"
    assert serialize_value(b"\x00\x01") == "AAE="
    a, *_ = make_graph()
    nested = serialize_value({"list": [1, {"n": a}], "date": Date(2024, 1, 1)})
    assert nested["list"][1]["n"]["$type"] == "node"
    assert nested["date"] == "2024-01-01"


def test_collector_dedupes_and_includes_endpoints() -> None:
    a, b, c, has_col, flows = make_graph()
    collector = GraphCollector()
    keys = ["p", "r", "nodes"]
    rec = serialize_record(keys, [Path(a, has_col), flows, [a, b, b]], collector)
    graph = collector.to_dict()
    assert sorted(n["elementId"] for n in graph["nodes"]) == ["4:db:1", "4:db:2", "4:db:3"]
    assert sorted(r["elementId"] for r in graph["relationships"]) == ["5:db:10", "5:db:11"]
    assert rec["r"]["type"] == "FLOWS_TO"
    # The whole result is JSON serialisable.
    json.dumps({"record": rec, "graph": graph})
