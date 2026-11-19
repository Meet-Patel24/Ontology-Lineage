"""Static read-only guard for user supplied Cypher.

This is the *second* layer of protection: every query is also executed in a
READ access-mode transaction, so the database itself rejects writes. The guard
gives users a fast, friendly error and blocks admin procedures that a READ
transaction might still allow.

Matches inside string literals, back-tick quoted identifiers and comments are
ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


class ReadOnlyViolation(ValueError):
    """Raised when a query contains a write or admin clause."""

    def __init__(self, keyword: str):
        self.keyword = keyword
        super().__init__(
            f"This app is read-only: '{keyword}' is not allowed. "
            "Only read queries (MATCH, RETURN, CALL of read procedures, ...) can be run."
        )


def strip_literals(query: str) -> str:
    """Replace string literals, back-tick identifiers and comments with spaces.

    The output has the same length as the input so positions stay meaningful.
    """
    out: list[str] = []
    i, n = 0, len(query)
    while i < n:
        ch = query[i]
        nxt = query[i + 1] if i + 1 < n else ""
        # line comment
        if ch == "/" and nxt == "/":
            j = query.find("\n", i)
            j = n if j == -1 else j
            out.append(" " * (j - i))
            i = j
            continue
        # block comment
        if ch == "/" and nxt == "*":
            j = query.find("*/", i + 2)
            j = n if j == -1 else j + 2
            out.append(_blank(query[i:j]))
            i = j
            continue
        # string literal or quoted identifier
        if ch in ("'", '"', "`"):
            quote = ch
            j = i + 1
            while j < n:
                c = query[j]
                if c == "\\" and quote != "`":
                    j += 2
                    continue
                if c == quote:
                    # `` inside a back-tick identifier is an escaped back-tick
                    if quote == "`" and j + 1 < n and query[j + 1] == "`":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            j = min(j, n)
            # keep the quotes so tokens on either side are not glued together
            out.append(quote + _blank(query[i + 1 : j - 1]) + (quote if j - i >= 2 else ""))
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _blank(s: str) -> str:
    return "".join("\n" if c == "\n" else " " for c in s)


# A keyword must stand alone: not part of an identifier, not a property access
# (`n.set`), label (`:Set`), parameter (`$delete`) or map key (`{create: 1}`).
_KW = r"(?<![\w.:$]){kw}(?![\w:])"

_WRITE_CLAUSES: list[tuple[str, str]] = [
    ("CREATE", _KW.format(kw="CREATE")),
    ("MERGE", _KW.format(kw="MERGE")),
    ("DELETE", _KW.format(kw="DELETE")),
    ("DETACH", _KW.format(kw="DETACH")),
    ("SET", _KW.format(kw="SET")),
    ("REMOVE", _KW.format(kw="REMOVE")),
    ("DROP", _KW.format(kw="DROP")),
    ("FOREACH", _KW.format(kw="FOREACH")),
    ("LOAD CSV", r"(?<![\w.:$])LOAD\s+CSV(?![\w:])"),
    ("IN TRANSACTIONS", r"(?<![\w.:$])IN\s+(?:\d+\s+)?(?:CONCURRENT\s+)?TRANSACTIONS(?![\w:])"),
    ("ALTER", _KW.format(kw="ALTER")),
    ("GRANT", _KW.format(kw="GRANT")),
    ("DENY", _KW.format(kw="DENY")),
    ("REVOKE", _KW.format(kw="REVOKE")),
    ("TERMINATE", _KW.format(kw="TERMINATE")),
    ("START DATABASE", r"(?<![\w.:$])START\s+DATABASE(?![\w:])"),
    ("STOP DATABASE", r"(?<![\w.:$])STOP\s+DATABASE(?![\w:])"),
    ("ENABLE SERVER", r"(?<![\w.:$])ENABLE\s+SERVER(?![\w:])"),
]

# Procedures that write data, change schema or administer the DBMS.
_BLOCKED_PROCEDURE_PREFIXES = [
    "apoc.create.",
    "apoc.merge.",
    "apoc.refactor.",
    "apoc.periodic.",
    "apoc.do.",
    "apoc.trigger.",
    "apoc.load.",
    "apoc.import.",
    "apoc.export.",
    "apoc.cypher.",  # runWrite / doIt / runFile execute arbitrary Cypher
    "apoc.nodes.delete",
    "apoc.nodes.link",
    "apoc.schema.assert",
    "apoc.atomic.",
    "apoc.lock.",
    "apoc.systemdb.",
    "apoc.static.set",
    "apoc.uuid.",
    "apoc.ttl.",
    "apoc.custom.",
    "apoc.graph.fromdocument",
    "db.create.",
    "db.clearquerycaches",
    "db.index.fulltext.createnodeindex",
    "db.index.fulltext.createrelationshipindex",
    "db.index.fulltext.drop",
    "db.index.vector.createnodeindex",
    "db.awaitindex",
    "gds.",  # graph data science: projections and write-back
    "genai.",  # may call external services with credentials
]

# dbms.* procedures are admin/introspection; only these harmless ones are allowed.
_ALLOWED_DBMS = {
    "dbms.components",
    "dbms.info",
    "dbms.showcurrentuser",
    "dbms.clientconfig",
    "dbms.procedures",
    "dbms.functions",
}

_QUALIFIED_NAME = re.compile(r"(?<![\w.])([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)+)")


@dataclass(frozen=True)
class GuardResult:
    ok: bool
    keyword: str | None = None


def check_read_only(query: str) -> GuardResult:
    """Return whether *query* looks read-only."""
    cleaned = strip_literals(query)
    upper = cleaned.upper()
    for name, pattern in _WRITE_CLAUSES:
        if re.search(pattern, upper):
            return GuardResult(False, name)

    for m in _QUALIFIED_NAME.finditer(cleaned):
        qname = re.sub(r"\s+", "", m.group(1)).lower()
        if qname.startswith("dbms."):
            if qname not in _ALLOWED_DBMS:
                return GuardResult(False, m.group(1))
            continue
        for prefix in _BLOCKED_PROCEDURE_PREFIXES:
            if qname.startswith(prefix):
                return GuardResult(False, m.group(1))
    return GuardResult(True)


def ensure_read_only(query: str) -> None:
    """Raise :class:`ReadOnlyViolation` if *query* contains a write/admin clause."""
    res = check_read_only(query)
    if not res.ok:
        raise ReadOnlyViolation(res.keyword or "write clause")
