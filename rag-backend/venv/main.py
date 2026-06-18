import os, shutil, base64, asyncio, hashlib, json, re
import pdfplumber
from PIL import Image
from docx import Document as DocxDocument
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import chromadb
import ollama
from llama_index.core import VectorStoreIndex, Settings, Document, PromptTemplate
from llama_index.core.vector_stores.types import MetadataFilters, MetadataFilter, FilterOperator, FilterCondition
from llama_index.core.retrievers import QueryFusionRetriever
from llama_index.core.schema import TextNode
from llama_index.retrievers.bm25 import BM25Retriever
from llama_index.core.storage.storage_context import StorageContext
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.llms.ollama import Ollama
from llama_index.embeddings.ollama import OllamaEmbedding

# ── Load environment variables from .env ──
load_dotenv()

LLM_MODEL        = os.getenv("LLM_MODEL",           "mistral:7b-instruct-q4_K_M")
EMBED_MODEL      = os.getenv("EMBED_MODEL",          "nomic-embed-text")
VISION_MODEL     = os.getenv("VISION_MODEL",         "llava")
UPLOAD_DIR       = os.getenv("UPLOAD_DIR",           "./uploads")
CHROMA_DIR       = os.getenv("CHROMA_DIR",           "./chroma_db")
ALLOWED_ORIGINS  = os.getenv("ALLOWED_ORIGINS",      "http://localhost:5173").split(",")
SIMILARITY_TOP_K = int(os.getenv("SIMILARITY_TOP_K", "4"))
MAX_UPLOAD_MB    = int(os.getenv("MAX_UPLOAD_SIZE_MB", "50"))
OLLAMA_BASE_URL  = os.getenv("OLLAMA_BASE_URL",      "http://localhost:11434")
ENABLE_EVAL      = os.getenv("ENABLE_EVAL",          "true").lower() == "true"
ENABLE_RERANK    = os.getenv("ENABLE_RERANK",        "true").lower() == "true"
RERANK_MODEL     = os.getenv("RERANK_MODEL",         "cross-encoder/ms-marco-MiniLM-L-6-v2")

class HistoryEntry(BaseModel):
    question: str
    answer: str

class Question(BaseModel):
    question: str
    history: list[HistoryEntry] = []
    files: list[str] = []   # session's file names; empty = no documents in chat

cancelled_files = set()   # filenames that should stop indexing

Settings.llm = Ollama(model=LLM_MODEL, base_url=OLLAMA_BASE_URL, request_timeout=120.0, additional_kwargs={"num_gpu": 99})
Settings.embed_model = OllamaEmbedding(model_name=EMBED_MODEL, base_url=OLLAMA_BASE_URL, ollama_additional_kwargs={"num_gpu": 99})

app = FastAPI(title="RAG Assistant API")
app.add_middleware(CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"], allow_headers=["*"])

os.makedirs(UPLOAD_DIR, exist_ok=True)

# ── ChromaDB ──
chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
chroma_collection = chroma_client.get_or_create_collection("rag_docs")
vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
storage_context = StorageContext.from_defaults(vector_store=vector_store)

# ── global state ──
index = None
indexing_status = {}        # {"filename": "indexing" | "ready" | "error"}
indexing_progress = {}      # {"filename": {"current": int, "total": int}}
file_hashes = {}            # {"filename": md5_hex} — used to skip re-indexing unchanged files
executor = ThreadPoolExecutor(max_workers=2)
token_usage = {"prompt": 0, "completion": 0, "requests": 0}

# ── Cross-encoder reranker (loaded once at startup) ──
reranker = None
if ENABLE_RERANK:
    try:
        from sentence_transformers import CrossEncoder
        reranker = CrossEncoder(RERANK_MODEL)
        print(f"Reranker loaded: {RERANK_MODEL}")
    except Exception as _rerank_err:
        print(f"Reranker init failed ({_rerank_err}) — continuing without reranking")


def parse_eval_score(text: str) -> float | None:
    """Extract a 0.0–1.0 score from LLM output. Robust to prose around the number."""
    text = text.strip()
    # Match a decimal like 0.85 or 1.0, or an integer 0 or 1
    match = re.search(r'\b(1\.?0*|0?\.\d+)\b', text)
    if match:
        return round(min(max(float(match.group(1)), 0.0), 1.0), 2)
    return None


def record_tokens(result):
    """Extract token counts from a LlamaIndex CompletionResponse and accumulate."""
    raw = getattr(result, "raw", None) or {}
    prompt_tokens     = raw.get("prompt_eval_count", 0) or 0
    completion_tokens = raw.get("eval_count", 0)        or 0
    token_usage["prompt"]     += prompt_tokens
    token_usage["completion"] += completion_tokens
    return prompt_tokens, completion_tokens

# ── load existing index on startup ──
if chroma_collection.count() > 0:
    index = VectorStoreIndex.from_vector_store(
        vector_store,
        storage_context=storage_context
    )
    print(f"Loaded index — {chroma_collection.count()} chunks in ChromaDB")


# ──────────────────────────────────────────
# EXTRACTION FUNCTIONS
# ──────────────────────────────────────────

def pil_image_to_base64(pil_image):
    import io
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def image_to_base64(file_path):
    with open(file_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def analyze_image_with_llava(image_b64, context_hint=""):
    """Send image to LLaVA and extract ALL content useful for Q&A"""
    prompt = f"""You are a document analysis assistant. Analyze this image completely and extract ALL useful information.

{"Context: " + context_hint if context_hint else ""}

Follow these steps in order:

STEP 1 — TEXT: Copy ALL visible text exactly as written, word for word.

STEP 2 — COLORS (most important): For EVERY distinct element in the image, state its exact color.
Go through the image methodically:
- Background color
- Border or outline colors
- Each shape, icon, or graphic element and its color
- Each character, figure, or person and their clothing color
- Text color(s)
- Any decorative elements (stars, hearts, dots) and their colors
Use specific color names: teal, cyan, navy, coral, amber, lime, etc. — not just "blue" or "green".

STEP 3 — STRUCTURE: Describe the layout and what each element represents.

STEP 4 — TYPE-SPECIFIC details:
- UML diagram: list all classes/actors, attributes, methods, relationships
- Architecture diagram: every component, connection, data flow
- Table: reproduce all rows and columns
- Chart/graph: describe axes, values, legend, each data series and its color
- Screenshot: all visible UI elements, buttons, text, data
- Logo/illustration: describe every visual element and what it depicts

STEP 5 — PURPOSE: What is the overall meaning or purpose of this image?

Be exhaustive — your description will be the ONLY source of information about this image when answering user questions."""

    response = ollama.chat(
        model=VISION_MODEL,
        messages=[{
            "role": "user",
            "content": prompt,
            "images": [image_b64]
        }]
    )
    return response["message"]["content"]


def extract_pdf_content(file_path, filename, on_progress=None):
    full_content = f"Document: {filename}\n\n"

    with pdfplumber.open(file_path) as pdf:
        total_pages = len(pdf.pages)
        print(f"Processing PDF: {filename} ({total_pages} pages)")
        if on_progress:
            on_progress(0, total_pages)

        for i, page in enumerate(pdf.pages):
            # check if cancelled
            if filename in cancelled_files:
                print(f"Indexing cancelled: {filename}")
                raise InterruptedError(f"Cancelled by user")

            page_num = i + 1
            full_content += f"\n{'='*40}\nPage {page_num}/{total_pages}\n{'='*40}\n"

            text = page.extract_text() or ""
            if text.strip():
                full_content += f"\n[Text content]\n{text}\n"

            text_len = len(text.strip())

            # Only call LLaVA when pdfplumber extracted nothing at all —
            # i.e. a truly scanned / image-only page with no text layer.
            # LLaVA is NOT reliable as an OCR fallback and hallucinates on
            # text-heavy pages even when images are present (logos, dividers, etc.)
            needs_llava = text_len < 50

            if needs_llava:
                if filename in cancelled_files:
                    raise InterruptedError(f"Cancelled by user")
                try:
                    page_image = page.to_image(resolution=200).original
                    image_b64 = pil_image_to_base64(page_image)
                    visual = analyze_image_with_llava(
                        image_b64,
                        context_hint=f"Page {page_num}/{total_pages} of PDF '{filename}'"
                    )
                    full_content += f"\n[Visual content — page {page_num}]\n{visual}\n"
                except InterruptedError:
                    raise
                except Exception as e:
                    print(f"  Page {page_num}: LLaVA error — {e}")
            else:
                print(f"  Page {page_num}: sufficient text ({text_len} chars) — skipping LLaVA")

            if on_progress:
                on_progress(page_num, total_pages)

    return full_content


def extract_image_content(file_path, filename):
    """Extract content from standalone image using LLaVA"""
    print(f"Analyzing image with LLaVA: {filename}")
    image_b64 = image_to_base64(file_path)
    description = analyze_image_with_llava(
        image_b64,
        context_hint=f"Image file '{filename}'"
    )
    return f"Image file: {filename}\n\n{description}"


def extract_txt_content(file_path, filename):
    """Read plain text file directly."""
    print(f"Reading text file: {filename}")
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    return f"Text file: {filename}\n\n{text}"


def extract_docx_content(file_path, filename):
    """Extract text and tables from a Word document."""
    print(f"Reading Word document: {filename}")
    doc = DocxDocument(file_path)
    parts = [f"Document: {filename}\n"]

    for para in doc.paragraphs:
        if para.text.strip():
            parts.append(para.text)

    for i, table in enumerate(doc.tables):
        parts.append(f"\n[Table {i + 1}]")
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            parts.append(" | ".join(c for c in cells if c))

    return "\n".join(parts)


def extract_excel_content(file_path, filename):
    """Extract content from an Excel workbook (.xlsx / .xls) as readable text."""
    print(f"Reading Excel file: {filename}")

    def _row_to_str(cells: list) -> str:
        """Convert a row of values to a readable pipe-separated string."""
        str_cells = [str(c).strip() if c is not None else "" for c in cells]
        if not any(str_cells):
            return ""
        # If first column is empty but later columns have values, label as "Total"
        if not str_cells[0] and any(str_cells[1:]):
            str_cells[0] = "Total"
        return " | ".join(str_cells)

    try:
        import openpyxl
        wb = openpyxl.load_workbook(file_path, data_only=True)
        use_openpyxl = True
    except Exception:
        wb = None
        use_openpyxl = False

    if not use_openpyxl:
        try:
            import xlrd
            _xlrd_wb = xlrd.open_workbook(file_path)
        except Exception as e:
            return f"Document: {filename}\n[Could not read Excel file: {e}]"

    parts = [f"Document: {filename}\n"]

    if use_openpyxl:
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            if ws.max_row == 0:
                continue
            parts.append(f"\n[Sheet: {sheet_name}]")
            for row in ws.iter_rows(values_only=True):
                line = _row_to_str(list(row))
                if line:
                    parts.append(line)
    else:
        for i in range(_xlrd_wb.nsheets):
            ws = _xlrd_wb.sheet_by_index(i)
            parts.append(f"\n[Sheet: {ws.name}]")
            for rx in range(ws.nrows):
                cells = [ws.cell_value(rx, cx) for cx in range(ws.ncols)]
                line = _row_to_str(cells)
                if line:
                    parts.append(line)

    return "\n".join(parts)


def get_nodes_for_files(file_names: list) -> list:
    """Fetch text nodes from ChromaDB so BM25 can index them for keyword search."""
    nodes = []
    for fname in file_names:
        try:
            results = chroma_collection.get(
                where={"file_name": fname},
                include=["documents", "metadatas"]
            )
            for doc_id, text, meta in zip(
                results["ids"], results["documents"], results["metadatas"]
            ):
                nodes.append(TextNode(id_=doc_id, text=text or "", metadata=meta or {}))
        except Exception as e:
            print(f"BM25 node fetch error for {fname}: {e}")
    return nodes


def add_document_to_index(file_path, filename):
    global index
    try:
        indexing_status[filename] = "indexing"
        indexing_progress[filename] = {"current": 0, "total": 0}
        extension = filename.lower().split('.')[-1]

        if extension == 'pdf':
            def _on_progress(current, total):
                indexing_progress[filename] = {"current": current, "total": total}
            text = extract_pdf_content(file_path, filename, on_progress=_on_progress)
            doc_type = "pdf"
        elif extension in ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']:
            if filename in cancelled_files:
                raise InterruptedError("Cancelled by user")
            text = extract_image_content(file_path, filename)
            doc_type = "image"
        elif extension == 'txt':
            text = extract_txt_content(file_path, filename)
            doc_type = "txt"
        elif extension == 'docx':
            text = extract_docx_content(file_path, filename)
            doc_type = "docx"
        elif extension in ['xlsx', 'xls']:
            text = extract_excel_content(file_path, filename)
            doc_type = "excel"
        else:
            text = f"[Unsupported file: {filename}]"
            doc_type = "unknown"

        doc = Document(
            text=text,
            metadata={"file_name": filename, "file_path": file_path, "doc_type": doc_type}
        )

        if index is None:
            index = VectorStoreIndex.from_documents([doc], storage_context=storage_context)
        else:
            index.insert(doc)

        indexing_status[filename] = "ready"
        indexing_progress.pop(filename, None)
        cancelled_files.discard(filename)
        print(f"Ready: {filename} ({doc_type}, {len(text)} chars)")

    except InterruptedError:
        indexing_status[filename] = "cancelled"
        indexing_progress.pop(filename, None)
        cancelled_files.discard(filename)
        # delete the physical file since indexing was cancelled
        if os.path.exists(file_path):
            os.remove(file_path)
        print(f"Cancelled and cleaned: {filename}")

    except Exception as e:
        indexing_status[filename] = "error"
        indexing_progress.pop(filename, None)
        print(f"Indexing error for {filename}: {e}")

# ──────────────────────────────────────────
# API ENDPOINTS
# ──────────────────────────────────────────

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """
    Save file and start indexing in background.
    If the same file (identical content) is re-uploaded, returns "ready" immediately.
    Returns immediately — frontend polls /status/{filename} to know when ready.
    """
    content = await file.read()
    incoming_hash = hashlib.md5(content).hexdigest()

    # Skip re-indexing if the file is already indexed and content is unchanged
    if (
        file_hashes.get(file.filename) == incoming_hash
        and indexing_status.get(file.filename) == "ready"
    ):
        print(f"Skipping re-index (unchanged): {file.filename}")
        return {"id": file.filename, "name": file.filename, "status": "ready"}

    path = f"{UPLOAD_DIR}/{file.filename}"

    # Clean old ChromaDB chunks for this filename
    try:
        results = chroma_collection.get(where={"file_name": file.filename})
        if results["ids"]:
            chroma_collection.delete(ids=results["ids"])
            print(f"Cleaned old chunks for {file.filename}")
    except Exception as e:
        print(f"Cleanup error: {e}")

    # Save new file
    with open(path, "wb") as f:
        f.write(content)

    file_hashes[file.filename] = incoming_hash
    indexing_status[file.filename] = "indexing"
    loop = asyncio.get_event_loop()
    loop.run_in_executor(executor, add_document_to_index, path, file.filename)

    return {"id": file.filename, "name": file.filename, "status": "indexing"}

@app.get("/status/{filename}")
def get_status(filename: str):
    """
    Poll this endpoint to know when a file is ready.
    Returns: indexing | ready | error | unknown
    """
    status   = indexing_status.get(filename, "unknown")
    progress = indexing_progress.get(filename)  # {"current": int, "total": int} or None
    return {"filename": filename, "status": status, "progress": progress}


@app.get("/documents")
def list_documents():
    files = os.listdir(UPLOAD_DIR)
    return [
        {
            "id": f,
            "name": f,
            "status": indexing_status.get(f, "ready")
        }
        for f in files if not f.startswith('.')
    ]


@app.get("/index/stats")
def index_stats():
    return {
        "total_chunks": chroma_collection.count(),
        "files": os.listdir(UPLOAD_DIR),
        "indexing_status": indexing_status
    }


@app.get("/dashboard")
def dashboard():
    files = [f for f in os.listdir(UPLOAD_DIR) if not f.startswith('.')]
    ready = [f for f in files if indexing_status.get(f, "ready") == "ready"]
    indexing = [f for f in files if indexing_status.get(f, "") == "indexing"]

    # Per-file chunk counts
    file_chunks = {}
    for f in files:
        try:
            res = chroma_collection.get(where={"file_name": f})
            file_chunks[f] = len(res["ids"])
        except Exception:
            file_chunks[f] = 0

    return {
        "models": {
            "llm": LLM_MODEL,
            "embed": EMBED_MODEL,
            "vision": VISION_MODEL,
        },
        "documents": {
            "total": len(files),
            "ready": len(ready),
            "indexing": len(indexing),
            "file_chunks": file_chunks,
        },
        "chunks": {
            "total": chroma_collection.count(),
        },
        "config": {
            "similarity_top_k": SIMILARITY_TOP_K,
            "max_upload_mb": MAX_UPLOAD_MB,
        },
        "tokens": {
            "prompt": token_usage["prompt"],
            "completion": token_usage["completion"],
            "total": token_usage["prompt"] + token_usage["completion"],
            "requests": token_usage["requests"],
        }
    }


@app.get("/files/{filename}")
def serve_file(filename: str):
    path = f"{UPLOAD_DIR}/{filename}"
    if not os.path.exists(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path)


class TitleRequest(BaseModel):
    question: str
    files: list[str] = []

@app.post("/title")
async def generate_title(req: TitleRequest):
    """Generate a specific 2-5 word session title from the question and file names."""
    files_hint = ""
    if req.files:
        names = ", ".join(req.files)
        files_hint = f"Files involved: {names}\n"
    prompt = (
        "Write a 2 to 5 word title that captures the specific action AND the subject. "
        "Include the document name or key subject so the user knows exactly what this chat is about. "
        "Return ONLY the title — no punctuation, no quotes, no explanation.\n\n"
        f"{files_hint}"
        f"Request: {req.question}\n\nTitle:"
    )
    result = await Settings.llm.acomplete(prompt)
    title = str(result).strip().strip('"\'').strip('.')
    return {"title": title}


_COMPARISON_KEYWORDS = {
    'compare', 'comparison', 'contrast', 'difference', 'differences',
    'versus', ' vs ', ' vs.', 'similar', 'similarity', 'both documents',
    'both files', 'each document', 'each file', 'across documents',
    'across files', 'which document', 'which file', 'between the two',
}

def is_comparison_query(question: str, num_files: int) -> bool:
    """Return True when the question likely asks for a cross-document comparison."""
    if num_files < 2:
        return False
    q = question.lower()
    return any(kw in q for kw in _COMPARISON_KEYWORDS)


async def retrieve_per_file(
    standalone: str,
    question_files: list[str],
    chunks_per_file: int,
) -> tuple[list, str, list[str]]:
    """
    Retrieve `chunks_per_file` chunks from each file independently,
    then assemble a labeled context so the LLM knows what belongs to what.
    Returns (all_nodes, labeled_context, sources).
    """
    all_nodes: list = []
    context_parts: list[str] = []

    loop = asyncio.get_event_loop()

    for fname in question_files:
        file_filter = MetadataFilters(
            filters=[MetadataFilter(key="file_name", value=fname, operator=FilterOperator.EQ)],
            condition=FilterCondition.OR,
        )
        vec_ret = index.as_retriever(similarity_top_k=chunks_per_file, filters=file_filter)

        file_bm25_nodes = get_nodes_for_files([fname])
        if file_bm25_nodes:
            bm25_ret = BM25Retriever.from_defaults(
                nodes=file_bm25_nodes, similarity_top_k=chunks_per_file
            )
            ret = QueryFusionRetriever(
                [vec_ret, bm25_ret],
                similarity_top_k=chunks_per_file,
                num_queries=1,
                mode="reciprocal_rerank",
                use_async=True,
            )
        else:
            ret = vec_ret

        file_nodes = await ret.aretrieve(standalone)

        # Per-file reranking — keep scores balanced across files
        if reranker and len(file_nodes) > 1:
            captured = list(file_nodes)
            q_str    = standalone
            k        = chunks_per_file

            def _rerank_file(nodes_in=captured, q=q_str, top=k):
                pairs  = [(q, n.get_content()) for n in nodes_in]
                scores = reranker.predict(pairs)
                ranked = sorted(zip(nodes_in, scores), key=lambda x: x[1], reverse=True)
                return [n for n, _ in ranked[:top]]

            file_nodes = await loop.run_in_executor(None, _rerank_file)

        if file_nodes:
            all_nodes.extend(file_nodes)
            file_text = "\n\n".join(n.get_content() for n in file_nodes)
            context_parts.append(f"=== Document: {fname} ===\n{file_text}")

    labeled_context = "\n\n".join(context_parts)
    sources = list({n.metadata.get("file_name", "unknown") for n in all_nodes})
    return all_nodes, labeled_context, sources


async def condense_question(question: str, history: list[HistoryEntry]) -> str:
    """Rewrite a follow-up question into a standalone question using chat history."""
    if not history:
        return question
    history_text = "\n".join(
        f"User: {h.question}\nAssistant: {h.answer}" for h in history[-5:]
    )
    prompt = (
        "Given the conversation below and a follow-up question, rewrite the follow-up "
        "as a fully standalone question that includes all necessary context from the history.\n"
        "Return ONLY the rewritten question — no explanation.\n\n"
        f"Conversation:\n{history_text}\n\n"
        f"Follow-up: {question}\n\n"
        "Standalone question:"
    )
    result = await Settings.llm.acomplete(prompt)
    record_tokens(result)
    condensed = str(result).strip()
    print(f"[condense] '{question}' → '{condensed}'")
    return condensed


@app.post("/ask")
async def ask(q: Question):
    # Session has no files linked
    if not q.files:
        raise HTTPException(400, "No documents in this chat. Upload a file to get started.")

    # Wait only for THIS session's files that are still indexing
    session_indexing = [f for f in q.files if indexing_status.get(f) == "indexing"]
    if session_indexing:
        print(f"[/ask] Waiting for {session_indexing} to finish indexing...")
        wait_timeout = 600
        elapsed = 0
        while any(indexing_status.get(f) == "indexing" for f in q.files):
            await asyncio.sleep(2)
            elapsed += 2
            if elapsed >= wait_timeout:
                raise HTTPException(504, "Indexing is taking too long. Please try again shortly.")
        print("[/ask] Indexing done — proceeding to answer.")

    if not index:
        raise HTTPException(400, "No documents indexed yet. Please upload a file first.")

    # Capture for generator closure
    question       = q.question
    history        = q.history
    question_files = q.files

    async def event_stream():
        try:
            # 1. Condense follow-up into standalone question for retrieval
            standalone = await condense_question(question, history)

            # 2. Retrieve relevant chunks — two modes:
            #    • Comparison: per-file balanced retrieval with labeled context
            #    • Standard:   unified hybrid (BM25 + vector) with cross-encoder rerank
            comparison_mode = is_comparison_query(question, len(question_files))

            if comparison_mode:
                chunks_per_file = max(2, SIMILARITY_TOP_K // len(question_files))
                print(f"[compare] {len(question_files)} files × {chunks_per_file} chunks each")
                nodes, context, sources = await retrieve_per_file(
                    standalone, question_files, chunks_per_file
                )
            else:
                candidates_k = SIMILARITY_TOP_K * 2 if reranker else SIMILARITY_TOP_K

                filters = MetadataFilters(
                    filters=[
                        MetadataFilter(key="file_name", value=fname, operator=FilterOperator.EQ)
                        for fname in question_files
                    ],
                    condition=FilterCondition.OR,
                )
                vector_retriever = index.as_retriever(
                    similarity_top_k=candidates_k, filters=filters
                )
                session_nodes = get_nodes_for_files(question_files)
                if session_nodes:
                    bm25_retriever = BM25Retriever.from_defaults(
                        nodes=session_nodes, similarity_top_k=candidates_k
                    )
                    retriever = QueryFusionRetriever(
                        [vector_retriever, bm25_retriever],
                        similarity_top_k=candidates_k,
                        num_queries=1,
                        mode="reciprocal_rerank",
                        use_async=True,
                    )
                else:
                    retriever = vector_retriever

                nodes = await retriever.aretrieve(standalone)

                if reranker and len(nodes) > 1:
                    _q, _k = standalone, SIMILARITY_TOP_K

                    def _rerank(nodes_in, q=_q, k=_k):
                        pairs  = [(q, n.get_content()) for n in nodes_in]
                        scores = reranker.predict(pairs)
                        ranked = sorted(zip(nodes_in, scores), key=lambda x: x[1], reverse=True)
                        return [n for n, _ in ranked[:k]]

                    loop  = asyncio.get_event_loop()
                    nodes = await loop.run_in_executor(None, _rerank, nodes)
                    print(f"[rerank] kept {len(nodes)}/{candidates_k} chunks")

                context = "\n\n".join(n.get_content() for n in nodes)
                sources = list({n.metadata.get("file_name", "unknown") for n in nodes})

            # 3. Build final prompt with history + context
            history_section = ""
            if history:
                history_lines = "\n".join(
                    f"User: {h.question}\nAssistant: {h.answer}" for h in history[-5:]
                )
                history_section = f"Conversation history:\n{history_lines}\n\n"

            if comparison_mode:
                system_instruction = (
                    "You are a document assistant. You have been given excerpts from multiple documents, "
                    "each clearly labeled with its filename. "
                    "Answer using ONLY the provided context. "
                    "When the question involves comparison, explicitly contrast the documents — "
                    "highlight agreements, differences, and anything unique to each. "
                    "If a document lacks relevant information, say so explicitly.\n\n"
                )
            else:
                system_instruction = (
                    "You are a document assistant. Answer using ONLY the provided context and conversation history.\n"
                    "Do not use any prior knowledge outside of these.\n"
                    "If the answer cannot be found, say: "
                    "'I don't have enough information in the provided documents to answer this.'\n\n"
                )

            final_prompt = (
                f"{system_instruction}"
                f"{history_section}"
                f"Context:\n---------------------\n{context}\n---------------------\n\n"
                f"Question: {question}\n\nAnswer:"
            )

            # 4. Stream character by character so the delay is uniform regardless
            #    of how many chars Ollama bundles into each chunk.
            STREAM_DELAY = float(os.getenv("STREAM_DELAY_MS", "20")) / 1000
            full_response = ""
            async for chunk in await Settings.llm.astream_complete(final_prompt):
                if chunk.delta:
                    full_response += chunk.delta
                    for char in chunk.delta:
                        yield f"data: {json.dumps({'type': 'token', 'content': char})}\n\n"
                        await asyncio.sleep(STREAM_DELAY)

            # 5. Approximate token count for streaming (no raw field available per chunk)
            token_usage["completion"] += len(full_response.split())
            token_usage["requests"]   += 1

            # 6. Send done event with sources + optional warning
            still_indexing = [f for f, s in indexing_status.items() if s == "indexing"]
            warning = (
                f"Still indexing: {', '.join(still_indexing)}. Results may be incomplete."
                if still_indexing else None
            )
            yield f"data: {json.dumps({'type': 'done', 'sources': sources, 'warning': warning, 'mode': 'comparison' if comparison_mode else 'standard'})}\n\n"

            # 7. RAG eval — LLM-as-judge (faithfulness + answer relevance)
            if ENABLE_EVAL and full_response.strip():
                try:
                    eval_ctx = context[:1500]
                    eval_ans = full_response[:800]

                    faith_prompt = (
                        "You are evaluating a RAG system response.\n\n"
                        f"Retrieved context:\n{eval_ctx}\n\n"
                        f"AI answer:\n{eval_ans}\n\n"
                        "Faithfulness: is every claim in the answer directly supported by the context above? "
                        "Penalise any statement not grounded in the context.\n"
                        "Reply with ONLY a decimal number from 0.0 (not faithful) to 1.0 (fully faithful)."
                    )
                    rel_prompt = (
                        "You are evaluating a RAG system response.\n\n"
                        f"User question: {question}\n\n"
                        f"AI answer:\n{eval_ans}\n\n"
                        "Answer relevance: does the answer directly and completely address the question?\n"
                        "Reply with ONLY a decimal number from 0.0 (irrelevant) to 1.0 (perfectly relevant)."
                    )

                    faith_result = await Settings.llm.acomplete(faith_prompt)
                    faith_score  = parse_eval_score(str(faith_result))

                    rel_result   = await Settings.llm.acomplete(rel_prompt)
                    rel_score    = parse_eval_score(str(rel_result))

                    print(f"[eval] faithfulness={faith_score}  relevance={rel_score}")
                    if faith_score is not None and rel_score is not None:
                        yield f"data: {json.dumps({'type': 'eval', 'faithfulness': faith_score, 'answer_relevance': rel_score})}\n\n"
                except Exception as eval_err:
                    print(f"[eval] error: {eval_err}")

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )
@app.delete("/documents/all")
def clear_all():
    global index, storage_context
    # clear ChromaDB
    chroma_client.delete_collection("rag_docs")
    global chroma_collection, vector_store
    chroma_collection = chroma_client.get_or_create_collection("rag_docs")
    vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
    
    # clear uploads folder
    for f in os.listdir(UPLOAD_DIR):
        try:
            os.remove(f"{UPLOAD_DIR}/{f}")
        except:
            pass
            
    storage_context = StorageContext.from_defaults(vector_store=vector_store)
    index = None
    indexing_status.clear()
    return {"message": "All documents cleared"}

@app.delete("/documents/{filename}")
async def delete_document(filename: str):
    # 1. delete physical file
    path = f"{UPLOAD_DIR}/{filename}"
    if os.path.exists(path):
        try:
            os.remove(path)
        except Exception as e:
            print(f"Failed to delete physical file {filename}: {e}")

    # 2. delete chunks from ChromaDB
    try:
        results = chroma_collection.get(
            where={"file_name": filename}
        )
        if results["ids"]:
            chroma_collection.delete(ids=results["ids"])
            print(f"Deleted {len(results['ids'])} chunks for {filename}")
    except Exception as e:
        print(f"ChromaDB delete error: {e}")

    # 3. rebuild index from remaining chunks
    global index, storage_context
    if chroma_collection.count() > 0:
        # Create a fresh storage context to clear in-memory node caches!
        storage_context = StorageContext.from_defaults(vector_store=vector_store)
        index = VectorStoreIndex.from_vector_store(
            vector_store,
            storage_context=storage_context
        )
    else:
        index = None

    # 4. clean status
    indexing_status.pop(filename, None)

    return {"deleted": filename}

@app.post("/eval")
async def run_eval(top_k: int = SIMILARITY_TOP_K):
    """
    Run the retrieval evaluation against eval_dataset.json.
    Returns per-question results, aggregate metrics, and a 3-way configuration
    comparison (Vector only / Hybrid / Hybrid + Reranker).
    """
    dataset_path = os.path.join(os.path.dirname(__file__), "..", "eval_dataset.json")
    if not os.path.exists(dataset_path):
        raise HTTPException(404, "eval_dataset.json not found in rag-backend/")

    with open(dataset_path, encoding="utf-8") as f:
        raw = json.load(f)

    questions = [
        q for q in raw
        if isinstance(q, dict)
        and q.get("id")
        and not str(q.get("id", "")).startswith("_")
        and (q.get("answer_keywords") or q.get("source_files"))
    ]

    if not questions:
        raise HTTPException(400, "No evaluable questions in eval_dataset.json")

    def _is_relevant(node, keywords, sources):
        chunk_file = node.metadata.get("file_name", "")
        chunk_text = node.get_content().lower()
        if sources and chunk_file.lower() not in [s.lower() for s in sources]:
            return False
        if keywords:
            return any(kw.lower() in chunk_text for kw in keywords)
        return bool(sources)

    def _agg(hits, mrrs, n):
        hr = sum(hits) / n
        return {"hit_rate": round(hr, 3), "mrr": round(sum(mrrs) / n, 3)}

    def _build_filters(source_files):
        return MetadataFilters(
            filters=[MetadataFilter(key="file_name", value=f, operator=FilterOperator.EQ)
                     for f in source_files],
            condition=FilterCondition.OR,
        )

    # ── Retrieval modes ────────────────────────────────────────────────────────

    async def _vec_only(question, source_files, k):
        """Pure vector similarity — no BM25, no reranker."""
        if not index: return []
        kwargs = {"similarity_top_k": k}
        if source_files:
            kwargs["filters"] = _build_filters(source_files)
        nodes = await index.as_retriever(**kwargs).aretrieve(question)
        return list(nodes)[:k]

    async def _hybrid(question, source_files, k):
        """Hybrid vector + BM25 fusion — no reranker."""
        if not index: return []
        if source_files:
            vec_ret    = index.as_retriever(similarity_top_k=k, filters=_build_filters(source_files))
            bm25_nodes = get_nodes_for_files(source_files)
        else:
            vec_ret    = index.as_retriever(similarity_top_k=k)
            bm25_nodes = []
        if bm25_nodes:
            bm25_ret  = BM25Retriever.from_defaults(nodes=bm25_nodes, similarity_top_k=k)
            retriever = QueryFusionRetriever([vec_ret, bm25_ret], similarity_top_k=k,
                                             num_queries=1, mode="reciprocal_rerank", use_async=True)
        else:
            retriever = vec_ret
        nodes = await retriever.aretrieve(question)
        return list(nodes)[:k]

    async def _full(question, source_files, k):
        """Hybrid + cross-encoder reranker (production pipeline)."""
        if not index: return []
        candidates = k * 2 if reranker else k
        if source_files:
            vec_ret    = index.as_retriever(similarity_top_k=candidates, filters=_build_filters(source_files))
            bm25_nodes = get_nodes_for_files(source_files)
        else:
            vec_ret    = index.as_retriever(similarity_top_k=candidates)
            bm25_nodes = []
        if bm25_nodes:
            bm25_ret  = BM25Retriever.from_defaults(nodes=bm25_nodes, similarity_top_k=candidates)
            retriever = QueryFusionRetriever([vec_ret, bm25_ret], similarity_top_k=candidates,
                                             num_queries=1, mode="reciprocal_rerank", use_async=True)
        else:
            retriever = vec_ret
        nodes = await retriever.aretrieve(question)
        if reranker and len(nodes) > 1:
            loop = asyncio.get_event_loop()
            def _rr(ns=list(nodes), q=question, top=k):
                pairs  = [(q, n.get_content()) for n in ns]
                scores = reranker.predict(pairs)
                ranked = sorted(zip(ns, scores), key=lambda x: x[1], reverse=True)
                return [n for n, _ in ranked[:top]]
            nodes = await loop.run_in_executor(None, _rr)
        return list(nodes)[:k]

    # ── Evaluate all questions across all 3 configs ───────────────────────────

    per_question = []
    vec_hits, vec_mrrs   = [], []
    hyb_hits, hyb_mrrs   = [], []
    full_hits, full_mrrs = [], []

    for q in questions:
        keywords = q.get("answer_keywords", [])
        sources  = q.get("source_files", [])
        text     = q["question"].strip()

        nv, nh, nf = (
            await _vec_only(text, sources, top_k),
            await _hybrid (text, sources, top_k),
            await _full   (text, sources, top_k),
        )

        def _metrics(nodes):
            pos = [i+1 for i, n in enumerate(nodes) if _is_relevant(n, keywords, sources)]
            return (bool(pos),
                    round(len(pos) / top_k, 3),
                    round(1.0 / min(pos), 3) if pos else 0.0,
                    min(pos) if pos else None)

        vh, vp, vm, _  = _metrics(nv)
        hh, hp, hm, _  = _metrics(nh)
        fh, fp, fm, fr = _metrics(nf)

        vec_hits.append(vh);  vec_mrrs.append(vm)
        hyb_hits.append(hh);  hyb_mrrs.append(hm)
        full_hits.append(fh); full_mrrs.append(fm)

        # Per-chunk detail from the production (full) pipeline
        retrieved = [
            {
                "file": n.metadata.get("file_name", "?"),
                "page": str(n.metadata.get("page_label",
                            n.metadata.get("page_number", "?"))),
                "hit" : _is_relevant(n, keywords, sources),
            }
            for n in nf
        ]

        per_question.append({
            "id"          : q["id"],
            "question"    : text,
            "source_files": sources,
            "hit"         : fh,
            "precision"   : fp,
            "mrr"         : fm,
            "first_rank"  : fr,
            "retrieved"   : retrieved,
        })

    n = len(per_question)
    full_hr  = sum(full_hits) / n
    full_prec = sum(r["precision"] for r in per_question) / n
    full_mrr  = sum(r["mrr"]       for r in per_question) / n

    return {
        "top_k"          : top_k,
        "n_questions"    : n,
        "hit_rate"       : round(full_hr,   3),
        "precision"      : round(full_prec, 3),
        "recall"         : round(full_hr,   3),
        "mrr"            : round(full_mrr,  3),
        "configurations" : [
            {"name": "Vector only",        **_agg(vec_hits,  vec_mrrs,  n)},
            {"name": "Hybrid",             **_agg(hyb_hits,  hyb_mrrs,  n)},
            {"name": "Hybrid + Reranker",  **_agg(full_hits, full_mrrs, n)},
        ],
        "per_question"   : per_question,
    }


@app.post("/cancel/{filename}")
def cancel_indexing(filename: str):
    if indexing_status.get(filename) == "indexing":
        cancelled_files.add(filename)
        return {"message": f"Cancellation requested for {filename}"}
    return {"message": f"{filename} is not currently indexing"}