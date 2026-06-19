import os, shutil, base64, asyncio, hashlib, json, re, uuid
from datetime import datetime, timedelta
import nest_asyncio
  # allows AutoMergingRetriever to run inside FastAPI's event loop
import pdfplumber
from PIL import Image
from docx import Document as DocxDocument
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from dotenv import load_dotenv
# ── Auth ──
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import create_engine, Column, String, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
import chromadb
import ollama
from llama_index.core import VectorStoreIndex, Settings, Document, PromptTemplate
from llama_index.core.vector_stores.types import MetadataFilters, MetadataFilter, FilterOperator, FilterCondition
from llama_index.core.retrievers import QueryFusionRetriever
from llama_index.core.schema import TextNode
from llama_index.retrievers.bm25 import BM25Retriever
from llama_index.core.storage.storage_context import StorageContext

# Parent-child retrieval — graceful fallback if not available in this build
try:
    from llama_index.core.retrievers import AutoMergingRetriever
    from llama_index.core.node_parser import HierarchicalNodeParser, get_leaf_nodes
    from llama_index.core.storage.docstore import SimpleDocumentStore
    PARENT_CHILD_AVAILABLE = True
except ImportError as _pc_err:
    print(f"[warn] Parent-child retrieval not available ({_pc_err}) — using flat chunking")
    PARENT_CHILD_AVAILABLE = False
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
ENABLE_EVAL        = os.getenv("ENABLE_EVAL",          "true").lower() == "true"
ENABLE_RERANK      = os.getenv("ENABLE_RERANK",        "true").lower() == "true"
RERANK_MODEL       = os.getenv("RERANK_MODEL",         "cross-encoder/ms-marco-MiniLM-L-6-v2")
PARENT_CHUNK_SIZE  = int(os.getenv("PARENT_CHUNK_SIZE", "512"))
CHILD_CHUNK_SIZE   = int(os.getenv("CHILD_CHUNK_SIZE",  "128"))
NODE_STORE_DIR     = os.getenv("NODE_STORE_DIR",        "./node_store")
SECRET_KEY             = os.getenv("SECRET_KEY",             "change-me-in-production")
ACCESS_TOKEN_EXPIRE_DAYS = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS", "7"))
DATABASE_URL           = os.getenv("DATABASE_URL",           "sqlite:///./rag_users.db")

# ── SQLAlchemy / User DB ──────────────────────────────────────────────────────
_engine      = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
_SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)
_Base        = declarative_base()

class UserModel(_Base):
    __tablename__ = "users"
    id              = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email           = Column(String, unique=True, index=True, nullable=False)
    firstname       = Column(String, nullable=False)
    lastname        = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    role            = Column(String, default="user")   # "admin" | "user"
    created_at      = Column(DateTime, default=datetime.utcnow)

_Base.metadata.create_all(bind=_engine)

# ── JWT / password utils ──────────────────────────────────────────────────────
_pwd_ctx      = CryptContext(schemes=["bcrypt"], deprecated="auto")
_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def _hash_pw(pw: str) -> str:           return _pwd_ctx.hash(pw)
def _verify_pw(plain: str, h: str) -> bool: return _pwd_ctx.verify(plain, h)

def _make_token(user: UserModel) -> str:
    expire = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    return jwt.encode(
        {"sub": user.id, "email": user.email, "role": user.role, "exp": expire},
        SECRET_KEY, algorithm="HS256",
    )

def _db_session():
    db = _SessionLocal()
    try:
        yield db
    finally:
        db.close()

async def get_current_user(token: str = Depends(_oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        user_id: str = payload.get("sub")
        if not user_id:
            raise HTTPException(401, "Invalid token")
    except JWTError:
        raise HTTPException(401, "Invalid token")
    db = _SessionLocal()
    try:
        user = db.query(UserModel).filter(UserModel.id == user_id).first()
    finally:
        db.close()
    if not user:
        raise HTTPException(401, "User not found")
    return user

def _require_admin(current_user: UserModel = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(403, "Admin access required")
    return current_user

# ── File-ownership persistence ────────────────────────────────────────────────
_FILE_OWNERS_PATH = "./file_owners.json"

def _load_file_owners() -> dict:
    if os.path.exists(_FILE_OWNERS_PATH):
        with open(_FILE_OWNERS_PATH) as f:
            return json.load(f)
    return {}

def _save_file_owners():
    with open(_FILE_OWNERS_PATH, "w") as f:
        json.dump(file_owners, f)

file_owners: dict[str, str] = _load_file_owners()   # {filename: user_id}

# ── Pydantic auth schemas ─────────────────────────────────────────────────────
class RegisterRequest(BaseModel):
    email: str
    password: str
    firstname: str
    lastname: str

class LoginRequest(BaseModel):
    email: str
    password: str


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

os.makedirs(UPLOAD_DIR,    exist_ok=True)
os.makedirs(NODE_STORE_DIR, exist_ok=True)

# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/auth/register")
def auth_register(req: RegisterRequest):
    db = _SessionLocal()
    try:
        if db.query(UserModel).filter(UserModel.email == req.email).first():
            raise HTTPException(400, "Email already registered")
        if len(req.password) < 6:
            raise HTTPException(400, "Password must be at least 6 characters")
        is_first = db.query(UserModel).count() == 0   # first user → admin
        user = UserModel(
            id=str(uuid.uuid4()),
            email=req.email,
            firstname=req.firstname,
            lastname=req.lastname,
            hashed_password=_hash_pw(req.password),
            role="admin" if is_first else "user",
        )
        db.add(user); db.commit(); db.refresh(user)
    finally:
        db.close()
    token = _make_token(user)
    return {"access_token": token, "token_type": "bearer",
            "user": {"id": user.id, "email": user.email, "firstname": user.firstname, "lastname": user.lastname, "role": user.role}}

@app.post("/auth/login")
def auth_login(req: LoginRequest):
    db = _SessionLocal()
    try:
        user = db.query(UserModel).filter(UserModel.email == req.email).first()
    finally:
        db.close()
    if not user or not _verify_pw(req.password, user.hashed_password):
        raise HTTPException(401, "Invalid email or password")
    token = _make_token(user)
    return {"access_token": token, "token_type": "bearer",
            "user": {"id": user.id, "email": user.email, "firstname": user.firstname, "lastname": user.lastname, "role": user.role}}

@app.get("/auth/me")
def auth_me(current_user: UserModel = Depends(get_current_user)):
    return {"id": current_user.id, "email": current_user.email, "firstname": current_user.firstname, "lastname": current_user.lastname, "role": current_user.role}

@app.get("/auth/users")
def auth_list_users(current_user: UserModel = Depends(_require_admin)):
    db = _SessionLocal()
    try:
        users = db.query(UserModel).all()
        return [{"id": u.id, "email": u.email, "firstname": u.firstname, "lastname": u.lastname, "role": u.role,
                 "created_at": u.created_at.isoformat()} for u in users]
    finally:
        db.close()

@app.patch("/auth/users/{user_id}/role")
def auth_set_role(user_id: str, body: dict,
                  current_user: UserModel = Depends(_require_admin)):
    new_role = body.get("role")
    if new_role not in ("admin", "user"):
        raise HTTPException(400, "role must be 'admin' or 'user'")
    db = _SessionLocal()
    try:
        user = db.query(UserModel).filter(UserModel.id == user_id).first()
        if not user:
            raise HTTPException(404, "User not found")
        user.role = new_role; db.commit()
        return {"id": user.id, "email": user.email, "role": user.role}
    finally:
        db.close()

# ── ChromaDB (vector store) ──
chroma_client     = chromadb.PersistentClient(path=CHROMA_DIR)
chroma_collection = chroma_client.get_or_create_collection("rag_docs")
vector_store      = ChromaVectorStore(chroma_collection=chroma_collection)

# ── Node docstore (parent chunks for AutoMergingRetriever) ──
_ds_path = os.path.join(NODE_STORE_DIR, "docstore.json")
if PARENT_CHILD_AVAILABLE:
    if os.path.exists(_ds_path):
        docstore = SimpleDocumentStore.from_persist_path(_ds_path)
        print(f"Loaded docstore: {len(docstore.docs)} nodes")
    else:
        docstore = SimpleDocumentStore()
        print("Created fresh docstore")
else:
    docstore = None

def _persist_docstore():
    if docstore is not None:
        docstore.persist(persist_path=_ds_path)

storage_context = StorageContext.from_defaults(
    vector_store=vector_store,
    **({"docstore": docstore} if docstore is not None else {}),
)

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


def analyze_image_with_llava(image_b64, context_hint="", doc_mode=False):
    """Send image to LLaVA and extract ALL content useful for Q&A.

    doc_mode=True  → optimised for scanned documents / invoices / tables:
                     verbatim transcription, every table row, all numbers.
    doc_mode=False → optimised for photos / diagrams / screenshots:
                     visual description, colours, structure, purpose.
    """
    if doc_mode:
        prompt = f"""You are a document transcription assistant. Your job is to extract every piece of information from this scanned document page so it can be searched and queried later.

{"Context: " + context_hint if context_hint else ""}

Follow these rules strictly:

1. TRANSCRIBE ALL TEXT verbatim, exactly as it appears — names, dates, addresses, reference numbers, totals. Do not paraphrase.

2. FOR EVERY TABLE, reproduce it completely row by row:
   - Write each row on its own line.
   - Separate columns with " | ".
   - Include the header row first.
   - Count and state the total number of data rows at the end.
   Example:
   CODE | DESCRIPTION | QTY | UNIT PRICE | TOTAL
   A001 | Widget X    | 10  | 5.00       | 50.00
   A002 | Widget Y    | 3   | 12.00      | 36.00
   Total rows: 2

3. LIST ALL NUMBERS AND AMOUNTS exactly as shown: quantities, unit prices, subtotals, taxes, grand totals.

4. STATE KEY FIELDS explicitly:
   - Supplier / vendor name
   - Client / buyer name
   - Document date and reference number
   - Currency and payment terms (if visible)

5. If text is partially illegible, write [illegible] in that spot — do not guess.

Be exhaustive. This transcription is the ONLY source of information for answering user questions about this document."""
    else:
        prompt = f"""You are a document analysis assistant. Analyze this image completely and extract ALL useful information.

{"Context: " + context_hint if context_hint else ""}

Follow these steps in order:

STEP 1 — TEXT: Copy ALL visible text exactly as written, word for word.

STEP 2 — COLORS: For every distinct element, state its exact color (use specific names: teal, coral, amber, etc.).

STEP 3 — STRUCTURE: Describe the layout and what each element represents.

STEP 4 — TYPE-SPECIFIC details:
- UML diagram: list all classes/actors, attributes, methods, relationships
- Architecture diagram: every component, connection, data flow
- Table: reproduce all rows and columns
- Chart/graph: describe axes, values, legend, each data series and its color
- Screenshot: all visible UI elements, buttons, text, data
- Photo: describe people, setting, actions, notable details
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
                    page_image = page.to_image(resolution=300).original
                    image_b64 = pil_image_to_base64(page_image)
                    visual = analyze_image_with_llava(
                        image_b64,
                        context_hint=f"Page {page_num}/{total_pages} of PDF '{filename}'",
                        doc_mode=True,
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

    # ── Pass 1: collect table summaries for the document header ──
    table_summaries = []
    table_blocks = []
    for i, table in enumerate(doc.tables):
        rows = []
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            line = " | ".join(c for c in cells if c)
            if line:
                rows.append(line)
        if not rows:
            continue
        first_cell = table.rows[0].cells[0].text.strip() if table.rows else ""
        has_header = first_cell and not first_cell.replace(",", "").replace(".", "").isdigit()
        data_rows = len(rows) - 1 if has_header else len(rows)
        table_summaries.append(f"  Table {i + 1}: {data_rows} data row(s)")
        table_blocks.append((i + 1, data_rows, rows))

    # ── Document header with table summary (stays in its own chunk) ──
    # Only count tables with 2+ data rows as "real" data tables; single-row
    # tables are usually layout/header artefacts in Word documents.
    real_tables = [(t_num, dr, rows) for t_num, dr, rows in table_blocks if dr >= 2]
    total_items = sum(dr for _, dr, _ in real_tables)

    header = f"Document: {filename}\n"
    if table_blocks:
        if real_tables:
            header += f"This document contains {len(real_tables)} data table(s) with {total_items} item(s) in total.\n"
        header += "Table breakdown:\n" + "\n".join(table_summaries) + "\n"

    parts = [header]

    # ── Pass 2: paragraphs ──
    for para in doc.paragraphs:
        if para.text.strip():
            parts.append(para.text)

    # ── Pass 3: full table content ──
    for t_num, data_rows, rows in table_blocks:
        parts.append(f"\n[Table {t_num}] — {data_rows} data row(s)")
        parts.extend(rows)

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
            sheet_rows = []
            for row in ws.iter_rows(values_only=True):
                line = _row_to_str(list(row))
                if line:
                    sheet_rows.append(line)
            if not sheet_rows:
                continue
            data_rows = len(sheet_rows) - 1 if len(sheet_rows) > 1 else len(sheet_rows)
            parts.append(f"\n[Sheet: {sheet_name}] — {data_rows} data row(s)")
            parts.extend(sheet_rows)
    else:
        for i in range(_xlrd_wb.nsheets):
            ws = _xlrd_wb.sheet_by_index(i)
            sheet_rows = []
            for rx in range(ws.nrows):
                cells = [ws.cell_value(rx, cx) for cx in range(ws.ncols)]
                line = _row_to_str(cells)
                if line:
                    sheet_rows.append(line)
            if not sheet_rows:
                continue
            data_rows = len(sheet_rows) - 1 if len(sheet_rows) > 1 else len(sheet_rows)
            parts.append(f"\n[Sheet: {ws.name}] — {data_rows} data row(s)")
            parts.extend(sheet_rows)

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

        if PARENT_CHILD_AVAILABLE:
            # ── Parent-child chunking ──────────────────────────────────────────
            # Two levels: parent (~512 tokens, in docstore) + leaf (~128 tokens,
            # in ChromaDB). AutoMergingRetriever promotes siblings to parent at
            # query time → LLM gets richer context, retrieval stays precise.

            # Remove stale docstore nodes for this file before re-indexing so
            # ChromaDB and the docstore never reference each other's old IDs.
            old_node_ids = [
                nid for nid, node in storage_context.docstore.docs.items()
                if node.metadata.get("file_name") == filename
            ]
            for nid in old_node_ids:
                try:
                    storage_context.docstore.delete_document(nid)
                except Exception:
                    pass
            if old_node_ids:
                print(f"Removed {len(old_node_ids)} stale docstore nodes for {filename}")

            parser     = HierarchicalNodeParser.from_defaults(
                chunk_sizes=[PARENT_CHUNK_SIZE, CHILD_CHUNK_SIZE]
            )
            all_nodes  = parser.get_nodes_from_documents([doc])
            leaf_nodes = get_leaf_nodes(all_nodes)

            for node in all_nodes:
                node.metadata.setdefault("file_name", filename)
                node.metadata.setdefault("doc_type",  doc_type)

            storage_context.docstore.add_documents(all_nodes)
            _persist_docstore()

            if index is None:
                index = VectorStoreIndex(
                    leaf_nodes, storage_context=storage_context, show_progress=False
                )
            else:
                index.insert_nodes(leaf_nodes)
        else:
            # ── Flat chunking fallback ─────────────────────────────────────────
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
async def upload(file: UploadFile = File(...),
                 current_user: UserModel = Depends(get_current_user)):
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
        # Re-claim ownership (user may have refreshed after backend restart)
        file_owners[file.filename] = current_user.id
        _save_file_owners()
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

    file_owners[file.filename] = current_user.id
    _save_file_owners()
    file_hashes[file.filename] = incoming_hash
    indexing_status[file.filename] = "indexing"
    loop = asyncio.get_event_loop()
    loop.run_in_executor(executor, add_document_to_index, path, file.filename)

    return {"id": file.filename, "name": file.filename, "status": "indexing"}

@app.get("/status/{filename}")
def get_status(filename: str,
               current_user: UserModel = Depends(get_current_user)):
    """
    Poll this endpoint to know when a file is ready.
    Returns: indexing | ready | error | unknown
    """
    status   = indexing_status.get(filename, "unknown")
    progress = indexing_progress.get(filename)  # {"current": int, "total": int} or None
    return {"filename": filename, "status": status, "progress": progress}


@app.get("/documents")
def list_documents(current_user: UserModel = Depends(get_current_user)):
    all_files = [f for f in os.listdir(UPLOAD_DIR) if not f.startswith('.')]
    # Admins see everything; regular users see only their own files
    if current_user.role != "admin":
        all_files = [f for f in all_files
                     if file_owners.get(f) == current_user.id]
    return [
        {"id": f, "name": f, "status": indexing_status.get(f, "ready"),
         "owner": file_owners.get(f)}
        for f in all_files
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
def serve_file(filename: str,
               current_user: UserModel = Depends(get_current_user)):
    # Users can only access their own files; admins access all
    if current_user.role != "admin" and file_owners.get(filename) != current_user.id:
        raise HTTPException(403, "Access denied")
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
                use_async=False,
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
async def ask(q: Question,
              current_user: UserModel = Depends(get_current_user)):
    # Session has no files linked
    if not q.files:
        raise HTTPException(400, "No documents in this chat. Upload a file to get started.")

    # Check file ownership — users can only query their own files
    if current_user.role != "admin":
        forbidden = [f for f in q.files if file_owners.get(f) != current_user.id]
        if forbidden:
            raise HTTPException(403, f"Access denied to: {', '.join(forbidden)}")

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

    def build_citations(nodes: list) -> list[dict]:
        """
        Build structured citations from retrieved nodes.
        Scans each chunk's text for 'Page X/Y' markers (embedded by extract_pdf_content)
        and groups page numbers by filename.
        Returns: [{"file": "foo.pdf", "pages": [1, 3]}, ...]
        Images/docx/txt have no page markers → pages list is empty.
        """
        _page_re = re.compile(r'Page\s+(\d+)/\d+', re.IGNORECASE)
        file_pages: dict[str, set] = {}
        for node in nodes:
            fname = node.metadata.get("file_name", "unknown")
            pages_found = {int(p) for p in _page_re.findall(node.get_content())}
            if fname not in file_pages:
                file_pages[fname] = set()
            file_pages[fname].update(pages_found)
        return [
            {"file": fname, "pages": sorted(pgs)}
            for fname, pgs in file_pages.items()
        ]

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
                        use_async=False,
                    )
                else:
                    retriever = vector_retriever

                if PARENT_CHILD_AVAILABLE:
                    retriever = AutoMergingRetriever(retriever, storage_context, verbose=False)
                try:
                    nodes = await retriever.aretrieve(standalone)
                except Exception as _merge_err:
                    # If AutoMergingRetriever can't find a parent node (stale docstore),
                    # fall back to the raw vector retriever for this query.
                    print(f"[warn] AutoMergingRetriever failed ({_merge_err}), using leaf nodes")
                    nodes = await vector_retriever.aretrieve(standalone)

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
                    "Important rules:\n"
                    "- Image files have already been analysed by a vision model. Their full description is in the context. "
                    "Do NOT ask the user to provide an image — all visual content is already available to you as text.\n"
                    "- Tables and row data are in the context as pipe-separated lines. Count or sum them directly from the text.\n"
                    "- If the answer cannot be found in the context, say exactly: "
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
            citations = build_citations(nodes)
            yield f"data: {json.dumps({'type': 'done', 'sources': sources, 'citations': citations, 'warning': warning, 'mode': 'comparison' if comparison_mode else 'standard'})}\n\n"

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
            
    if PARENT_CHILD_AVAILABLE:
        docstore = SimpleDocumentStore()

        _ds_path = os.path.join(
        NODE_STORE_DIR,
        "docstore.json"
        )

        docstore.persist(persist_path=_ds_path)

        storage_context = StorageContext.from_defaults(
        vector_store=vector_store,
        docstore=docstore,
    )
    else:
        storage_context = StorageContext.from_defaults(
        vector_store=vector_store
    )
    index = None
    indexing_status.clear()
    return {"message": "All documents cleared"}

@app.delete("/documents/{filename}")
async def delete_document(filename: str,
                          current_user: UserModel = Depends(get_current_user)):
    # Only owner or admin can delete
    if current_user.role != "admin" and file_owners.get(filename) != current_user.id:
        raise HTTPException(403, "Access denied")
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
        if PARENT_CHILD_AVAILABLE:
            docstore = SimpleDocumentStore()

            _ds_path = os.path.join(
            NODE_STORE_DIR,
            "docstore.json"
            )

            docstore.persist(persist_path=_ds_path)

            storage_context = StorageContext.from_defaults(
            vector_store=vector_store,
            docstore=docstore,
            )
        else:
            storage_context = StorageContext.from_defaults(
            vector_store=vector_store
            )
            index = VectorStoreIndex.from_vector_store(
            vector_store,
            storage_context=storage_context
            )
    else:
        index = None

    # 4. clean status + ownership
    indexing_status.pop(filename, None)
    file_owners.pop(filename, None)
    _save_file_owners()

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
                                             num_queries=1, mode="reciprocal_rerank", use_async=False)
        else:
            retriever = vec_ret
        nodes = await retriever.aretrieve(question)
        return list(nodes)[:k]

    async def _full(question, source_files, k):
        """Hybrid + AutoMerging + cross-encoder reranker (production pipeline)."""
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
                                             num_queries=1, mode="reciprocal_rerank", use_async=False)
        else:
            retriever = vec_ret
        if PARENT_CHILD_AVAILABLE:
            try:
                retriever = AutoMergingRetriever(
                retriever,
                storage_context,
                verbose=False
                )
            except Exception as e:
                print(f"AutoMerging disabled: {e}")
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
