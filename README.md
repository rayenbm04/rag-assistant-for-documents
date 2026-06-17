# RAG Multimodal Assistant

A local Retrieval-Augmented Generation (RAG) assistant that answers questions about your uploaded documents. Everything runs locally via [Ollama](https://ollama.com) — no cloud APIs required.

---

## Architecture

```
rag-frontend/   React + Vite UI
rag-backend/    FastAPI + LlamaIndex + ChromaDB
Ollama          Local LLM inference (Mistral, LLaVA, nomic-embed-text)
```

**Flow:** Upload a file → backend extracts text → chunks are embedded and stored in ChromaDB → questions are answered by retrieving relevant chunks and passing them to the LLM, with full conversation history included.

---

## Prerequisites

### 1. Ollama

Install from https://ollama.com, then pull the three required models:

```bash
ollama pull mistral:7b-instruct-q4_K_M   # ~4.1 GB — text generation
ollama pull nomic-embed-text              # ~274 MB — embeddings
ollama pull llava                         # ~4.7 GB — image understanding
```

> **GPU note:** tested on RTX 4070 (8 GB VRAM). The `mistral:7b-instruct-q4_K_M` quantization fits comfortably alongside the embed model. If you have less VRAM, try a smaller quantization (e.g. `q3_K_M`). To swap models, change `LLM_MODEL` in `.env` and restart uvicorn.

### 2. Python 3.10+

### 3. Node.js 18+

---

## Backend Setup

```bash
cd rag-backend

# Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

pip install -r requirements.txt

# Copy the example env file and adjust if needed
copy .env.example .env       # Windows
# cp .env.example .env       # macOS/Linux
```

### Environment variables (`rag-backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `LLM_MODEL` | `mistral:7b-instruct-q4_K_M` | Ollama model for text generation |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama model for embeddings |
| `VISION_MODEL` | `llava` | Ollama model for image analysis |
| `UPLOAD_DIR` | `./uploads` | Where uploaded files are saved |
| `CHROMA_DIR` | `./chroma_db` | ChromaDB persistent storage path |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated CORS origins |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum file upload size |
| `SIMILARITY_TOP_K` | `4` | Number of chunks retrieved per query |

---

## Frontend Setup

```bash
cd rag-frontend

npm install

copy .env.local.example .env.local   # Windows
# cp .env.local.example .env.local   # macOS/Linux
```

The only frontend variable is `VITE_API_URL` (default: `http://localhost:8000`).

---

## Running

Open two terminals:

**Terminal 1 — backend:**
```bash
cd rag-backend
venv\Scripts\activate
uvicorn venv/main:app --reload
```

**Terminal 2 — frontend:**
```bash
cd rag-frontend
npm run dev
```

Open http://localhost:5173 in your browser.

---

## Supported File Types

| Type | Processing |
|---|---|
| PDF | Text extracted with `pdfplumber`; image-only pages sent to LLaVA |
| PNG / JPG / JPEG / WEBP / GIF | Described by LLaVA vision model |
| DOCX | Paragraphs and tables extracted with `python-docx` |
| TXT | Read directly as plain text |

---

## Features

**Document Q&A**
Upload documents and ask questions in natural language. Answers are grounded in retrieved chunks with source citations.

**Conversational memory**
Follow-up questions like "explain that further" or "do the same for the second document" work correctly. Each question is condensed into a standalone query using the last 5 turns of history before retrieval.

**File preview**
Click any indexed document in the sidebar to open it in a new browser tab (PDFs and images render natively).

**Chat history persistence**
Conversations survive page refreshes via `localStorage`. A "Clear chat" button appears in the navbar when history is present.

**Prompt history navigation**
Press ↑ / ↓ in the input field to cycle through previous prompts, just like a terminal.

**Upload deduplication**
Re-uploading the same file (identical content) skips re-indexing and returns "ready" immediately. The hash cache resets on server restart.

**Queued prompts during indexing**
Sending a question while a file is still indexing queues the request — the backend waits for indexing to finish, then answers. The UI shows "Waiting for indexing to finish…" → "Generating a response…".

**Markdown rendering**
AI responses render markdown: headers, bold/italic, bullet lists, code blocks, tables, blockquotes.

**Usage dashboard**
Click **Stats** in the navbar to see: questions asked, documents indexed, total chunks, chunks-per-query, active models, and token usage with estimated cost on paid models (GPT-4o, Claude, Gemini, etc.).

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/upload` | Upload a file; returns `{id, name, status}` |
| `GET` | `/status/{filename}` | Poll indexing status: `indexing` → `ready` |
| `GET` | `/files/{filename}` | Serve an uploaded file for browser preview |
| `POST` | `/ask` | `{question, history[]}` → `{answer, sources[]}` |
| `GET` | `/documents` | List all uploaded documents |
| `DELETE` | `/documents/{filename}` | Remove a file and its chunks |
| `DELETE` | `/documents/all` | Wipe everything |
| `GET` | `/dashboard` | Stats: models, chunks, token usage, config |
| `POST` | `/cancel/{filename}` | Cancel an in-progress indexing job |

---

## Running Tests

```bash
cd rag-backend
venv\Scripts\activate
pip install pytest httpx
pytest tests/ -v
```

Tests cover: `.txt` extraction, `.docx` extraction, token tracking, and API endpoints (`/status`, `/documents`, `/dashboard`, `/upload`, `/ask`). All external services (Ollama, ChromaDB, LlamaIndex) are mocked so tests run offline.

---

## Project Structure

```
rag-assistant/
├── rag-backend/
│   ├── venv/
│   │   └── main.py          # FastAPI app
│   ├── tests/
│   │   ├── conftest.py      # Mocks for offline testing
│   │   ├── test_extraction.py
│   │   └── test_api.py
│   ├── requirements.txt
│   ├── pytest.ini
│   └── .env.example
├── rag-frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   └── App.css
│   ├── .env.local.example
│   └── package.json
└── README.md
```
