# RAG Multimodal Assistant

A local Retrieval-Augmented Generation (RAG) assistant that answers questions about your uploaded documents (PDFs and images). Everything runs locally via [Ollama](https://ollama.com) — no cloud APIs required.

---

## Architecture

```
rag-frontend/   React + Vite UI
rag-backend/    FastAPI + LlamaIndex + ChromaDB
Ollama          Local LLM inference (Mistral, LLaVA, nomic-embed-text)
```

**Flow:** Upload a file → backend extracts text (PDF) or describes it visually (image via LLaVA) → chunks are embedded and stored in ChromaDB → questions are answered by retrieving relevant chunks and passing them to Mistral.

---

## Prerequisites

### 1. Ollama

Install from https://ollama.com, then pull the three required models:

```bash
ollama pull mistral:7b-instruct-q4_K_M   # ~4.1 GB — text generation
ollama pull nomic-embed-text              # ~274 MB — embeddings
ollama pull llava                         # ~4.7 GB — image understanding
```

> **GPU note:** tested on RTX 4070 (8 GB VRAM). The `mistral:7b-instruct-q4_K_M` quantization fits comfortably alongside the embed model. If you have less VRAM, try a smaller quantization (e.g. `q3_K_M`).

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

# Copy the example env file
copy .env.local.example .env.local   # Windows
# cp .env.local.example .env.local   # macOS/Linux
```

The only frontend variable is `VITE_API_URL` (default: `http://localhost:8000`). Change it if your backend runs on a different host or port.

---

## Running

Open two terminals:

**Terminal 1 — backend:**
```bash
cd rag-backend
venv\Scripts\activate
uvicorn main:app --reload
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
| PDF | Text extracted with `pdfplumber`; each page image also described by LLaVA |
| PNG / JPG / JPEG / WEBP / GIF | Described by LLaVA vision model |

---

## Project Structure

```
rag-assistant/
├── rag-backend/
│   ├── main.py              # FastAPI app — upload, indexing, /ask endpoint
│   ├── requirements.txt
│   ├── .env.example
│   └── venv/
├── rag-frontend/
│   ├── src/
│   │   ├── App.jsx          # Main React component
│   │   └── App.css          # Styles
│   ├── .env.local.example
│   └── package.json
└── README.md
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/upload` | Upload a file; returns `{id, name, status}` |
| `GET` | `/status/{filename}` | Poll indexing status: `indexing` → `ready` |
| `POST` | `/ask` | `{question, filenames[]}` → `{answer, sources[]}` |
| `DELETE` | `/document/{filename}` | Remove a file and its chunks from the index |

---

## Deduplication

Re-uploading a file with the same content (same MD5 hash) that is already indexed returns `"status": "ready"` immediately without re-indexing. Note that the hash cache is in-memory and resets on server restart.
