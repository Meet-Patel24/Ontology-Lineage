import runpy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.snapshot import SnapshotRepository

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def demo_data() -> tuple[list[dict], list[dict]]:
    """Nodes/edges of the demo snapshot, generated fresh from the build script."""
    mod = runpy.run_path(str(ROOT / "scripts" / "build_demo_snapshot.py"))
    return mod["nodes"], mod["edges"]


@pytest.fixture(scope="session")
def repo(demo_data) -> SnapshotRepository:
    return SnapshotRepository(*demo_data)


@pytest.fixture()
def client(repo) -> TestClient:
    app = create_app(Settings(mode="snapshot", static_dir=ROOT / "__no_frontend__"), repo=repo)
    with TestClient(app) as c:
        yield c
