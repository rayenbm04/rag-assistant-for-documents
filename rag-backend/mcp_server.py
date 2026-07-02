#!/usr/bin/env python3
"""
mcp_server.py — MCP server for the RAG Assistant.

Exposes six tools to any MCP-compatible client (Claude Desktop, etc.):
  • list_documents           — see what files are indexed
  • query_documents          — ask a question against indexed files
  • upload_document          — index a new file from a local path
  • upload_document_from_url — download from a URL and index (ideal for GitHub/Notion)
  • upload_document_content  — index from base64 content (for direct file attachments)
  • check_indexing_status    — poll indexing progress for a previously uploaded file

All upload tools return immediately — indexing runs in the background.
Call check_indexing_status(filename) to know when a file is ready to query.

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

import base64
import io
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

BASE_URL      = os.getenv("MCP_BASE_URL",  "http://localhost:8000")
EMAIL         = os.getenv("MCP_EMAIL",     "")
GITHUB_TOKEN  = os.getenv("GITHUB_PERSONAL_ACCESS_TOKEN", "")
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


# ── Shared upload helper ──────────────────────────────────────────────────────

def _post_file(name: str, content: bytes, provider: str) -> str:
    """
    POST file bytes to /upload and return immediately — do NOT poll.
    Returns the indexed filename on success, or raises RuntimeError on failure.
    """
    resp = requests.post(
        f"{BASE_URL}/upload",
        files={"file": (name, io.BytesIO(content))},
        data={"provider": provider},
        headers=_headers(),
        timeout=120,   # generous for large files; just the HTTP POST, not indexing
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Upload failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json().get("name", name)


# ── Tool 3: upload_document ───────────────────────────────────────────────────

@mcp.tool()
def upload_document(file_path: str, provider: str = "local") -> str:
    """
    Upload and index a document from a local file path.

    Returns immediately once the file is accepted — indexing runs in the
    background. Call check_indexing_status(filename) to monitor progress.

    Parameters
    ----------
    file_path : str
        Absolute path to the file on disk
        (e.g. "C:/Users/rayen/Documents/report.pdf").
        Supported formats: PDF, DOCX, PPTX, XLSX, PNG, JPG, TXT, MD, CSV, PUML.
    provider : str
        "local" or "cloud" — which vision model to use for image/scanned PDF pages.
    """
    path = Path(file_path)
    if not path.exists():
        return f"File not found: {file_path}"
    if not path.is_file():
        return f"Not a file: {file_path}"

    with open(path, "rb") as fh:
        content = fh.read()

    try:
        indexed_name = _post_file(path.name, content, provider)
    except RuntimeError as e:
        return str(e)

    return (
        f"✓ '{indexed_name}' uploaded — indexing started in the background.\n"
        f"Call check_indexing_status('{indexed_name}') in ~30 s to see when it's ready."
    )


# ── Tool 4: upload_document_from_url ─────────────────────────────────────────

@mcp.tool()
def upload_document_from_url(
    url: str,
    filename: str = "",
    provider: str = "local",
) -> str:
    """
    Download a file from a URL and index it in the RAG assistant.

    Perfect for the GitHub → RAG workflow:
      1. Use the GitHub MCP to get the raw download URL of a file.
      2. Pass that URL here — the MCP server downloads and uploads it directly.

    Returns immediately once the file is accepted — indexing runs in the
    background. Call check_indexing_status(filename) to monitor progress.

    For private GitHub repos the server automatically adds your
    GITHUB_PERSONAL_ACCESS_TOKEN from .env.

    Parameters
    ----------
    url : str
        Direct download URL. For GitHub use the raw URL:
        https://raw.githubusercontent.com/owner/repo/main/path/file.py
    filename : str
        Override the file name. If omitted, inferred from the URL.
    provider : str
        "local" or "cloud" — vision model for image/scanned PDF pages.
    """
    dl_headers: dict = {}
    if GITHUB_TOKEN and ("github.com" in url or "githubusercontent.com" in url):
        dl_headers["Authorization"] = f"token {GITHUB_TOKEN}"

    try:
        resp = requests.get(url, headers=dl_headers, timeout=60)
        if resp.status_code != 200:
            return f"Failed to download file ({resp.status_code}): {url}"
        content = resp.content
    except Exception as e:
        return f"Download error: {e}"

    if not filename:
        filename = url.rstrip("/").split("/")[-1].split("?")[0]
    if not filename:
        return "Could not infer a filename from the URL. Please pass filename= explicitly."

    try:
        indexed_name = _post_file(filename, content, provider)
    except RuntimeError as e:
        return str(e)

    return (
        f"✓ '{indexed_name}' uploaded — indexing started in the background.\n"
        f"Call check_indexing_status('{indexed_name}') in ~30 s to see when it's ready."
    )


# ── Tool 5: upload_document_content ──────────────────────────────────────────

@mcp.tool()
def upload_document_content(
    filename: str,
    content_base64: str,
    provider: str = "local",
) -> str:
    """
    Upload and index a document from base64-encoded bytes.

    Use this when the user attaches a file directly to the conversation.
    Returns immediately — call check_indexing_status(filename) to monitor.

    Parameters
    ----------
    filename : str
        The file name including extension (e.g. "report.pdf").
    content_base64 : str
        Base64-encoded file content.
    provider : str
        "local" or "cloud".
    """
    try:
        content = base64.b64decode(content_base64)
    except Exception as e:
        return f"Failed to decode base64 content: {e}"

    try:
        indexed_name = _post_file(filename, content, provider)
    except RuntimeError as e:
        return str(e)

    return (
        f"✓ '{indexed_name}' uploaded — indexing started in the background.\n"
        f"Call check_indexing_status('{indexed_name}') in ~30 s to see when it's ready."
    )


# ── Tool 6: check_indexing_status ────────────────────────────────────────────

@mcp.tool()
def check_indexing_status(filename: str) -> str:
    """
    Check whether a previously uploaded document has finished indexing.

    Call this after any upload tool returns. For large files (e.g. 3000-line
    Python files) embedding can take 1–5 minutes locally — poll every 30 s.

    Parameters
    ----------
    filename : str
        The file name returned by the upload tool (e.g. "main.py").

    Returns
    -------
    str
        Current status: ready / processing (with page progress) / error / unknown.
    """
    try:
        s = requests.get(
            f"{BASE_URL}/status/{filename}",
            headers=_headers(),
            timeout=10,
        )
    except Exception as e:
        return f"Could not reach backend: {e}"

    if s.status_code == 404:
        return f"'{filename}' not found. Has it been uploaded yet?"
    if s.status_code != 200:
        return f"Status check failed ({s.status_code}): {s.text[:200]}"

    data     = s.json()
    status   = data.get("status", "unknown")
    progress = data.get("progress") or {}   # backend sends null when no progress yet
    cur      = progress.get("current", 0)
    tot      = progress.get("total", 0)

    if status == "ready":
        return f"✓ '{filename}' is fully indexed and ready to query."
    if status == "error":
        return f"✗ Indexing failed for '{filename}'. Try re-uploading."
    if status in ("indexing", "processing"):
        if tot:
            pct = int(cur / tot * 100)
            return f"⏳ '{filename}' is indexing: {cur}/{tot} pages ({pct}%). Check again in 30 s."
        return f"⏳ '{filename}' is indexing (no page count yet). Check again in 30 s."
    if status == "unknown":
        return f"'{filename}' is not in the indexing queue — it may already be ready or not uploaded yet."
    return f"⏳ '{filename}' status: {status}. Check again in 30 s."


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
