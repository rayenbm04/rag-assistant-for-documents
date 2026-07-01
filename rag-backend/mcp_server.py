#!/usr/bin/env python3
"""
mcp_server.py — MCP server for the RAG Assistant.

Exposes three tools to any MCP-compatible client (Claude Desktop, etc.):
  • list_documents        — see what files are indexed
  • query_documents       — ask a question against indexed files
  • upload_document       — index a new file from a local path

Setup
-----
1.  pip install fastmcp requests python-dotenv

2.  Add credentials to rag-backend/.env:
        MCP_EMAIL=your@email.com
        MCP_PASSWORD=yourpassword
        MCP_BASE_URL=http://localhost:8000   # or your deployed URL

3.  Add to Claude Desktop config
    (%APPDATA%\\Claude\\claude_desktop_config.json on Windows):
        {
          "mcpServers": {
            "rag-assistant": {
              "command": "python",
              "args": ["D:/PROJECTS/rag-assistant/rag-backend/mcp_server.py"]
            }
          }
        }

4.  Restart Claude Desktop.
"""

import json
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv(Path(__file__).parent / ".env")

BASE_URL     = os.getenv("MCP_BASE_URL",  "http://localhost:8000")
EMAIL        = os.getenv("MCP_EMAIL",     "")
PASSWORD     = os.getenv("MCP_PASSWORD",  "")
SSE_TIMEOUT  = 180   # seconds to wait for /ask to finish streaming

if not EMAIL or not PASSWORD:
    print(
        "[mcp_server] ERROR: MCP_EMAIL and MCP_PASSWORD must be set in .env",
        file=sys.stderr,
    )
    sys.exit(1)

# ── Auth ──────────────────────────────────────────────────────────────────────

_token: str = ""
_token_ts: float = 0.0
TOKEN_TTL = 6 * 24 * 3600   # refresh after 6 days (JWT expires in 7)


def _get_token() -> str:
    """Return a valid JWT, refreshing if it is about to expire."""
    global _token, _token_ts
    if _token and (time.time() - _token_ts) < TOKEN_TTL:
        return _token
    r = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Login failed ({r.status_code}): {r.text[:200]}")
    _token    = r.json()["access_token"]
    _token_ts = time.time()
    return _token


def _headers() -> dict:
    return {"Authorization": f"Bearer {_get_token()}"}


# ── MCP server ────────────────────────────────────────────────────────────────

mcp = FastMCP(
    "RAG Assistant",
    instructions=(
        "Use list_documents first to see what files are available, "
        "then call query_documents with the relevant file names. "
        "Always pass the most specific file list you can — "
        "querying all files at once reduces precision."
    ),
)


# ── Tool 1: list_documents ────────────────────────────────────────────────────

@mcp.tool()
def list_documents() -> str:
    """
    List all documents currently indexed in the RAG assistant and ready to query.
    Returns a plain-text list of file names, one per line.
    Call this before query_documents to know which files exist.
    """
    r = requests.get(f"{BASE_URL}/documents", headers=_headers(), timeout=15)
    if r.status_code != 200:
        return f"Error listing documents ({r.status_code}): {r.text[:200]}"

    docs = r.json()
    ready = [d["name"] for d in docs if d.get("status", "ready") == "ready"]
    if not ready:
        return "No documents are indexed yet. Upload files via the web UI first."
    return "\n".join(f"• {name}" for name in sorted(ready))


# ── Tool 2: query_documents ───────────────────────────────────────────────────

@mcp.tool()
def query_documents(
    question: str,
    files: list[str],
    provider: str = "local",
) -> str:
    """
    Ask a question about one or more indexed documents.

    Parameters
    ----------
    question : str
        The question to answer. Can be in French or English.
    files : list[str]
        File names to search (e.g. ["CCF04162026.pdf", "report.docx"]).
        Use list_documents() to see available names.
        Pass an empty list [] to search across all indexed documents.
    provider : str
        "local"  — use the local Ollama model (default, private, no API cost).
        "cloud"  — use Groq llama-3.3-70b (faster, higher quality, requires GROQ_API_KEY).

    Returns
    -------
    str
        The answer followed by the source files and page numbers cited.
    """
    payload = {
        "question": question,
        "files":    files,
        "history":  [],
        "provider": provider,
        "fast":     False,   # full pipeline: HyDE + multi-query + rerank
    }

    answer_parts: list[str] = []
    sources:      list[str] = []
    citations:    list[dict] = []

    try:
        with requests.post(
            f"{BASE_URL}/ask",
            json=payload,
            headers={**_headers(), "Accept": "text/event-stream"},
            stream=True,
            timeout=SSE_TIMEOUT,
        ) as resp:
            if resp.status_code != 200:
                return f"Error from /ask ({resp.status_code}): {resp.text[:300]}"

            buffer = ""
            for raw in resp.iter_content(chunk_size=None, decode_unicode=True):
                buffer += raw
                while "\n\n" in buffer:
                    event_str, buffer = buffer.split("\n\n", 1)
                    for line in event_str.splitlines():
                        if not line.startswith("data:"):
                            continue
                        try:
                            data = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        t = data.get("type", "")
                        if t == "token":
                            answer_parts.append(data.get("content", ""))
                        elif t == "done":
                            sources   = data.get("sources",   [])
                            citations = data.get("citations", [])
                        elif t == "error":
                            return f"[RAG error] {data.get('message', '')}"

    except requests.Timeout:
        return "[timeout] The RAG assistant took too long to respond."
    except Exception as e:
        return f"[exception] {e}"

    answer = "".join(answer_parts).strip()
    if not answer:
        return "No answer was returned. The document may not be indexed yet."

    # Append source citations
    if citations:
        cite_lines = []
        for c in citations:
            pages = c.get("pages", [])
            if pages:
                cite_lines.append(f"  • {c['file']}  (pages {', '.join(str(p) for p in pages)})")
            else:
                cite_lines.append(f"  • {c['file']}")
        answer += "\n\nSources:\n" + "\n".join(cite_lines)
    elif sources:
        answer += "\n\nSources:\n" + "\n".join(f"  • {s}" for s in sources)

    return answer


# ── Tool 3: upload_document ───────────────────────────────────────────────────

@mcp.tool()
def upload_document(file_path: str, provider: str = "local") -> str:
    """
    Upload and index a document from a local file path.

    Parameters
    ----------
    file_path : str
        Absolute path to the file on disk
        (e.g. "C:/Users/rayen/Documents/report.pdf").
        Supported formats: PDF, DOCX, PPTX, XLSX, PNG, JPG, TXT, MD, CSV, PUML.
    provider : str
        "local" or "cloud" — which vision model to use for image/scanned PDF pages.

    Returns
    -------
    str
        Confirmation message with the file name once indexing is complete.
    """
    path = Path(file_path)
    if not path.exists():
        return f"File not found: {file_path}"
    if not path.is_file():
        return f"Not a file: {file_path}"

    # Upload
    with open(path, "rb") as fh:
        resp = requests.post(
            f"{BASE_URL}/upload",
            files={"file": (path.name, fh)},
            data={"provider": provider},
            headers=_headers(),
            timeout=30,
        )
    if resp.status_code != 200:
        return f"Upload failed ({resp.status_code}): {resp.text[:200]}"

    filename = resp.json().get("name", path.name)

    # Poll until indexing finishes (max 10 minutes)
    deadline = time.time() + 600
    while time.time() < deadline:
        s = requests.get(
            f"{BASE_URL}/status/{filename}",
            headers=_headers(),
            timeout=10,
        )
        if s.status_code != 200:
            break
        status = s.json().get("status", "")
        if status == "ready":
            return f"✓ '{filename}' indexed successfully and ready to query."
        if status == "error":
            return f"✗ Indexing failed for '{filename}'."
        progress = s.json().get("progress", {})
        cur = progress.get("current", 0)
        tot = progress.get("total", 0)
        if tot:
            print(f"[mcp_server] indexing {filename}: {cur}/{tot} pages", file=sys.stderr)
        time.sleep(3)

    return f"'{filename}' was uploaded but indexing is still in progress. Check the web UI."


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Verify credentials on startup so failures are obvious immediately
    try:
        _get_token()
        print("[mcp_server] Auth OK — RAG Assistant MCP server starting", file=sys.stderr)
    except RuntimeError as e:
        print(f"[mcp_server] {e}", file=sys.stderr)
        sys.exit(1)

    mcp.run(transport="stdio")
