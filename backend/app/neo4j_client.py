"""Thin wrapper around the Neo4j driver. All user queries run in READ mode."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

from neo4j import READ_ACCESS, Driver, GraphDatabase, unit_of_work
from neo4j.exceptions import AuthError, ConfigurationError, Neo4jError, ServiceUnavailable, SessionExpired

from .config import Settings
from .serialization import GraphCollector, serialize_record, serialize_value

log = logging.getLogger(__name__)

_COUNTER_FIELDS = (
    "nodes_created",
    "nodes_deleted",
    "relationships_created",
    "relationships_deleted",
    "properties_set",
    "labels_added",
    "labels_removed",
    "indexes_added",
    "indexes_removed",
    "constraints_added",
    "constraints_removed",
    "system_updates",
)


@dataclass
class QueryResult:
    keys: list[str]
    records: list[dict[str, Any]]
    graph: dict[str, list[dict[str, Any]]]
    summary: dict[str, Any]
    truncated: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "keys": self.keys,
            "records": self.records,
            "graph": self.graph,
            "summary": self.summary,
            "truncated": self.truncated,
        }


class DatabaseUnavailable(RuntimeError):
    """The database could not be reached (network, DNS, auth)."""


def _summary_to_dict(summary: Any, wall_ms: float) -> dict[str, Any]:
    counters = {f: getattr(summary.counters, f, 0) for f in _COUNTER_FIELDS}
    counters = {k: v for k, v in counters.items() if v}
    notifications = []
    for n in getattr(summary, "summary_notifications", None) or []:
        pos = getattr(n, "position", None)
        notifications.append(
            {
                "code": n.code,
                "title": n.title,
                "description": n.description,
                "severity": getattr(n, "raw_severity_level", "") or str(getattr(n, "severity_level", "")),
                "category": getattr(n, "raw_category", ""),
                "position": (
                    {"offset": pos.offset, "line": pos.line, "column": pos.column} if pos is not None else None
                ),
            }
        )
    return {
        "available_after_ms": summary.result_available_after,
        "consumed_after_ms": summary.result_consumed_after,
        "wall_ms": round(wall_ms, 1),
        "query_type": summary.query_type,
        "counters": counters,
        "notifications": notifications,
        "database": getattr(summary, "database", None),
        "server": getattr(getattr(summary, "server", None), "agent", None),
    }


class Neo4jClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._driver: Driver | None = None
        self._lock = threading.Lock()

    # -- connection ------------------------------------------------------------

    def _create_driver(self) -> Driver:
        return GraphDatabase.driver(
            self.settings.neo4j_uri,
            auth=(self.settings.neo4j_user, self.settings.neo4j_password),
            connection_timeout=10,
            max_transaction_retry_time=5,
            user_agent="lineage-studio/1.0",
        )

    @property
    def driver(self) -> Driver:
        with self._lock:
            if self._driver is None:
                self._driver = self._create_driver()
            return self._driver

    def close(self) -> None:
        with self._lock:
            if self._driver is not None:
                self._driver.close()
                self._driver = None

    def reconnect(self) -> dict[str, Any]:
        self.close()
        return self.health()

    def health(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "connected": False,
            "host": self.settings.neo4j_host,
            "database": self.settings.neo4j_database,
            "user": self.settings.neo4j_user,
            "server_version": None,
            "server_edition": None,
            "error": None,
        }
        try:
            self.driver.verify_connectivity()
            with self.driver.session(database=self.settings.neo4j_database, default_access_mode=READ_ACCESS) as s:
                rows = s.run("CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition").fetch(1)
                rec = rows[0] if rows else None
                if rec:
                    info["server_version"] = (rec["versions"] or [None])[0]
                    info["server_edition"] = rec["edition"]
            info["connected"] = True
        except AuthError:
            info["error"] = "Authentication failed: check NEO4J_USER / NEO4J_PASSWORD."
        except ConfigurationError as exc:
            info["error"] = f"Invalid configuration (check NEO4J_URI in .env): {exc}"
        except (ServiceUnavailable, SessionExpired, OSError) as exc:
            log.warning("Neo4j unavailable: %s", exc)
            info["error"] = (
                f"Cannot connect to {self.settings.neo4j_host}:7687. Either the port is blocked, or a corporate "
                "proxy is intercepting TLS (then try NEO4J_URI=neo4j+ssc://...)."
            )
        except Neo4jError as exc:
            info["error"] = f"{exc.code}: {exc.message}"
        except ValueError as exc:
            # The driver raises ValueError("Cannot resolve address host:port") when DNS lookup fails.
            log.warning("Neo4j address problem: %s", exc)
            if "resolve address" in str(exc):
                info["error"] = (
                    f"Cannot resolve host '{self.settings.neo4j_host}'. Check NEO4J_URI in .env for typos or the "
                    "xxxxxxxx placeholder, and check that this machine can reach the internet / DNS."
                )
            else:
                info["error"] = f"Invalid NEO4J_URI: {exc}"
        except Exception as exc:  # noqa: BLE001 - surfaced as status, never as a stack trace
            log.exception("Unexpected error during health check")
            info["error"] = f"Unexpected error: {type(exc).__name__}"
        return info

    # -- queries ---------------------------------------------------------------

    def run_read(
        self,
        query: str,
        params: dict[str, Any] | None = None,
        max_rows: int | None = None,
        timeout: float | None = None,
    ) -> QueryResult:
        max_rows = max_rows or self.settings.max_rows
        timeout = timeout or self.settings.query_timeout_seconds

        @unit_of_work(timeout=timeout)
        def work(tx):  # type: ignore[no-untyped-def]
            result = tx.run(query, params or {})
            keys = list(result.keys())
            collector = GraphCollector()
            records: list[dict[str, Any]] = []
            truncated = False
            for i, rec in enumerate(result):
                if i >= max_rows:
                    truncated = True
                    break
                records.append(serialize_record(keys, list(rec.values()), collector))
            summary = result.consume()
            return keys, records, collector.to_dict(), summary, truncated

        started = time.perf_counter()
        try:
            with self.driver.session(
                database=self.settings.neo4j_database, default_access_mode=READ_ACCESS
            ) as session:
                keys, records, graph, summary, truncated = session.execute_read(work)
        except (ServiceUnavailable, SessionExpired, AuthError, ConfigurationError, OSError) as exc:
            raise DatabaseUnavailable(str(exc)) from exc
        except ValueError as exc:
            if "resolve address" not in str(exc):
                raise
            raise DatabaseUnavailable(f"Cannot resolve the Neo4j host ({exc}). Check NEO4J_URI and DNS.") from exc
        wall_ms = (time.perf_counter() - started) * 1000
        return QueryResult(keys, records, graph, _summary_to_dict(summary, wall_ms), truncated)

    def scalar_rows(self, query: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return [serialize_value(r) for r in self.run_read(query, params, max_rows=100_000).records]
