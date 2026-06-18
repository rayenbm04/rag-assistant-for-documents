#!/usr/bin/env python3
"""
Quick utility: dump all stored chunks for a given filename from ChromaDB.

Usage (in activated venv):
  python dump_chunks.py affiche_liverable.png
  python dump_chunks.py --list          # show all indexed files
"""
import sys, os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

CHROMA_DIR = os.getenv("CHROMA_DIR", "./chroma_db")
COLLECTION  = os.getenv("COLLECTION_NAME", "rag_docs")

try:
    import chromadb
except ImportError:
    sys.exit("chromadb not installed — run: pip install chromadb")

client     = chromadb.PersistentClient(path=CHROMA_DIR)
collection = client.get_or_create_collection(COLLECTION)

if "--list" in sys.argv:
    all_meta = collection.get(include=["metadatas"])["metadatas"]
    files = sorted({m.get("file_name", "?") for m in all_meta})
    print(f"\nIndexed files ({len(files)}):")
    for f in files:
        print(f"  {f}")
    sys.exit(0)

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)

target = sys.argv[1].lower()
result = collection.get(include=["documents", "metadatas"])
docs   = result["documents"]
metas  = result["metadatas"]

hits = [(d, m) for d, m in zip(docs, metas)
        if m.get("file_name", "").lower() == target]

if not hits:
    print(f"No chunks found for '{target}'")
    print("Run with --list to see all indexed files.")
    sys.exit(1)

print(f"\n{'='*70}")
print(f"Chunks for: {target}  ({len(hits)} chunk(s))")
print('='*70)
for i, (doc, meta) in enumerate(hits, 1):
    page = meta.get("page_label", meta.get("page_number", "?"))
    print(f"\n--- Chunk {i}  (page {page}) ---")
    print(doc)
    print()
