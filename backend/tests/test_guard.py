import pytest

from app.guard import ReadOnlyViolation, check_read_only, ensure_read_only, strip_literals

BLOCKED = [
    ("CREATE (n:Test)", "CREATE"),
    ("create (n:Test) return n", "CREATE"),
    ("MATCH (n) MERGE (m:X {id: 1})", "MERGE"),
    ("MATCH (n) DELETE n", "DELETE"),
    ("MATCH (n) DETACH DELETE n", "DELETE"),
    ("MATCH (n) SET n.name = 'x'", "SET"),
    ("MATCH (n) SET n:Label", "SET"),
    ("MATCH (n) REMOVE n.name", "REMOVE"),
    ("DROP INDEX my_index", "DROP"),
    ("DROP CONSTRAINT c IF EXISTS", "DROP"),
    ("LOAD CSV FROM 'file:///x.csv' AS row RETURN row", "LOAD CSV"),
    ("load   csv with headers from 'x' as r return r", "LOAD CSV"),
    ("MATCH (n) CALL { WITH n RETURN n AS m } IN TRANSACTIONS OF 10 ROWS RETURN m", "IN TRANSACTIONS"),
    ("UNWIND range(1,3) AS i CALL { RETURN i } IN 4 CONCURRENT TRANSACTIONS RETURN i", "IN TRANSACTIONS"),
    ("MATCH (n) FOREACH (x IN [1] | SET n.a = x)", "SET"),
    ("CALL apoc.create.node(['X'], {}) YIELD node RETURN node", "apoc.create.node"),
    # the SET is inside a string, but the procedure itself is blocked
    ("CALL apoc.periodic.iterate('MATCH (n) RETURN n', 'SET n.x = 1', {})", "apoc.periodic.iterate"),
    ("CALL apoc.refactor.mergeNodes([])", "apoc.refactor.mergeNodes"),
    ("CALL apoc.cypher.doIt('x', {})", "apoc.cypher.doIt"),
    ("CALL apoc.load.json('http://example.com')", "apoc.load.json"),
    ("CALL dbms.listConfig()", "dbms.listConfig"),
    ("CALL dbms.security.createUser('a','b')", "dbms.security.createUser"),
    ("CALL db.create.setNodeVectorProperty(n, 'v', [1.0])", "db.create.setNodeVectorProperty"),
    ("CALL apoc . refactor . rename . label('A', 'B')", "apoc . refactor . rename . label"),
    ("GRANT ROLE admin TO bob", "GRANT"),
    ("ALTER USER bob SET PASSWORD 'x'", "SET"),
    ("STOP DATABASE neo4j", "STOP DATABASE"),
    # write keyword after a string that contains a quote escape
    ("MATCH (n {name: 'it\\'s'}) DELETE n", "DELETE"),
    # write keyword after a comment
    ("// just a comment\nCREATE (n)", "CREATE"),
    ("MATCH (n) /* comment */ DELETE n", "DELETE"),
]

ALLOWED = [
    "MATCH (n) RETURN n LIMIT 25",
    "CALL db.schema.visualization()",
    "CALL db.labels() YIELD label RETURN label",
    "CALL dbms.components()",
    "MATCH p = (:Table)-[:HAS_COLUMN]->(:Column) RETURN p",
    # keywords inside strings
    "MATCH (n) WHERE n.name = 'CREATE TABLE x; DELETE FROM y' RETURN n",
    'MATCH (n) WHERE n.comment CONTAINS "set by the merge job" RETURN n',
    "RETURN 'DETACH DELETE' AS s",
    # keywords inside comments
    "MATCH (n) // DELETE n later\nRETURN n",
    "MATCH (n) /* SET n.x = 1 */ RETURN n",
    # keywords inside back-tick identifiers
    "MATCH (n:`CREATE`) RETURN n",
    "MATCH (n) RETURN n.`delete me` AS x",
    # keywords used as property names, labels, map keys, parameters
    "MATCH (n) RETURN n.set, n.create, n.merge",
    "MATCH (n:Set) RETURN n",
    "RETURN {create: 1, delete: 2} AS m",
    "MATCH (n) WHERE n.id = $delete RETURN n",
    # keyword fragments inside identifiers
    "MATCH (n) WHERE n.created_at > date() RETURN n.offset, n.dataset, n.removed_flag",
    "MATCH (c:Column {is_pii:true})-[f:FLOWS_TO]->(d:Column) RETURN c.table, c.name, f.transformation, "
    "CASE WHEN f.transformation IN ['DIRECT','CAST'] AND d.platform STARTS WITH 'Fabric' "
    "THEN 'VIOLATION' ELSE 'OK' END AS status",
    "MATCH (n) WHERE n.name IN ['a'] RETURN n",
    "CALL apoc.meta.schema() YIELD value RETURN value",
    "RETURN apoc.text.join(['a', 'b'], ',') AS s",
]


@pytest.mark.parametrize(("query", "keyword"), BLOCKED)
def test_blocked(query: str, keyword: str) -> None:
    res = check_read_only(query)
    assert not res.ok, query
    assert res.keyword == keyword
    with pytest.raises(ReadOnlyViolation) as exc:
        ensure_read_only(query)
    assert "read-only" in str(exc.value)


@pytest.mark.parametrize("query", ALLOWED)
def test_allowed(query: str) -> None:
    assert check_read_only(query).ok, query
    ensure_read_only(query)


def test_strip_literals_preserves_length() -> None:
    q = "MATCH (n {a: 'x\\'y'}) // c\nRETURN `we``ird`, \"s\" /* b */"
    out = strip_literals(q)
    assert len(out) == len(q)
    assert "x" not in out.split("RETURN")[0].split("{")[1]
    assert "we" not in out and "ird" not in out


def test_unterminated_string_is_safe() -> None:
    # Everything after an unterminated quote is treated as string content.
    assert check_read_only("RETURN 'CREATE (n)").ok
    assert not check_read_only("CREATE (n) RETURN 'x").ok
