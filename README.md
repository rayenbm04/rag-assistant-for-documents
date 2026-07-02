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
Four file-type-specific pinning strategies guarantee critical chunks are always in context regardless of retrieval scores:
- **PPTX**: slide index, total slide count, and cover slide body are always injected.
- **MLD/schema files**: the entity overview node (listing all table names) is always pinned first, so "list all entities" queries always receive the complete index.
- **UML / PlantUML / diagram images**: ALL entity blocks are pinned unconditionally — structured schema data should never be partially retrieved.
- **Scanned PDFs**: the first page chunk (containing supplier name, client, date, reference number, currency) is always injected — prevents table-fragment chunks from outranking the document header in retrieval.

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

**Vision-extracted PDF page chunking**
When a PDF has image-only pages processed by the vision model, the standard token-size chunker is also bypassed. Instead, each page is kept as a single chunk — a natural unit since the vision model already processes pages individually. This prevents the 128-char child chunk splitter from cutting markdown table rows mid-cell (e.g. splitting `75,546` across two chunks), which was the main cause of poor retrieval on scanned invoices and forms.

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

## MCP integration (Claude Desktop)

`mcp_server.py` exposes the RAG assistant as a set of tools inside Claude Desktop. Once configured, you can query indexed documents, upload new files from local paths or URLs, and check indexing progress — all from any Claude conversation without opening the browser.

### Tools exposed

| Tool | Description |
|---|---|
| `list_documents()` | Lists all indexed files ready to query |
| `query_documents(question, files, provider)` | Runs the full RAG pipeline and returns the answer with citations |
| `upload_document(file_path, provider)` | Uploads a file from a local path and starts indexing in the background |
| `upload_document_from_url(url, filename, provider)` | Downloads a file from any URL and indexes it — ideal for the GitHub → RAG workflow |
| `upload_document_content(filename, content_base64, provider)` | Indexes a file from base64-encoded bytes — use when attaching a file directly to the Claude Desktop conversation |
| `check_indexing_status(filename)` | Polls indexing progress for a previously uploaded file |

All upload tools return immediately — indexing runs in the background. Call `check_indexing_status` to know when a file is ready.

### Setup

**1. Install the MCP dependency**

```bash
cd rag-backend
venv\Scripts\activate
pip install fastmcp
```

**2. Add credentials to `.env`**

```env
MCP_EMAIL=your@email.com
MCP_PASSWORD=yourpassword
MCP_BASE_URL=http://localhost:8000
```

These must match an existing account in the app. The same files are visible in the web UI under the **Library** section (files indexed via MCP but not yet added to a session).

**3. Configure Claude Desktop**

Find your config file:
- **Standard install**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Windows Store install**: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

Add the RAG assistant server. Use the full Python path from your venv to avoid PATH issues:

```json
{
  "mcpServers": {
    "rag-assistant": {
      "command": "D:\\PROJECTS\\rag-assistant\\rag-backend\\venv\\Scripts\\python.exe",
      "args": ["D:\\PROJECTS\\rag-assistant\\rag-backend\\mcp_server.py"]
    }
  }
}
```

**4. Start your backend, then restart Claude Desktop**

```bash
cd rag-backend
uvicorn main:app --reload
```

Restart Claude Desktop. A 🔌 icon in the bottom-left of the input bar confirms the MCP server connected.

### Usage examples

**Querying an indexed document**

```
You: What is the net amount to pay in the CCF invoice?

Claude: [calls list_documents → sees CCF04162026.pdf]
        [calls query_documents("net amount to pay", ["CCF04162026.pdf"])]

        The net amount to pay is **291,707 TND** (Tunisian Dinar).

        Sources:
          • CCF04162026.pdf (page 2)
```

**GitHub → RAG pipeline**

With the GitHub MCP also configured (see below), Claude can fetch a file from any repo and index it in one turn:

```
You: Index the requirements.txt from my rag-assistant-for-documents repo.

Claude: [calls get_file_contents → gets raw download URL]
        [calls upload_document_from_url(url, "requirements.txt")]
        ✓ 'requirements.txt' uploaded — indexing started.

You: Check if it's ready.

Claude: [calls check_indexing_status("requirements.txt")]
        ✓ 'requirements.txt' is fully indexed and ready to query.
```

**Attaching a file directly**

```
You: [attaches report.pdf] Upload this to the RAG assistant.

Claude: [reads file → base64-encodes it]
        [calls upload_document_content("report.pdf", "<base64>")]
        ✓ 'report.pdf' uploaded — call check_indexing_status when ready.
```

### Adding the GitHub MCP

Lets Claude fetch files from any GitHub repo and pipe them straight into your RAG index.

**1. Generate a GitHub Personal Access Token**

Go to github.com → Settings → Developer settings → Personal access tokens → Generate new token (classic). Check the `repo` scope (or `public_repo` if you only have public repos). Copy the token.

**2. Add to Claude Desktop config**

Node.js must be installed. Find the full path to `npx` by running `where npx` in Command Prompt, then add:

```json
{
  "mcpServers": {
    "rag-assistant": { ... },
    "github": {
      "command": "C:\\Program Files\\nodejs\\npx.cmd",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Also add your token to `rag-backend/.env` so the MCP server can download from private repos directly:

```env
GITHUB_PERSONAL_ACCESS_TOKEN=YOUR_TOKEN_HERE
```

**3. Restart Claude Desktop**

Both MCPs will appear in the tools panel. The full workflow — *"Index main.py from my repo"* — now resolves in a single conversation turn.

### Notes

- Your FastAPI backend must be running for the tools to work.
- `provider="local"` uses Ollama (default, fully private). `provider="cloud"` uses Groq (faster, requires `GROQ_API_KEY`).
- Large files (>500 chunks) can take several minutes to embed locally. Upload returns immediately; poll `check_indexing_status` every 30 s.
- Files indexed via MCP appear in the web UI under a **Library** section in the Files panel — click `+` to add them to the current session, or the trash icon to delete them.

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

### Answer quality — Local (105 questions)

Evaluated with `answer_eval.py` on a 105-question dataset covering all file types (DOCX, PDF, XLSX, PPTX, PUML, PNG, scanned PDF). Correctness scored by keyword-overlap. Faithfulness and relevance scored by the local LLM-as-judge (same model as the answerer — scores may be inflated by ~5–15%).

| Model | Provider | Questions | Faithfulness | Relevance | Correctness |
|---|---|---|---|---|---|
| **qwen2.5:7b** | **Local (Ollama)** | **105 / 105** | **0.937** | **0.899** | **0.798** |

| Metric | Score | Threshold |
|---|---|---|
| Faithfulness | 0.937 | ≥ 0.85 ✓ |
| Relevance | 0.899 | ≥ 0.80 ✓ |
| Correctness | 0.798 | ≥ 0.70 ✓ |

---

### Answer quality — Cloud / Groq (65 questions)

The cloud eval covers 65 questions across all file types including scanned PDFs. Groq's free-tier token limits (100K TPD for 70B-class models) make larger runs impractical in a single session. All three metrics are scored by `llama-3.1-8b-instant` as LLM-as-judge. Aux calls (HyDE, multi-query, condensing) always use `llama-3.1-8b-instant` regardless of which main model is selected — so every run is a hybrid: 8B for aux, selected model for final answer generation.

| Model | Questions | Faithfulness | Relevance | Correctness |
|---|---|---|---|---|
| **llama-3.1-8b-instant** | **65** | 82.6% | 83.8% | **84.5%** |
| **llama-3.3-70b-versatile** | **65** | **84.8%** | **84.3%** | 81.5% |
| meta-llama/llama-4-scout-17b-16e-instruct | **65** | 80.4% | 84.0% | 81.0% |

> **Scout note:** Scout doubles as both the vision model (image and scanned-PDF analysis) and a capable text generation model. Its scores are competitive with the 70B despite being a much smaller model.

---

### Model comparison

Full comparison across all models and providers on a common 65-question subset (answer quality). Retrieval always uses `nomic-embed-text` — differences in Hit@8 reflect the quality of LLM-generated HyDE queries.

**Retrieval quality on scanned PDF (CCF — 15 questions)**

| Model | Provider | Hit@8 | MRR |
|---|---|---|---|
| qwen2.5:7b | Local | 86.7% | 0.80 |
| llama-3.3-70b-versatile | Cloud | 93.3% | 0.90 |
| llama-4-scout-17b | Cloud | 93.3% | 0.90 |
| **llama-3.1-8b-instant** | **Cloud** | **100%** | **0.97** |

**Answer quality — all file types**

| Model | Provider | Q | Faithfulness | Relevance | Correctness |
|---|---|---|---|---|---|
| **qwen2.5:7b** | Local | 105 | **93.7%** | **89.9%** | 79.8% |
| llama-3.1-8b-instant | Cloud | 65 | 82.6% | 83.8% | **84.5%** |
| **llama-3.3-70b-versatile** | **Cloud** | **65** | **84.8%** | **84.3%** | 81.5% |
| llama-4-scout-17b | Cloud | 65 | 80.4% | 84.0% | 81.0% |

**Key takeaways**

- **Local (qwen2.5:7b)** scores highest on faithfulness (93.7%) and relevance (89.9%) — it stays tightly grounded in retrieved context and runs entirely offline with no data leaving the machine.
- **llama-3.1-8b-instant** achieves the best correctness (84.5%) and perfect retrieval on scanned PDFs (Hit@8=100%), despite being the smallest cloud model. Best choice when accuracy on factual documents matters.
- **llama-3.3-70b-versatile** delivers the best overall balance across all three metrics. Recommended for general-purpose use on the cloud tier.
- **Scout (llama-4-scout-17b)** is the only model that serves dual duty as both vision model (scanned PDF / image extraction) and text generation model. Its answer quality is comparable to the 70B at a much lower cost.

---

## Technical decisions

**Why HyDE?**
Embedding a short question ("what are the project objectives?") produces a vector that sits in "question space", while indexed chunks sit in "answer space". A hypothetical passage bridges that gap — it's shaped like a document chunk, so cosine similarity works much better. The trade-off is one extra LLM call per query, but this runs in parallel with multi-query generation so the wall-clock cost is shared.

**Why multi-query retrieval?**
A single phrasing of a question may not match the vocabulary used in the source document. Generating 3 alternatives dramatically increases lexical and semantic coverage. Combined with RRF, chunks that appear across multiple query variants get boosted scores, reducing sensitivity to any one phrasing.

**Why delimiter-based chunking for MLD schemas?**
Fixed-size token chunking splits entity definitions mid-definition. A retriever with top-K=8 then misses the entities whose chunks happened to score lower. Splitting on `;` guarantees each entity is one atomic chunk, and the overview node (listing all entity names) scores highest on exhaustive queries — so "list all entities" always returns the complete list regardless of top-K.

**Why page-level chunking for vision-extracted PDFs?**
The vision model processes one page at a time and returns a markdown transcript — tables included. If that transcript is then split by the 128-char child chunker, markdown table rows are cut mid-cell: `75,` in one chunk and `546 | 20 | 60,437` in the next. No retriever can recover the original row from those fragments, and the LLM can't answer questions about pricing. Keeping each page as one chunk preserves table structure at the cost of slightly larger retrieval units — an acceptable trade-off for structured documents.

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
