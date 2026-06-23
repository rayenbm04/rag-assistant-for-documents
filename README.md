# RAG Multimodal Assistant

A fully local Retrieval-Augmented Generation (RAG) assistant that answers questions about your documents. Supports PDFs, Word files, PowerPoint presentations, spreadsheets, plain text, and images. Everything runs on your machine via [Ollama](https://ollama.com) — no cloud APIs, no data leaving your computer.

Built as a 5-week internship project to explore the full RAG engineering stack: ingestion, retrieval, re-ranking, evaluation, and production packaging.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (React)                          │
│  Auth │ Sessions │ Chat │ Documents sidebar │ Prompt navigator  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP / SSE  (Bearer JWT)
┌────────────────────────────▼────────────────────────────────────┐
│                     FastAPI Backend                             │
│                                                                 │
│  /auth/register|login  →  JWT token                            │
│  /upload → extract text → chunk → embed → ChromaDB             │
│  /reindex → re-extract + re-embed without re-uploading          │
│                                                                 │
│  /ask  ┌─ condense + typo-correct question                      │
│        ├─ HyDE: generate hypothetical passage for vector search │
│        ├─ multi-query: 3 rephrased questions for wider recall   │
│        ├─ hybrid retrieve: vector (ChromaDB) + BM25             │
│        ├─ RRF merge across all query variants                   │
│        ├─ cross-encoder re-rank (BAAI/bge-reranker-base)        │
│        ├─ PPTX overview pinning: always inject metadata chunks  │
│        ├─ build prompt (labeled context + history)              │
│        ├─ stream answer token-by-token via SSE                  │
│        └─ LLM-as-judge eval: faithfulness + relevance           │
└──────────────┬─────────────────────────────┬───────────────────┘
               │                             │
┌──────────────▼──────────┐   ┌─────────────▼─────────────────────┐
│       Ollama            │   │   SQLite (rag_users.db)            │
│  qwen2.5:7b             │   │   Users · hashed passwords · roles │
│  nomic-embed-text       │   └────────────────────────────────────┘
│  llava-phi3             │
└─────────────────────────┘
```

---

## Features

### Retrieval pipeline

```
User Question
      │
      ▼
┌─────────────────────────┐
│  Question Condensation  │  follow-ups rewritten to standalone · typos corrected
└─────────────┬───────────┘
              │
      ┌───────┴────────┐
      ▼                ▼
┌───────────┐   ┌──────────────────┐
│   HyDE    │   │   Multi-Query    │  3 alternative phrasings generated in parallel
│ Expansion │   │   Generation     │
└─────┬─────┘   └────────┬─────────┘
      │                  │
      └────────┬──────────┘
               ▼
    ┌──────────────────────┐
    │   Hybrid Retrieval   │  all queries fired in parallel
    │  ┌────────────────┐  │
    │  │  Vector Search │  │  HyDE query + 3 multi-query variants → ChromaDB
    │  │    (ChromaDB)  │  │
    │  ├────────────────┤  │
    │  │  BM25 Search   │  │  original standalone query → keyword index
    │  └────────────────┘  │
    └──────────┬───────────┘
               ▼
    ┌──────────────────────┐
    │  Reciprocal Rank     │  merge up to 5 result lists · deduplicate · boost
    │  Fusion (RRF)        │  chunks appearing across multiple queries
    └──────────┬───────────┘
               ▼
    ┌──────────────────────┐
    │  Cross-Encoder       │  BAAI/bge-reranker-base scores each (query, chunk)
    │  Re-ranking          │  pair jointly · keeps top-K
    └──────────┬───────────┘
               ▼
    ┌──────────────────────┐
    │  PPTX Overview       │  for PowerPoint files: always inject slide index
    │  Pinning             │  + cover slide chunks regardless of retrieval scores
    └──────────┬───────────┘
               ▼
    ┌──────────────────────┐
    │   Qwen 2.5 7B        │  streams answer token-by-token via SSE
    └──────────┬───────────┘
               ▼
    Answer + Citations + F/R Eval Scores
```

**HyDE (Hypothetical Document Embeddings)**
Before retrieval, the LLM generates a short hypothetical passage that would answer the question. This passage is embedded and used for vector search instead of the raw question. A passage-shaped vector sits much closer to real document chunks in embedding space than a question-shaped vector does, measurably improving retrieval quality — especially for vague or short queries. The hypothesis is shown to the user as a collapsible "Search hypothesis" chip above the answer.

**Multi-query retrieval**
The question is simultaneously rewritten into 3 alternative phrasings by the LLM, each approaching the same information need from a different angle (different vocabulary, specificity, framing). Vector retrieval runs for each phrasing in parallel. All result lists — HyDE vector, 3 multi-query vectors, and BM25 — are merged via RRF, maximising the chance that relevant chunks are surfaced regardless of how the question was phrased. All expansions run concurrently so latency cost is minimal.

**Hybrid search (BM25 + vector)**
Each query runs a dense vector retriever (ChromaDB cosine similarity) and a sparse BM25 keyword retriever in parallel. Results are fused with Reciprocal Rank Fusion. This catches both semantic matches ("describe the pricing model") and exact keyword matches (product codes, names, numbers).

**Cross-encoder re-ranking**
After hybrid retrieval fetches 2× the needed chunks, a `BAAI/bge-reranker-base` model re-scores each `(question, chunk)` pair jointly — much more accurate than the individual scores from BM25/vector. Only the top-K chunks are passed to the LLM.

**PPTX overview pinning**
For PowerPoint files, all overview chunks (slide index, total slide count, cover slide content) are always injected into the context regardless of what retrieval returns. This guarantees metadata questions — "how many slides are there?", "who are the team members?" — are always answerable, even when the embedding-based search misses the overview.

**Session-scoped retrieval**
Each chat session tracks its own file list. Retrieval is filtered to only that session's documents using ChromaDB metadata filters, so sessions with different files never bleed into each other.

**History-aware question condensing**
Follow-up questions ("what about the second one?" / "explain further") are rewritten into standalone queries before retrieval, using the last 5 turns of conversation history. Typos are corrected at the same step, even for first messages.

**Document comparison mode**
Automatically detected from keywords (*compare, difference, contrast, versus, between*, etc.). Switches from unified retrieval to per-file balanced retrieval — guaranteeing chunks from each document — and builds a labeled context (`=== Document: X ===`) so the LLM can reason across sources explicitly.

### Ingestion

**Multimodal document support**

| Format | Processing |
|--------|-----------|
| PDF | Text extracted with `pdfplumber` at 300 DPI; image-only pages (< 50 chars of text) sent to LLaVA in doc-mode (verbatim transcription) |
| PPTX | Compact overview block (title index, total slide count, cover slide body including team names) + per-slide detail blocks with ordinal labels ("first slide", "second slide"…). Tables extracted from every shape including `has_table` shapes. |
| PNG / JPG / WEBP / GIF | Fully described by LLaVA: text, colors, layout, structure, purpose |
| DOCX | Paragraphs and tables extracted with `python-docx`; document-level summary header with table row counts |
| XLSX / XLS | Sheets extracted with `openpyxl` / `xlrd` |
| TXT | Read directly |
| URL | Web pages fetched via `requests` + `BeautifulSoup`, cleaned to plain text, and indexed like a local file. The page title becomes the filename. Pages that require JavaScript to render return an error. |

**URL ingestion**
Paste any web URL into the document panel instead of uploading a file. The backend fetches the page, strips navigation/ads/boilerplate via BeautifulSoup, and indexes the clean text through the same chunking and embedding pipeline as uploaded files. The source URL is prepended to the stored text for citation purposes.

**Page-by-page progress tracking**
PDF indexing reports progress after each page. The frontend shows a live progress bar ("Page 3 / 12") instead of a generic spinner. Non-PDF files show a pulse animation (single-step processing).

**Re-index without re-uploading**
Each file card has a ↺ button that clears the file's ChromaDB chunks and re-runs extraction with the current extractor — useful after updating extraction logic without having to delete and re-upload.

**Upload deduplication**
Re-uploading the same file (identical MD5) skips re-indexing and returns `ready` immediately. Files shared across sessions are only indexed once.

**Cancellable indexing**
Each indexing job checks a cancellation flag between pages. Cancelling stops the job and deletes the partially-uploaded file. The cancel button in the chat input area works even while a file is still indexing — the backend emits `indexing_wait` SSE heartbeats so the connection stays alive and abortable.

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
- Centre: streaming chat with markdown rendering, scroll-to-bottom button
- Right: documents panel with upload zone, file status, and prompt navigator

**Streaming responses**
Answers stream character-by-character via Server-Sent Events (SSE). A configurable delay (`STREAM_DELAY_MS`) makes the output readable as it arrives rather than appearing all at once.

**Cancel and resume**
A Cancel button replaces Send while a response is generating. Cancelling keeps whatever partial response was already streamed and marks it with a ⬛ Stopped indicator, so nothing is lost.

**Copy buttons**
Both user prompts and AI responses have a hover-activated Copy button for quick clipboard access.

**Prompt navigator**
A collapsible Prompts section in the right sidebar lists every question in the session. Clicking any entry scrolls the chat directly to that exchange.

**Scroll-to-bottom button**
A circular ↓ button appears in the chat area when scrolled up, jumping back to the latest message in one click.

**LLM-generated session titles**
After the first message in a session, a background request generates a specific 2–5 word title (e.g. "NAWWARNI Team Members") using both the question and the filename.

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

**PPTX preview**
PowerPoint files are converted to PDF via LibreOffice headless and rendered page-by-page in the browser. The conversion handles filenames with spaces using a safe temp-copy approach and suppresses the LibreOffice window on Windows via `STARTUPINFO + SW_HIDE`.

---

## Prerequisites

### 1. Ollama

Install from [ollama.com](https://ollama.com), then pull the required models:

```bash
ollama pull qwen2.5:7b          # ~4.7 GB — text generation (recommended)
ollama pull nomic-embed-text    # ~274 MB — embeddings
ollama pull llava-phi3          # ~2.9 GB — image & scanned PDF analysis
```

> Tested on an RTX 4070 (8 GB VRAM). `qwen2.5:7b` gives a good speed/quality balance. For maximum quality use `qwen3:8b` (set `LLM_MODEL=qwen3:8b` — thinking tokens are suppressed automatically). For faster responses on weaker hardware, any Ollama-compatible 7B instruct model works.

### 2. Python 3.10+

### 3. Node.js 18+

### 4. LibreOffice (optional — for PPTX preview only)

Install from [libreoffice.org](https://www.libreoffice.org). The backend auto-detects versioned install paths (e.g. `LibreOffice 26`). Without it, PPTX preview is disabled but all other features work normally.

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
| `LLM_MODEL` | `qwen2.5:7b` | Ollama model for text generation and eval |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `VISION_MODEL` | `llava-phi3` | Ollama vision model for images and scanned PDFs |
| `UPLOAD_DIR` | `./uploads` | Where uploaded files are saved |
| `CHROMA_DIR` | `./chroma_db` | ChromaDB persistent storage path |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated CORS origins |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum file upload size |
| `SIMILARITY_TOP_K` | `4` | Chunks kept after retrieval (2× fetched before re-ranking) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL (set to `http://host.docker.internal:11434` in Docker) |
| `STREAM_DELAY_MS` | `20` | Delay between streamed characters in ms |
| `ENABLE_RERANK` | `true` | Enable cross-encoder re-ranking |
| `RERANK_MODEL` | `BAAI/bge-reranker-base` | HuggingFace cross-encoder model (downloaded on first run, ~22 MB) |
| `ENABLE_EVAL` | `true` | Enable faithfulness + relevance scoring after each answer (2 extra LLM calls) |
| `ENABLE_HYDE` | `true` | Enable HyDE hypothetical passage expansion before vector search |
| `ENABLE_MULTI_QUERY` | `true` | Enable multi-query retrieval (3 rephrased questions merged via RRF) |
| `MULTI_QUERY_N` | `3` | Number of alternative query phrasings to generate |
| `SECRET_KEY` | `change-me-in-production` | HS256 signing key for JWT tokens — **change this before deploying** |
| `ACCESS_TOKEN_EXPIRE_DAYS` | `7` | JWT token lifetime in days |
| `DATABASE_URL` | `sqlite:///./rag_users.db` | SQLAlchemy connection string for the user database |
| `PARENT_CHUNK_SIZE` | `512` | Parent chunk size in tokens (stored in docstore for AutoMerging) |
| `CHILD_CHUNK_SIZE` | `256` | Child/leaf chunk size in tokens (indexed in ChromaDB for retrieval) |
| `NODE_STORE_DIR` | `./node_store` | Path for the LlamaIndex docstore used by AutoMergingRetriever |

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
| `POST` | `/upload-url` | `{url}` — Fetch a web page, extract clean text, index it like an uploaded file. Returns `{name, status, title}`. |
| `GET` | `/status/{filename}` | Poll indexing status. Returns `{status, progress}` where progress is `{current, total}` page counts for PDFs. |
| `GET` | `/files/{filename}` | Serve an uploaded file (for in-browser preview). |
| `POST` | `/reindex/{filename}` | Clear and re-extract a file's chunks without re-uploading. |
| `POST` | `/ask` | `{question, history[], files[]}` → SSE stream of events (see below). |
| `POST` | `/title` | `{question, files[]}` → `{title}`. Generates a short session title. |
| `GET` | `/documents` | List documents owned by the current user (admins see all). |
| `DELETE` | `/documents/{filename}` | Remove a file and delete its chunks from ChromaDB. |
| `GET` | `/dashboard` | Returns models, chunk counts, token usage, and config. |
| `POST` | `/cancel/{filename}` | Request cancellation of an in-progress indexing job. |
| `GET` | `/debug/chunks/{filename}` | Return all stored chunk texts for a file (development only). |

### SSE event types (`/ask`)

```json
{ "type": "indexing_wait", "files": ["doc.pptx"] }
{ "type": "hypothesis",    "text": "A hypothetical passage…" }
{ "type": "token",         "content": "T" }
{ "type": "done",          "sources": ["file.pdf"], "citations": [{"file": "file.pdf", "pages": [1, 2]}], "warning": null, "mode": "standard" }
{ "type": "eval",          "faithfulness": 0.92, "answer_relevance": 0.87 }
{ "type": "error",         "message": "..." }
```

`mode` is `"comparison"` when per-file balanced retrieval was used, `"standard"` otherwise. `indexing_wait` is emitted every 2 s while waiting for a file to finish indexing — the client can abort at any time.

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

## Evaluation — v1.0 benchmark

Evaluated on a 116-question dataset covering all uploaded file types (DOCX, PDF, XLSX, PPTX, PUML, PNG) using `answer_eval.py`. Questions have ground-truth `expected_answer` fields; correctness is scored by a local LLM-as-judge (qwen2.5:7b).

**Retrieval quality** (Hit@4 / MRR — measured separately via `retrieval_eval.py`):

| Configuration | Hit@4 | MRR |
|---|---|---|
| Vector only | 86% | 0.68 |
| Hybrid (vector + BM25) | 86% | 0.68 |
| **Hybrid + Reranker** | **93%** | **0.81** |

**Answer quality** (113 scoreable questions — those with `expected_answer`):

| Metric | Score | Threshold |
|---|---|---|
| Pass rate (correctness ≥ 0.75) | **81.4%** | ≥ 80% |
| Avg correctness | **0.695** | ≥ 0.70 |
| Avg faithfulness | **0.883** | ≥ 0.85 |
| Avg relevance | **0.789** | ≥ 0.80 |

Configuration: `CHILD_CHUNK_SIZE=256`, `SIMILARITY_TOP_K=6`, `ENABLE_HYDE=true`, `ENABLE_MULTI_QUERY=true`, `ENABLE_RERANK=true`.



> Note: the judge and the answerer are the same model (qwen2.5:7b), which inflates scores by roughly 5–15%. Treat these numbers as a relative baseline for tracking regression, not as absolute accuracy.

---

## Technical decisions

**Why HyDE?**
Embedding a short question ("what are the project objectives?") produces a vector that sits in "question space", while indexed chunks sit in "answer space". A hypothetical passage bridges that gap — it's shaped like a document chunk, so cosine similarity works much better. The trade-off is one extra LLM call per query, but this runs in parallel with multi-query generation so the wall-clock cost is shared.

**Why multi-query retrieval?**
A single phrasing of a question may not match the vocabulary used in the source document. Generating 3 alternatives dramatically increases lexical and semantic coverage. Combined with RRF, chunks that appear across multiple query variants get boosted scores, reducing sensitivity to any one phrasing.

**Why LlamaIndex over LangChain?**
LlamaIndex has first-class support for hybrid retrievers, node postprocessors, and ChromaDB without needing custom wrapper code. The `QueryFusionRetriever` with `reciprocal_rerank` mode handles BM25 + vector fusion in a few lines.

**Why BM25 + vector instead of vector alone?**
Vector search struggles with exact keyword lookups — product codes, names, numbers. BM25 is strong there but misses paraphrasing. Fusing both gives consistent performance across both query types.

**Why a cross-encoder for re-ranking instead of relying on fusion scores?**
Bi-encoder similarity scores (used by both BM25 and vector search) score query and document independently. A cross-encoder reads them together and produces a much more accurate relevance estimate. `BAAI/bge-reranker-base` adds ~1–2 s per query on CPU with a measurable quality improvement over the previous `ms-marco-MiniLM-L-6-v2`.

**Why LLM-as-judge for evaluation?**
Standard RAG evaluation frameworks (RAGAS, TruLens) require either ground-truth datasets or cloud API calls. Using the local LLM itself as judge means evaluation runs fully offline with zero extra dependencies. The trade-off is that the judge and the answerer are the same model, which inflates scores slightly — acceptable for a development feedback signal.

**Why SSE instead of WebSockets?**
SSE is unidirectional (server → client) which fits the streaming response pattern exactly. It works over plain HTTP, requires no connection upgrade, and is trivially supported by FastAPI's `StreamingResponse`. WebSockets would add complexity (connection management, ping/keep-alive) with no benefit here.
