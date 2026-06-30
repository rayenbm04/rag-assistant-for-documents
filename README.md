# RAG Multimodal Assistant

A multimodal Retrieval-Augmented Generation (RAG) assistant that answers questions about your documents. Supports PDFs, Word files, PowerPoint presentations, spreadsheets, PlantUML diagrams, plain text, images, and web URLs.

Runs fully locally via [Ollama](https://ollama.com) by default — no data leaves your machine. Optionally switch to **Groq** (free, Llama 3.3 70B) or **OpenAI** (GPT-4o) per session using the in-app toggle.

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
│  /upload → extract → chunk → embed → ChromaDB                  │
│  /reindex → re-extract + re-embed without re-uploading          │
│                                                                 │
│  /ask  ┌─ condense + typo-correct question                      │
│        ├─ exhaustive query detection (list/résume/extrait)      │
│        ├─ HyDE: generate hypothetical passage for vector search │
│        ├─ multi-query: 3 rephrased questions for wider recall   │
│        ├─ hybrid retrieve: vector (ChromaDB) + BM25             │
│        ├─ RRF merge across all query variants                   │
│        ├─ cross-encoder re-rank (BAAI/bge-reranker-base)        │
│        ├─ smart pinning: PPTX overview / MLD overview / UML     │
│        ├─ build prompt (labeled context + history)              │
│        ├─ stream answer token-by-token via SSE                  │
│        └─ LLM-as-judge eval: faithfulness + relevance           │
└──────────────┬─────────────────────────────┬───────────────────┘
               │                             │
┌──────────────▼──────────┐   ┌─────────────▼─────────────────────┐
│       Ollama            │   │   SQLite (rag_users.db)            │
│  qwen2.5:7b             │   │   Users · hashed passwords · roles │
│  nomic-embed-text       │   └────────────────────────────────────┘
│  qwen2.5vl:7b           │
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
              ▼
┌─────────────────────────┐
│  Exhaustive Query       │  "liste", "résume", "extrait", "summarize", "list all" →
│  Detection              │  fetch up to 200 chunks instead of top-K
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
    │  Smart Pinning       │  PPTX: always inject slide index + cover chunks
    │                      │  MLD: always inject entity overview node
    │                      │  UML/PUML/diagram images: pin ALL entity blocks
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

**Exhaustive query detection**
Queries containing listing/summary/extraction keywords in English or French (`list all`, `enumerate`, `summarize`, `résume`, `liste toutes`, `extrait`, `récapitule`, etc.) automatically switch to exhaustive mode: up to 200 chunks are fetched instead of top-K, and the system prompt explicitly instructs the LLM not to stop early, skip entries, or use "etc." — ensuring complete enumeration of entities, attributes, or items.

**Smart context pinning**
Three file-type-specific pinning strategies guarantee critical chunks are always in context regardless of retrieval scores:
- **PPTX**: slide index, total slide count, and cover slide body are always injected.
- **MLD/schema files**: the entity overview node (listing all table names) is always pinned first, so "list all entities" queries always receive the complete index.
- **UML / PlantUML / diagram images**: ALL entity blocks are pinned unconditionally — structured schema data should never be partially retrieved.

**Document comparison mode**
Automatically detected from keywords in English and French (*compare, contrast, difference, versus, à partir du PDF et du diagramme, les deux documents*, etc.). Switches from unified retrieval to per-file balanced retrieval — guaranteeing chunks from each document — and builds a labeled context (`=== Document: X ===`) so the LLM reasons across sources and cites each one explicitly.

**Session-scoped retrieval**
Each chat session tracks its own file list. Retrieval is filtered to only that session's documents using ChromaDB metadata filters, so sessions with different files never bleed into each other.

**History-aware question condensing**
Follow-up questions ("what about the second one?" / "explain further") are rewritten into standalone queries before retrieval, using the last 5 turns of conversation history. Typos are corrected at the same step, even for first messages.

---

### Ingestion

**Multimodal document support**

| Format | Processing |
|--------|-----------|
| PDF | Text extracted with `pdfplumber`; encoding artefacts fixed automatically (`Ø`→`é`, `(cid:28)`→`fi`, etc.); image-only pages sent to vision model in transcription mode |
| PPTX | Compact overview block (title index, total slide count, cover slide body) + per-slide detail blocks. Tables extracted from all shapes. |
| DOCX / DOC | Paragraphs and tables extracted with `python-docx`; document-level summary header with table row counts |
| XLSX / XLS | Sheets extracted with `openpyxl` / `xlrd` |
| PUML / PlantUML / UML | Parsed directly: all classes, attributes, and relationships extracted into one structured block per entity + an overview block listing all entity names. No vision model needed. |
| PNG / JPG / WEBP / GIF | Analyzed by vision model. Filenames matching UML/diagram keywords (`uml`, `diagram`, `schema`, `architecture`, `class`, `sequence`, `erd`, etc.) use a compact structured prompt extracting entity names, attributes, and all relationships. Other images use a general description prompt. |
| TXT / MD / CSV | Read directly |
| URL | Web pages fetched via `requests` + `BeautifulSoup`, cleaned to plain text, indexed like a local file |

**MLD / relational schema chunking**
When a document is detected as a relational schema (≥ 3 `entity = (...)` patterns), the standard token-size chunker is bypassed. Instead, the text is split on `;` delimiters so each entity definition becomes exactly one chunk. An additional overview chunk listing all entity names is prepended — this chunk scores highest on "list all entities / tables" queries and ensures exhaustive answers even when top-K < total entity count. Stale ChromaDB chunks are deleted before re-indexing so old and new chunks never mix.

**PDF encoding repair**
`pdfplumber` can produce garbled text when a PDF uses non-standard font encodings. All extracted text is passed through a post-processor that maps common CID ligature sequences (`(cid:28)` → `fi`, `(cid:29)` → `fl`, etc.) and corrects MacRoman/WinAnsi mis-maps (`Ø` → `é`, `Æ` → `à`, `Ç` → `ç`, etc.) common in French LaTeX-generated PDFs.

**Page-by-page progress tracking**
PDF indexing reports progress after each page. The frontend shows a live progress bar ("Page 3 / 12") instead of a generic spinner.

**Re-index without re-uploading**
Each file card has a ↺ button that clears the file's ChromaDB chunks and re-runs extraction with the current extractor — useful after updating extraction logic.

**Upload deduplication**
Re-uploading the same file (identical MD5) skips re-indexing and returns `ready` immediately.

**Cancellable indexing**
Each indexing job checks a cancellation flag between pages. Cancelling stops the job and deletes the partially-uploaded file.

---

### Authentication

**JWT-based user accounts**
Registration and login via `/auth/register` and `/auth/login`. Passwords hashed with bcrypt. Tokens are signed HS256 JWTs (7-day expiry). Every protected endpoint requires a `Bearer` token — expired tokens return `401` and the frontend redirects to login automatically.

**Multi-user support**
Each user has isolated chat history scoped per user-ID in `localStorage`. File ownership is tracked server-side (`file_owners.json`) — non-admin users can only query their own files. Deleting a session automatically deletes its uploaded files if no other session references them.

**Role-based access**
The first registered account is automatically `admin`. Admins can query any file. The user's name and role are shown in the navbar.

---

### Interface

**Three-column layout**
Left: sessions list with auto-generated titles. Centre: streaming chat with markdown rendering. Right: documents panel with upload zone, file cards, and prompt navigator.

**Streaming responses**
Answers stream character-by-character via SSE. A configurable delay (`STREAM_DELAY_MS`) makes output readable as it arrives.

**Cancel and restore**
A Cancel button replaces Send while a response is generating. Cancelling removes the pending response entry and restores the question to the input bar, so the user can edit and resend without retyping.

**Document preview**
- **PDF**: rendered in an iframe via the browser's native PDF viewer.
- **PPTX / DOCX / XLSX**: converted to PDF on demand by LibreOffice headless, then rendered in the same iframe. Conversions are cached by filename + mtime.
- **Images**: displayed directly.
- **Text / CSV / PUML**: shown as plain text.

**Usage dashboard**
Click **Stats** in the navbar to see: questions asked (server-tracked), average response time, documents indexed, total chunks, active models, token usage, and estimated cost if using paid APIs.

**Per-file summarization**
Each file row in the Stats dashboard has a **∑ Summarize** button. Clicking it streams a full document summary inline below the filename, scoped to that single file.

**Chunk viewer**
Clicking a file row in the Stats dashboard expands its stored chunks inline, showing the exact text the retriever works with. Useful for debugging retrieval quality.

**RAG evaluation badges**
After each answer, two LLM-as-judge calls score:
- **F** (Faithfulness): is every claim grounded in retrieved context?
- **R** (Answer relevance): does the answer address the question?

Scores appear as colour-coded badges (green ≥ 80%, amber 50–80%, red < 50%).

**PDF export**
Click **Export PDF** to print the current chat to a formatted PDF via the browser's print dialog.

**Prompt navigator**
Collapsible Prompts section lists every question in the session. Clicking scrolls directly to that exchange.

**LLM-generated session titles**
After the first message, a background request generates a 2–5 word title using both the question and filename.

---

## Prerequisites

### 1. Ollama

Install from [ollama.com](https://ollama.com), then pull the required models:

```bash
ollama pull qwen2.5:7b           # ~4.7 GB — text generation (recommended)
ollama pull nomic-embed-text     # ~274 MB — embeddings
ollama pull qwen2.5vl:7b         # ~4.7 GB — image & scanned PDF analysis
```

> Tested on an RTX 4070 (12 GB VRAM) — both models run 100% on GPU. For maximum quality use `qwen3:8b` (`LLM_MODEL=qwen3:8b` — thinking tokens suppressed automatically). For faster responses on weaker hardware, any Ollama-compatible 7B instruct model works.

**Optional: expand vision model context window** (recommended for large UML diagrams):

```bash
ollama show qwen2.5vl:7b --modelfile > qwen_custom.txt
# Add this line at the top of qwen_custom.txt:
#   PARAMETER num_ctx 8192
ollama create qwen2.5vl-large -f qwen_custom.txt
# Then set VISION_MODEL=qwen2.5vl-large in .env
```

### 2. Python 3.10+

### 3. Node.js 18+

### 4. LibreOffice (optional — for PPTX / DOCX / XLSX preview)

Install from [libreoffice.org](https://www.libreoffice.org). Without it, document preview falls back to plain text. All other features work normally.

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
uvicorn main:app --reload
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

The backend connects to Ollama on the host via `host.docker.internal:11434`. Uploaded files and ChromaDB are persisted in Docker volumes so data survives restarts.

---

## Environment variables

All variables are optional — sensible defaults are set for local development. Copy `.env.example` to `.env` inside `rag-backend/` to override.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `qwen2.5:7b` | Ollama model for text generation and eval |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `VISION_MODEL` | `qwen2.5vl:7b` | Ollama vision model for images and scanned PDFs |
| `UPLOAD_DIR` | `./uploads` | Where uploaded files are saved |
| `CHROMA_DIR` | `./chroma_db` | ChromaDB persistent storage path |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated CORS origins |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum file upload size |
| `SIMILARITY_TOP_K` | `4` | Chunks retrieved per query (2× fetched before re-ranking; exhaustive queries fetch up to 200) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `STREAM_DELAY_MS` | `20` | Delay between streamed characters in ms |
| `ENABLE_RERANK` | `true` | Enable cross-encoder re-ranking |
| `RERANK_MODEL` | `BAAI/bge-reranker-base` | HuggingFace cross-encoder model (~22 MB, downloaded on first run) |
| `ENABLE_EVAL` | `true` | Enable faithfulness + relevance scoring after each answer |
| `ENABLE_HYDE` | `true` | Enable HyDE hypothetical passage expansion |
| `ENABLE_MULTI_QUERY` | `true` | Enable multi-query retrieval (3 rephrased questions via RRF) |
| `MULTI_QUERY_N` | `3` | Number of alternative query phrasings |
| `OPENAI_API_KEY` | _(empty)_ | OpenAI API key — leave blank to disable the Cloud option |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model name |
| `GROQ_API_KEY` | _(empty)_ | Groq API key — leave blank to disable the Groq option |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model name |
| `SECRET_KEY` | `change-me-in-production` | HS256 signing key for JWT — **change before deploying** |
| `ACCESS_TOKEN_EXPIRE_DAYS` | `7` | JWT token lifetime in days |
| `DATABASE_URL` | `sqlite:///./rag_users.db` | SQLAlchemy connection string |
| `PARENT_CHUNK_SIZE` | `512` | Parent chunk size in tokens (AutoMerging docstore) |
| `CHILD_CHUNK_SIZE` | `256` | Child/leaf chunk size in tokens (ChromaDB) |
| `NODE_STORE_DIR` | `./node_store` | LlamaIndex docstore path |

---

## API reference

All endpoints except `/auth/register` and `/auth/login` require `Authorization: Bearer <token>`.

**Auth**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | `{email, password, firstname, lastname}` → `{access_token, user}`. First account becomes admin. |
| `POST` | `/auth/login` | `{email, password}` → `{access_token, user}` |
| `GET` | `/auth/me` | Current user profile |
| `GET` | `/auth/users` | (admin) List all users |
| `PATCH` | `/auth/users/{id}/role` | (admin) Change a user's role |

**Documents & chat**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Upload a file. Indexing runs in background. Returns `{id, name, status}`. |
| `POST` | `/upload-url` | `{url}` — Fetch and index a web page. Returns `{name, status, title}`. |
| `GET` | `/status/{filename}` | Poll indexing status. Returns `{status, progress}`. |
| `GET` | `/files/{filename}` | Serve an uploaded file for preview. |
| `GET` | `/slides-pdf/{filename}` | Convert PPTX to PDF via LibreOffice and serve (cached). |
| `GET` | `/doc-pdf/{filename}` | Convert DOCX / XLSX to PDF via LibreOffice and serve (cached). |
| `POST` | `/reindex/{filename}` | Clear and re-extract a file's chunks without re-uploading. |
| `POST` | `/ask` | `{question, history[], files[]}` → SSE stream (see below). |
| `POST` | `/title` | `{question, files[]}` → `{title}`. Generates a short session title. |
| `GET` | `/documents` | List documents owned by current user (admins see all). |
| `DELETE` | `/documents/{filename}` | Remove a file and delete its chunks from ChromaDB. |
| `GET` | `/dashboard` | Models, chunk counts, query stats, token usage, config. |
| `POST` | `/cancel/{filename}` | Cancel an in-progress indexing job. |
| `GET` | `/debug/chunks/{filename}` | Return all stored chunk texts for a file (dev only). |

### SSE event types (`/ask`)

```json
{ "type": "indexing_wait", "files": ["doc.pptx"] }
{ "type": "hypothesis",    "text": "A hypothetical passage…" }
{ "type": "token",         "content": "T" }
{ "type": "done",          "sources": ["file.pdf"], "citations": [{"file": "file.pdf", "pages": [1, 2]}], "warning": null, "mode": "standard" }
{ "type": "eval",          "faithfulness": 0.92, "answer_relevance": 0.87 }
{ "type": "error",         "message": "..." }
```

`mode` is `"comparison"` when per-file balanced retrieval was used, `"standard"` otherwise.

---

## Running tests

```bash
cd rag-backend
venv\Scripts\activate
pip install pytest httpx2
pytest tests/ -v
```

All external services (Ollama, ChromaDB, LlamaIndex) are mocked so tests run fully offline. 27/27 tests pass.

---

## Project structure

```
rag-assistant/
├── docker-compose.yml
├── rag-backend/
│   ├── main.py                  # FastAPI app — auth, all endpoints, RAG pipeline
│   ├── tests/
│   │   ├── conftest.py          # Mocks for offline testing
│   │   ├── test_extraction.py
│   │   └── test_api.py
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env.example
│   ├── rag_users.db             # SQLite user database (auto-created)
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

## Benchmarks

Pipeline config for all runs: `CHILD_CHUNK_SIZE=256`, `SIMILARITY_TOP_K=8`, `ENABLE_HYDE=true`, `ENABLE_MULTI_QUERY=true`, `ENABLE_RERANK=true`.

---

### Retrieval quality (Hit@8 / MRR) — 65 questions

Retrieval is model-independent — embeddings always use `nomic-embed-text` locally.

| Configuration | Hit@8 | MRR |
|---|---|---|
| Vector only | 96% | 0.72 |
| Hybrid (vector + BM25) | 99% | 0.78 |
| **Hybrid + Reranker** | **100%** | **0.89** |

---

### Answer quality — Local (110 questions)

Evaluated with `answer_eval.py` on a 110-question dataset covering all file types (DOCX, PDF, XLSX, PPTX, PUML, PNG). Correctness scored by keyword-overlap. Faithfulness and relevance scored by the local LLM-as-judge (same model as the answerer — scores may be inflated by ~5–15%).

| Model | Provider | Questions | Faithfulness | Relevance | Correctness |
|---|---|---|---|---|---|
| **qwen2.5:7b** | **Local (Ollama)** | **110 / 110** | **0.923** | **0.797** | **0.707** |

| Metric | Score | Threshold |
|---|---|---|
| Faithfulness | 0.923 | ≥ 0.85 ✓ |
| Relevance | 0.797 | ≥ 0.80 ~ |
| Correctness | 0.707 | ≥ 0.70 ✓ |

---

### Answer quality — Cloud / Groq (57 questions)

The cloud eval dataset was reduced from 110 to 57 questions for two reasons: (1) Groq's free-tier daily token limits (100K TPD for 70B-class models) make a 110-question eval with generation + three LLM-as-judge scoring calls per question impractical in a single run without hitting the cap; (2) the dataset was rebuilt from scratch against the current set of uploaded files, so questions targeting deprecated files were dropped.

All three metrics are scored by `llama-3.1-8b-instant` as LLM-as-judge. Aux calls (HyDE, multi-query, condensing) always use `llama-3.1-8b-instant` regardless of which main model is selected — so every run is a hybrid: 8B for aux, selected model for final answer generation.

| Model | Faithfulness | Relevance | Correctness |
|---|---|---|---|
| llama-3.1-8b-instant | 82% | 83% | **85%** |
| **llama-3.3-70b-versatile** | **84%** | **84%** | 82% |
| meta-llama/llama-4-scout-17b-16e-instruct | 79% | 84% | 81% |

> **Scout note:** Scout doubles as both the vision model (image and scanned-PDF analysis) and a capable text generation model. Its scores are competitive with the 70B despite being a much smaller model.

---

## Technical decisions

**Why HyDE?**
Embedding a short question ("what are the project objectives?") produces a vector that sits in "question space", while indexed chunks sit in "answer space". A hypothetical passage bridges that gap — it's shaped like a document chunk, so cosine similarity works much better. The trade-off is one extra LLM call per query, but this runs in parallel with multi-query generation so the wall-clock cost is shared.

**Why multi-query retrieval?**
A single phrasing of a question may not match the vocabulary used in the source document. Generating 3 alternatives dramatically increases lexical and semantic coverage. Combined with RRF, chunks that appear across multiple query variants get boosted scores, reducing sensitivity to any one phrasing.

**Why delimiter-based chunking for MLD schemas?**
Fixed-size token chunking splits entity definitions mid-definition. A retriever with top-K=8 then misses the entities whose chunks happened to score lower. Splitting on `;` guarantees each entity is one atomic chunk, and the overview node (listing all entity names) scores highest on exhaustive queries — so "list all entities" always returns the complete list regardless of top-K.

**Why pin all UML chunks?**
UML and PlantUML files are structured data, not narrative text. Every entity block is equally important and should always be in context. Embedding-based similarity would arbitrarily favour entities whose names happen to appear in the query. Pinning all blocks is O(n) in the number of entities and the context cost is acceptable given typical schema sizes (15–30 entities).

**Why LlamaIndex over LangChain?**
LlamaIndex has first-class support for hybrid retrievers, node postprocessors, and ChromaDB without needing custom wrapper code. The `QueryFusionRetriever` with `reciprocal_rerank` mode handles BM25 + vector fusion in a few lines.

**Why BM25 + vector instead of vector alone?**
Vector search struggles with exact keyword lookups — product codes, names, numbers. BM25 is strong there but misses paraphrasing. Fusing both gives consistent performance across both query types.

**Why a cross-encoder for re-ranking?**
Bi-encoder similarity scores query and document independently. A cross-encoder reads them together and produces a much more accurate relevance estimate. `BAAI/bge-reranker-base` adds ~1–2 s per query on CPU with a measurable quality improvement.

**Why LLM-as-judge for evaluation?**
Standard RAG evaluation frameworks (RAGAS, TruLens) require either ground-truth datasets or cloud API calls. Using the local LLM means evaluation runs fully offline with zero extra dependencies. The trade-off is score inflation — acceptable for a development feedback signal.

**Why SSE instead of WebSockets?**
SSE is unidirectional (server → client) which fits the streaming response pattern exactly. It works over plain HTTP, requires no connection upgrade, and is trivially supported by FastAPI's `StreamingResponse`.
