"""Saved, named, parameterised Cypher "search phrases" (stored in data/search_phrases.json).

A phrase name contains its parameters, e.g. ``Lineage of $column``. Each
parameter may name a suggestion source ``Label.property`` used for value
autocomplete. Phrase Cypher must pass the read-only guard.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from ..guard import check_read_only

PARAM_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")
SOURCE_RE = re.compile(r"^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$")


class PhraseParam(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=64)
    source: str | None = Field(default=None, description="Suggestion source 'Label.property'")

    @field_validator("source")
    @classmethod
    def _source(cls, v: str | None) -> str | None:
        if v in (None, ""):
            return None
        if not SOURCE_RE.match(v):
            raise ValueError("source must look like 'Label.property'")
        return v


class PhraseIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    cypher: str = Field(min_length=1, max_length=20_000)
    params: list[PhraseParam] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate(self) -> "PhraseIn":
        res = check_read_only(self.cypher)
        if not res.ok:
            raise ValueError(f"Phrase Cypher must be read-only ('{res.keyword}' is not allowed)")
        names = PARAM_RE.findall(self.name)
        declared = {p.name for p in self.params}
        missing = [n for n in names if n not in declared]
        # Parameters that appear in the name but were not declared are added without a source.
        for n in missing:
            self.params.append(PhraseParam(name=n))
        used = set(PARAM_RE.findall(self.cypher))
        for p in self.params:
            if p.name not in used:
                raise ValueError(f"Parameter ${p.name} is not used in the Cypher")
        return self


class Phrase(PhraseIn):
    id: str
    builtin: bool = False


DEFAULT_PHRASES: list[dict[str, Any]] = [
    {
        "id": "lineage-of-column",
        "name": "Lineage of $column",
        "description": "Upstream and downstream FLOWS_TO paths for a column.",
        "cypher": (
            "MATCH (c:Column)\n"
            "WHERE toLower(c.name) = toLower($column) OR toLower(c.table + '.' + c.name) = toLower($column) "
            "OR c.id = $column\n"
            "RETURN c,\n"
            "  [p = (:Column)-[:FLOWS_TO*1..6]->(c) | p] AS upstream,\n"
            "  [p = (c)-[:FLOWS_TO*1..6]->(:Column) | p] AS downstream"
        ),
        "params": [{"name": "column", "source": "Column.name"}],
    },
    {
        "id": "impact-of-table",
        "name": "Impact of changing $table",
        "description": "Every column and table downstream of a table or view.",
        "cypher": (
            "MATCH (t)\n"
            "WHERE (t:Table OR t:View) AND (toLower(t.full_name) = toLower($table) "
            "OR toLower(t.name) = toLower($table) OR t.id = $table)\n"
            "RETURN t,\n"
            "  [p = (t)-[:HAS_COLUMN]->(:Column)-[:FLOWS_TO*1..6]->(:Column)<-[:HAS_COLUMN]-() | p] AS impact,\n"
            "  [p = (t)-[:FEEDS]->() | p] AS feeds"
        ),
        "params": [{"name": "table", "source": "Table.full_name"}],
    },
    {
        "id": "where-does-pii-flow",
        "name": "Where does PII flow",
        "description": "PII columns, their classification and every downstream flow.",
        "cypher": (
            "MATCH (c:Column) WHERE c.is_pii = true\n"
            "RETURN c,\n"
            "  [p = (c)-[:FLOWS_TO*1..4]->(:Column) | p] AS flows,\n"
            "  [p = (c)-[:CLASSIFIED_AS]->() | p] AS classification"
        ),
        "params": [],
    },
    {
        "id": "policy-clauses-for-column",
        "name": "Policy clauses for $column",
        "description": "PolicyChunk / PolicyDocument nodes linked to a column within 1-2 hops.",
        "cypher": (
            "MATCH (c:Column)\n"
            "WHERE toLower(c.name) = toLower($column) OR toLower(c.table + '.' + c.name) = toLower($column) "
            "OR c.id = $column\n"
            "RETURN c,\n"
            "  [p = (c)-[*1..2]-(x) WHERE x:PolicyChunk OR x:PolicyDocument | p] AS policy"
        ),
        "params": [{"name": "column", "source": "Column.name"}],
    },
    {
        "id": "pipeline",
        "name": "Pipeline $pipeline",
        "description": "A pipeline with its activities, notebooks and the tables they read / write.",
        "cypher": (
            "MATCH (pl:Pipeline)\n"
            "WHERE toLower(pl.name) = toLower($pipeline) OR pl.id = $pipeline\n"
            "RETURN pl,\n"
            "  [p = (pl)-[:CONTAINS]->(:Activity) | p] AS activities,\n"
            "  [p = (pl)-[:CONTAINS]->(:Activity)-[]->() | p] AS io"
        ),
        "params": [{"name": "pipeline", "source": "Pipeline.name"}],
    },
]


class PhraseStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> list[Phrase]:
        if not self.path.exists():
            phrases = [Phrase(**p, builtin=True) for p in DEFAULT_PHRASES]
            self._write(phrases)
            return phrases
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        return [Phrase(**p) for p in raw]

    def _write(self, phrases: list[Phrase]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([p.model_dump() for p in phrases], indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list(self) -> list[Phrase]:
        with self._lock:
            return self._read()

    def get(self, phrase_id: str) -> Phrase | None:
        return next((p for p in self.list() if p.id == phrase_id), None)

    def create(self, data: PhraseIn) -> Phrase:
        with self._lock:
            phrases = self._read()
            phrase = Phrase(**data.model_dump(), id=uuid.uuid4().hex[:12])
            phrases.append(phrase)
            self._write(phrases)
            return phrase

    def update(self, phrase_id: str, data: PhraseIn) -> Phrase | None:
        with self._lock:
            phrases = self._read()
            for i, p in enumerate(phrases):
                if p.id == phrase_id:
                    phrases[i] = Phrase(**data.model_dump(), id=phrase_id, builtin=p.builtin)
                    self._write(phrases)
                    return phrases[i]
            return None

    def delete(self, phrase_id: str) -> bool:
        with self._lock:
            phrases = self._read()
            kept = [p for p in phrases if p.id != phrase_id]
            if len(kept) == len(phrases):
                return False
            self._write(kept)
            return True


# ---------------------------------------------------------------------------
# Matching typed text against phrase names (for suggestions)
# ---------------------------------------------------------------------------


def static_prefix(name: str) -> str:
    """'Lineage of $column' -> 'Lineage of '."""
    m = PARAM_RE.search(name)
    return name[: m.start()] if m else name


def match_phrase(name: str, q: str) -> tuple[str, str | None] | None:
    """How the typed text `q` relates to phrase `name`.

    Returns ("fill", None) when q is a prefix of / contained in the phrase,
    ("param", partial) when q already contains the static prefix and the rest
    is a partial value for the first parameter, or None.
    """
    ql = q.strip().lower()
    if not ql:
        return ("fill", None)
    prefix = static_prefix(name)
    pl = prefix.lower()
    if PARAM_RE.search(name) and pl.strip() and q.lower().startswith(pl):
        return ("param", q[len(prefix):].strip())
    words = PARAM_RE.sub("", name).lower()
    if words.startswith(ql) or ql in words:
        return ("fill", None)
    return None
