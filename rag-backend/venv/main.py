import os, shutil, base64, asyncio, hashlib
import pdfplumber
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import chromadb
import ollama
from llama_index.core import VectorStoreIndex, Settings, Document, PromptTemplate
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

class Question(BaseModel):
    question: str

cancelled_files = set()   # filenames that should stop indexing

Settings.llm = Ollama(model=LLM_MODEL, request_timeout=120.0, additional_kwargs={"num_gpu": 99})
Settings.embed_model = OllamaEmbedding(model_name=EMBED_MODEL, ollama_additional_kwargs={"num_gpu": 99})

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
file_hashes = {}            # {"filename": md5_hex} — used to skip re-indexing unchanged files
executor = ThreadPoolExecutor(max_workers=2)

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


def extract_pdf_content(file_path, filename):
    full_content = f"Document: {filename}\n\n"

    with pdfplumber.open(file_path) as pdf:
        total_pages = len(pdf.pages)
        print(f"Processing PDF: {filename} ({total_pages} pages)")

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


def add_document_to_index(file_path, filename):
    global index
    try:
        indexing_status[filename] = "indexing"
        extension = filename.lower().split('.')[-1]

        if extension == 'pdf':
            text = extract_pdf_content(file_path, filename)
            doc_type = "pdf"
        elif extension in ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']:
            if filename in cancelled_files:
                raise InterruptedError("Cancelled by user")
            text = extract_image_content(file_path, filename)
            doc_type = "image"
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
        cancelled_files.discard(filename)
        print(f"Ready: {filename} ({doc_type}, {len(text)} chars)")

    except InterruptedError:
        indexing_status[filename] = "cancelled"
        cancelled_files.discard(filename)
        # delete the physical file since indexing was cancelled
        if os.path.exists(file_path):
            os.remove(file_path)
        print(f"Cancelled and cleaned: {filename}")

    except Exception as e:
        indexing_status[filename] = "error"
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
    status = indexing_status.get(filename, "unknown")
    return {"filename": filename, "status": status}


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


STRICT_QA_PROMPT = PromptTemplate(
    "You are a document assistant. Answer the question using ONLY the context provided below.\n"
    "Do NOT use any prior knowledge or information outside of this context.\n"
    "If the answer cannot be found in the context, say exactly: "
    "'I don't have enough information in the provided documents to answer this.'\n\n"
    "Context:\n"
    "---------------------\n"
    "{context_str}\n"
    "---------------------\n\n"
    "Question: {query_str}\n\n"
    "Answer:"
)

@app.get("/files/{filename}")
def serve_file(filename: str):
    path = f"{UPLOAD_DIR}/{filename}"
    if not os.path.exists(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path)


@app.post("/ask")
async def ask(q: Question):
    # check both index AND that files actually exist
    files_exist = len([f for f in os.listdir(UPLOAD_DIR) if not f.startswith('.')]) > 0

    if not index or not files_exist:
        raise HTTPException(400, "No documents uploaded yet. Please upload a file first.")

    engine = index.as_query_engine(
        similarity_top_k=SIMILARITY_TOP_K,
        text_qa_template=STRICT_QA_PROMPT,
    )
    response = await engine.aquery(q.question)

    sources = list({
        node.metadata.get("file_name", "unknown")
        for node in response.source_nodes
    })

    result = {
        "answer": str(response),
        "sources": sources
    }

    still_indexing = [f for f, s in indexing_status.items() if s == "indexing"]
    if still_indexing:
        result["warning"] = f"Still indexing: {', '.join(still_indexing)}. Results may be incomplete."

    return result
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

@app.post("/cancel/{filename}")
def cancel_indexing(filename: str):
    if indexing_status.get(filename) == "indexing":
        cancelled_files.add(filename)
        return {"message": f"Cancellation requested for {filename}"}
    return {"message": f"{filename} is not currently indexing"}