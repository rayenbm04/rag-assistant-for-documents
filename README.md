# RAG Multimodal Assistant

A fully local Retrieval-Augmented Generation (RAG) assistant that answers questions about your documents. Supports PDFs, Word files, plain text, and images. Everything runs on your machine via [Ollama](https://ollama.com) — no cloud APIs, no data leaving your computer.

Built as a 5-week internship project to explore the full RAG engineering stack: ingestion, retrieval, re-ranking, evaluation, and production packaging.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (React)                          │
│  Auth (login/register) │ Sessions │ Chat │ Documents sidebar    │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP / SSE  (Bearer JWT)
┌────────────────────────────▼────────────────────────────────────┐
│                     FastAPI Backend                             │
│                                                                 │
│  /auth/register|login  →  JWT token                            │
│  /upload → extract text → chunk → embed → ChromaDB             │
│                                                                 │
│  /ask  ┌─ condense question (history-aware)                     │
│        ├─ hybrid retrieve: vector (ChromaDB) + BM25             │
│        ├─ cross-encoder re-rank (ms-marco-MiniLM-L-6-v2)        │
│        ├─ build prompt (labeled context + history)              │
│        ├─ stream answer token-by-token via SSE                  │
│        └─ LLM-as-judge eval: faithfulness + relevance           │
└──────────────┬─────────────────────────────┬───────────────────┘
               │                             │
┌──────────────▼──────────┐   ┌─────────────▼─────────────────────┐
│       Ollama            │   │   SQLite (rag_users.db)            │
│  mistral:7b-instruct    │   │   Users · hashed passwords · roles │
│  nomic-embed-text       │   └────────────────────────────────────┘
│  llava                  │
└─────────────────────────┘
```

---

## Features

### Retrieval pipeline

**Hybrid search (BM25 + vector)**
Each query runs two retrievers in parallel: a dense vector retriever (ChromaDB cosine similarity) and a sparse BM25 keyword retriever. Results are fused with Reciprocal Rank Fusion. This catches both semantic matches ("describe the pricing model") and exact keyword matches (product codes, names, numbers).

**Cross-encoder re-ranking**
After hybrid retrieval fetches 2× the needed chunks, a `cross-encoder/ms-marco-MiniLM-L-6-v2` model re-scores each `(question, chunk)` pair jointly — much more accurate than the individual scores from BM25/vector. Only the top-K chunks are passed to the LLM. Runs on CPU, adds ~1–2 s per query.

**Session-scoped retrieval**
Each chat session tracks its own file list. Retrieval is filtered to only that session's documents using ChromaDB metadata filters, so sessions with different files never bleed into each other.

**History-aware question condensing**
Follow-up questions ("what about the second one?" / "explain further") are rewritten into standalone queries before retrieval, using the last 5 turns of conversation history.

**Document comparison mode**
Automatically detected from keywords (*compare, difference, contrast, versus, between*, etc.). Switches from unified retrieval to per-file balanced retrieval — guaranteeing chunks from each document — and builds a labeled context (`=== Document: X ===`) so the LLM can reason across sources explicitly.

### Ingestion

**Multimodal document support**

| Format | Processing |
|--------|-----------|
| PDF | Text extracted with `pdfplumber` at 300 DPI; image-only pages (< 50 chars of text) sent to LLaVA in doc-mode (verbatim transcription) |
| PNG / JPG / WEBP / GIF | Fully described by LLaVA: text, colors, layout, structure, purpose |
| DOCX | Paragraphs and tables extracted with `python-docx`; document-level summary header with table row counts |
| XLSX / XLS | Sheets extracted with `openpyxl` / `xlrd` |
| TXT | Read directly |

**Page-by-page progress tracking**
PDF indexing reports progress after each page. The frontend shows a live progress bar ("Page 3 / 12") instead of a generic spinner. Non-PDF files show a pulse animation (single-step processing).

**Upload deduplication**
Re-uploading the same file (identical MD5) skips re-indexing and returns `ready` immediately. Files shared across sessions are only indexed once.

**Cancellable indexing**
Each indexing job checks a cancellation flag between pages. Cancelling stops the job and deletes the partially-uploaded file.

### Authentication

**JWT-based user accounts**
Registration and login are handled by `/auth/register` and `/auth/login`. Passwords are hashed with bcrypt via `passlib`. Tokens are signed HS256 JWTs (7-day expiry by default). Every protected endpoint requires a `Bearer` token in the `Authorization` header — a missing or expired token returns `401` and the frontend redirects to the login screen automatically.

**Multi-user support**
Each user has their own isolated chat history stored in `localStorage` under a user-ID-scoped key, so switching accounts on the same browser shows a clean, separate history. File ownership is tracked server-side (`file_owners.json`) — non-admin users can only query their own files.

**Role-based access**
The first registered account is automatically assigned the `admin` role. Admins can query any file regardless of who uploaded it. Regular users are restricted to their own uploads. The user's name and role are displayed in the navbar; admins see an `admin` badge.

### Interface

**Three-column layout**
- Left: chat sessions list with auto-generated titles
- Centre: streaming chat with markdown rendering
- Right: documents panel with upload zone and file status

**Streaming responses**
Answers stream character-by-character via Server-Sent Events (SSE). A configurable delay (`STREAM_DELAY_MS`) makes the output readable as it arrives rather than appearing all at once.

**LLM-generated session titles**
After the first message in a session, a background request generates a specific 2–5 word title (e.g. "Describe NAWAARNI Invoice") using both the question and the filename. For file-only sessions (no question yet), the session is named from the filename.

**Multiple sessions**
Unlimited chat sessions, each with its own file list and history. Switching sessions cancels any in-flight request. Sessions persist across page refreshes via `localStorage`, scoped per user account.

**RAG evaluation badges**
After each answer, two lightweight LLM-as-judge calls score the response:
- **F** (Faithfulness): is every claim grounded in the retrieved context? Penalises hallucination.
- **R** (Answer relevance): does the answer directly address the question?

Scores appear as colour-coded badges (green ≥ 80%, amber 50–80%, red < 50%). Averages across all sessions are shown in the Stats dashboard.

**Usage dashboard**
Click **Stats** in the navbar to see: sessions, documents indexed, total chunks, active models, token usage, and estimated cost if you were using paid APIs (GPT-4o, Claude Sonnet, Gemini, etc.).

**PDF export**
Click **Export PDF** to print the current chat to a formatted PDF via the browser's print dialog.

---

## Prerequisites

### 1. Ollama

Install from [ollama.com](https://ollama.com), then pull the three required models:

```bash
ollama pull mistral:7b-instruct-q4_K_M   # ~4.1 GB — text generation
ollama pull nomic-embed-text              # ~274 MB — embeddings
ollama pull llava                         # ~4.7 GB — image & scanned PDF analysis
```

> Tested on an RTX 4070 (8 GB VRAM). The `q4_K_M` quantization fits comfortably. If you have less VRAM, try `q3_K_M` or any other Ollama-compatible model and set `LLM_MODEL` in `.env`.

### 2. Python 3.10+

### 3. Node.js 18+

---

## Running locally

### Backend

```bash
cd rag-backend

python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

pip install -r requirements.txt

cp .env.example .env         # edit SECRET_KEY before deploying
uvicorn venv/main:app --reload
```

On first run, `rag_users.db` is created automatically. The first account registered becomes admin.

### Frontend

```bash
cd rag-frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

---

## Running with Docker

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) running. Ollama must be running on the host machine.

```bash
docker compose up --build
```

- Frontend: [http://localhost](http://localhost)
- Backend: [http://localhost:8000](http://localhost:8000)

The backend connects to Ollama on the host via `host.docker.internal:11434` (set automatically in `docker-compose.yml`).

Uploaded files and the ChromaDB vector store are persisted in Docker volumes (`./rag-backend/uploads` and `./rag-backend/chroma_db`), so data survives container restarts.

---

## Environment variables

All variables are optional — sensible defaults are set for local development. Copy `.env.example` to `.env` inside `rag-backend/` to override.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `mistral:7b-instruct-q4_K_M` | Ollama model for text generation and eval |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `VISION_MODEL` | `llava` | Ollama vision model for images and scanned PDFs |
| `UPLOAD_DIR` | `./uploads` | Where uploaded files are saved |
| `CHROMA_DIR` | `./chroma_db` | ChromaDB persistent storage path |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated CORS origins |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum file upload size |
| `SIMILARITY_TOP_K` | `4` | Chunks kept after retrieval (2× fetched before re-ranking) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL (set to `http://host.docker.internal:11434` in Docker) |
| `STREAM_DELAY_MS` | `20` | Delay between streamed characters in ms — increase to slow down output |
| `ENABLE_RERANK` | `true` | Enable cross-encoder re-ranking. Set to `false` to reduce latency. |
| `RERANK_MODEL` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | HuggingFace cross-encoder model (downloaded on first run, then cached) |
| `ENABLE_EVAL` | `true` | Enable faithfulness + relevance scoring after each answer (2 extra LLM calls) |
| `SECRET_KEY` | `change-me-in-production` | HS256 signing key for JWT tokens — **change this before deploying** |
| `ACCESS_TOKEN_EXPIRE_DAYS` | `7` | JWT token lifetime in days |
| `DATABASE_URL` | `sqlite:///./rag_users.db` | SQLAlchemy connection string for the user database |

---

## API reference

All endpoints except `/auth/register` and `/auth/login` require `Authorization: Bearer <token>`.

**Auth**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | `{email, password, firstname, lastname}` → `{access_token, user}`. First account becomes admin. |
| `POST` | `/auth/login` | `{email, password}` → `{access_token, user}` |
| `GET` | `/auth/me` | Returns the current user's profile |
| `GET` | `/auth/users` | (admin only) List all registered users |
| `PATCH` | `/auth/users/{id}/role` | (admin only) Change a user's role |

**Documents & chat**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Upload a file. Returns `{id, name, status}`. Indexing runs in background. |
| `GET` | `/status/{filename}` | Poll indexing status. Returns `{status, progress}` where progress is `{current, total}` page counts for PDFs. |
| `GET` | `/files/{filename}` | Serve an uploaded file (for in-browser preview). |
| `POST` | `/ask` | `{question, history[], files[]}` → SSE stream of `token`, `done`, and `eval` events. |
| `POST` | `/title` | `{question, files[]}` → `{title}`. Generates a short session title. |
| `GET` | `/documents` | List documents owned by the current user (admins see all). |
| `DELETE` | `/documents/{filename}` | Remove a file and delete its chunks from ChromaDB. |
| `GET` | `/dashboard` | Returns models, chunk counts, token usage, and config. |
| `POST` | `/cancel/{filename}` | Request cancellation of an in-progress indexing job. |

### SSE event types (`/ask`)

```json
{ "type": "token",  "content": "T" }
{ "type": "done",   "sources": ["file.pdf"], "citations": [{"file": "file.pdf", "pages": [1, 2]}], "warning": null, "mode": "standard" }
{ "type": "eval",   "faithfulness": 0.92, "answer_relevance": 0.87 }
{ "type": "error",  "message": "..." }
```

`mode` is `"comparison"` when per-file balanced retrieval was used, `"standard"` otherwise.

---

## Running tests

```bash
cd rag-backend
venv\Scripts\activate
pip install pytest httpx
pytest tests/ -v
```

All external services (Ollama, ChromaDB, LlamaIndex) are mocked so tests run fully offline. Tests cover document extraction (`.txt`, `.docx`), token tracking, and all major API endpoints.

---

## Project structure

```
rag-assistant/
├── docker-compose.yml
├── rag-backend/
│   ├── venv/
│   │   └── main.py              # FastAPI app — auth, all endpoints, RAG pipeline
│   ├── tests/
│   │   ├── conftest.py          # Mocks for offline testing
│   │   ├── test_extraction.py
│   │   └── test_api.py
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env.example
│   ├── rag_users.db             # SQLite user database (auto-created on first run)
│   └── file_owners.json         # Maps filenames to owner user IDs
└── rag-frontend/
    ├── src/
    │   ├── App.jsx              # React app — auth, sessions, chat, upload, dashboard
    │   └── App.css
    ├── Dockerfile
    ├── nginx.conf
    └── package.json
```

---

## Technical decisions

**Why LlamaIndex over LangChain?**
LlamaIndex has first-class support for hybrid retrievers, node postprocessors, and ChromaDB without needing custom wrapper code. The `QueryFusionRetriever` with `reciprocal_rerank` mode handles BM25 + vector fusion in a few lines.

**Why BM25 + vector instead of vector alone?**
Vector search struggles with exact keyword lookups — product codes, names, numbers. BM25 is strong there but misses paraphrasing. Fusing both gives consistent performance across both query types.

**Why a cross-encoder for re-ranking instead of relying on fusion scores?**
Bi-encoder similarity scores (used by both BM25 and vector search) score query and document independently. A cross-encoder reads them together and produces a much more accurate relevance estimate. The 22 MB `ms-marco-MiniLM-L-6-v2` model adds ~1–2 s per query on CPU with a measurable quality improvement.

**Why LLM-as-judge for evaluation?**
Standard RAG evaluation frameworks (RAGAS, TruLens) require either ground-truth datasets or cloud API calls. Using the local LLM itself as judge means evaluation runs fully offline with zero extra dependencies. The trade-off is that the judge and the answerer are the same model, which inflates scores slightly — acceptable for a development feedback signal.

**Why SSE instead of WebSockets?**
SSE is unidirectional (server → client) which fits the streaming response pattern exactly. It works over plain HTTP, requires no connection upgrade, and is trivially supported by FastAPI's `StreamingResponse`. WebSockets would add complexity (connection management, ping/keep-alive) with no benefit here.
