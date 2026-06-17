"""
Integration tests for FastAPI endpoints.
Uses FastAPI's TestClient — no running server needed.
All external services are mocked via conftest.py.

Run with:
    pytest tests/ -v
"""

import os
import sys
import hashlib
import pytest
from concurrent.futures import Future as RealFuture
from unittest.mock import MagicMock


def noop_executor():
    """Return a mock executor whose submit() returns a real, already-done Future.
    asyncio.run_in_executor() requires a real concurrent.futures.Future, not a MagicMock."""
    f = RealFuture()
    f.set_result(None)
    mock_exec = MagicMock()
    mock_exec.submit.return_value = f
    return mock_exec

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "venv"))
import main  # noqa: E402

from fastapi.testclient import TestClient

client = TestClient(main.app)


# ──────────────────────────────────────────
# /status
# ──────────────────────────────────────────

class TestStatus:
    def test_unknown_file_returns_unknown(self):
        r = client.get("/status/nonexistent.pdf")
        assert r.status_code == 200
        assert r.json()["status"] == "unknown"

    def test_known_file_returns_status(self):
        main.indexing_status["myfile.pdf"] = "ready"
        r = client.get("/status/myfile.pdf")
        assert r.status_code == 200
        assert r.json()["status"] == "ready"
        del main.indexing_status["myfile.pdf"]

    def test_indexing_status_returned(self):
        main.indexing_status["wip.pdf"] = "indexing"
        r = client.get("/status/wip.pdf")
        assert r.json()["status"] == "indexing"
        del main.indexing_status["wip.pdf"]


# ──────────────────────────────────────────
# /documents
# ──────────────────────────────────────────

class TestDocuments:
    def test_returns_list(self):
        r = client.get("/documents")
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# ──────────────────────────────────────────
# /dashboard
# ──────────────────────────────────────────

class TestDashboard:
    def test_response_structure(self):
        r = client.get("/dashboard")
        assert r.status_code == 200
        data = r.json()
        for key in ("models", "documents", "chunks", "config", "tokens"):
            assert key in data, f"Missing key: {key}"

    def test_models_keys(self):
        data = client.get("/dashboard").json()
        for key in ("llm", "embed", "vision"):
            assert key in data["models"]

    def test_token_keys(self):
        data = client.get("/dashboard").json()
        for key in ("prompt", "completion", "total", "requests"):
            assert key in data["tokens"]

    def test_token_total_equals_sum(self):
        data = client.get("/dashboard").json()
        t = data["tokens"]
        assert t["total"] == t["prompt"] + t["completion"]

    def test_config_values_match_env(self):
        data = client.get("/dashboard").json()
        assert data["config"]["similarity_top_k"] == main.SIMILARITY_TOP_K
        assert data["config"]["max_upload_mb"] == main.MAX_UPLOAD_MB


# ──────────────────────────────────────────
# /ask — no documents
# ──────────────────────────────────────────

class TestAskNoDocuments:
    def test_returns_400_when_empty(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "UPLOAD_DIR", str(tmp_path))
        monkeypatch.setattr(main, "index", None)
        main.indexing_status.clear()
        r = client.post("/ask", json={"question": "hello"})
        assert r.status_code == 400


# ──────────────────────────────────────────
# /upload
# ──────────────────────────────────────────

class TestUpload:
    def test_upload_txt_accepted(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "UPLOAD_DIR", str(tmp_path))
        monkeypatch.setattr(main, "executor", noop_executor())
        r = client.post(
            "/upload",
            files={"file": ("test.txt", b"Hello world", "text/plain")}
        )
        assert r.status_code == 200
        assert r.json()["name"] == "test.txt"

    def test_upload_docx_accepted(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "UPLOAD_DIR", str(tmp_path))
        monkeypatch.setattr(main, "executor", noop_executor())
        r = client.post(
            "/upload",
            files={"file": ("report.docx", b"PK fake docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
        )
        assert r.status_code == 200
        assert r.json()["name"] == "report.docx"

    def test_upload_pdf_accepted(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "UPLOAD_DIR", str(tmp_path))
        monkeypatch.setattr(main, "executor", noop_executor())
        r = client.post(
            "/upload",
            files={"file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")}
        )
        assert r.status_code == 200
        assert r.json()["name"] == "doc.pdf"

    def test_duplicate_upload_skips_reindex(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "UPLOAD_DIR", str(tmp_path))
        monkeypatch.setattr(main, "executor", noop_executor())
        content = b"identical content"
        h = hashlib.md5(content).hexdigest()
        main.file_hashes["dup.txt"] = h
        main.indexing_status["dup.txt"] = "ready"
        r = client.post("/upload", files={"file": ("dup.txt", content, "text/plain")})
        assert r.status_code == 200
        assert r.json()["status"] == "ready"
        del main.file_hashes["dup.txt"]
        del main.indexing_status["dup.txt"]

    def test_upload_returns_indexing_status_for_new_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "UPLOAD_DIR", str(tmp_path))
        monkeypatch.setattr(main, "executor", noop_executor())
        r = client.post("/upload", files={"file": ("new.txt", b"new content", "text/plain")})
        assert r.status_code == 200
        assert r.json()["status"] == "indexing"
