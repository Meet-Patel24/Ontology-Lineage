"""Export the live lineage graph to data/nodes.json + data/edges.json.

Uses the same NEO4J_* settings as the backend (.env). Run from the repo root:

    backend\\.venv\\Scripts\\python scripts\\export_snapshot.py [output_dir]

The output is what `MODE=snapshot` reads.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from neo4j import READ_ACCESS, GraphDatabase  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.graphmodel import primary_label  # noqa: E402
from app.serialization import serialize_value  # noqa: E402

NODES = "MATCH (n:Asset) RETURN labels(n) AS labels, properties(n) AS props ORDER BY n.id"
EDGES = """MATCH (a:Asset)-[r]->(b:Asset)
RETURN a.id AS src, type(r) AS rel, b.id AS dst, properties(r) AS props
ORDER BY src, rel, dst"""


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data"
    s = get_settings()
    driver = GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password))
    try:
        driver.verify_connectivity()
        with driver.session(database=s.neo4j_database, default_access_mode=READ_ACCESS) as session:
            nodes = []
            for rec in session.run(NODES):
                props = serialize_value(dict(rec["props"]))
                labels = [lbl for lbl in rec["labels"] if lbl != "Asset"]
                nodes.append(
                    {
                        "id": props.pop("id"),
                        "label": primary_label(labels),
                        "name": props.pop("name", None),
                        **({"labels": labels} if len(labels) > 1 else {}),
                        **props,
                    }
                )
            edges = [
                {"from": rec["src"], "rel": rec["rel"], "to": rec["dst"], **serialize_value(dict(rec["props"]))}
                for rec in session.run(EDGES)
            ]
    finally:
        driver.close()

    out.mkdir(parents=True, exist_ok=True)
    (out / "nodes.json").write_text(json.dumps(nodes, indent=1), encoding="utf-8")
    (out / "edges.json").write_text(json.dumps(edges, indent=1), encoding="utf-8")
    print(f"Exported {len(nodes)} nodes and {len(edges)} edges to {out}")


if __name__ == "__main__":
    main()
