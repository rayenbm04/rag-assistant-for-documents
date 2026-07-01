#!/usr/bin/env python3
"""
Retrieval evaluation for the RAG assistant.

Measures how well the pipeline retrieves the right chunks BEFORE the LLM
sees them — independently of answer quality (which the LLM-as-judge covers).

Metrics (per question, then averaged):
  Hit Rate@K   — did at least one relevant chunk appear in the top K?  (0 or 1)
  Precision@K  — what fraction of the top-K chunks were relevant?
  Recall@K     — what fraction of all relevant chunks were retrieved?
                 (simplified: treated as Hit Rate since we assume 1 relevant
                  chunk per question)
  MRR@K        — 1 / rank of the first relevant chunk (0 if none found)

A chunk is "relevant" if:
  • its source file matches one of the question's source_files (when specified), AND
  • its text contains at least one of the answer_keywords (when specified)

Usage:
  cd rag-backend
  venv\\Scripts\\activate
  python eval.py                          # uses eval_dataset.json in this directory
  python eval.py --dataset path/to.json
  python eval.py --top-k 6
"""

import json, asyncio, argparse, sys, os
from pathlib import Path

# Load .env so CHROMA_DIR, OLLAMA_BASE_URL, etc. are available
from dotenv import load_dotenv
load_dotenv()

# Import the shared retrieval infrastructure from main.py.
# This triggers ChromaDB connection, index load, and reranker init on import.
sys.path.insert(0, str(Path(__file__).parent / "venv"))
from main import (
    index, reranker, get_nodes_for_files,
    MetadataFilters, MetadataFilter, FilterOperator, FilterCondition,
    BM25Retriever, QueryFusionRetriever,
    SIMILARITY_TOP_K,
)


# ── Relevance check ──────────────────────────────────────────────────────────

def is_relevant(node, answer_keywords: list[str], source_files: list[str]) -> bool:
    """Return True if the node counts as a correct retrieval for this question."""
    chunk_file = node.metadata.get("file_name", "")
    chunk_text = node.get_content().lower()

    # Must come from one of the expected source files (case-insensitive)
    if source_files and chunk_file.lower() not in [s.lower() for s in source_files]:
        return False

    # Must contain at least one answer keyword (when specified)
    if answer_keywords:
        return any(kw.lower() in chunk_text for kw in answer_keywords)

    # source_files matched and no keyword constraint — file match is sufficient
    return bool(source_files)


# ── Retrieval (mirrors /ask logic exactly) ───────────────────────────────────

async def retrieve(question: str, source_files: list[str], top_k: int) -> list:
    """Run hybrid retrieval + reranking, scoped to source_files when provided."""
    if not index:
        print("  [!] No index loaded — have you indexed documents yet?")
        return []

    candidates_k = top_k * 2 if reranker else top_k

    if source_files:
        filters = MetadataFilters(
            filters=[
                MetadataFilter(key="file_name", value=f, operator=FilterOperator.EQ)
                for f in source_files
            ],
            condition=FilterCondition.OR,
        )
        vec_ret = index.as_retriever(similarity_top_k=candidates_k, filters=filters)
        bm25_source_nodes = get_nodes_for_files(source_files)
    else:
        vec_ret = index.as_retriever(similarity_top_k=candidates_k)
        bm25_source_nodes = []

    if bm25_source_nodes:
        bm25_ret = BM25Retriever.from_defaults(
            nodes=bm25_source_nodes, similarity_top_k=candidates_k
        )
        retriever = QueryFusionRetriever(
            [vec_ret, bm25_ret],
            similarity_top_k=candidates_k,
            num_queries=1,
            mode="reciprocal_rerank",
            use_async=True,
        )
    else:
        retriever = vec_ret

    nodes = await retriever.aretrieve(question)

    # Apply cross-encoder reranker if available
    if reranker and len(nodes) > 1:
        loop = asyncio.get_event_loop()
        q, k = question, top_k

        def _rerank(ns=list(nodes), q=q, k=k):
            pairs  = [(q, n.get_content()) for n in ns]
            scores = reranker.predict(pairs)
            ranked = sorted(zip(ns, scores), key=lambda x: x[1], reverse=True)
            return [n for n, _ in ranked[:k]]

        nodes = await loop.run_in_executor(None, _rerank)

    return list(nodes)[:top_k]


# ── Metrics ──────────────────────────────────────────────────────────────────

def compute_question_metrics(nodes: list, answer_keywords: list[str],
                              source_files: list[str], top_k: int) -> dict:
    relevant_positions = [
        i + 1  # 1-indexed
        for i, node in enumerate(nodes)
        if is_relevant(node, answer_keywords, source_files)
    ]
    hit       = len(relevant_positions) > 0
    precision = len(relevant_positions) / top_k if top_k else 0.0
    mrr       = (1.0 / min(relevant_positions)) if relevant_positions else 0.0
    return {"hit": hit, "precision": precision, "mrr": mrr,
            "relevant_positions": relevant_positions}


# ── Main evaluation loop ─────────────────────────────────────────────────────

async def evaluate(dataset_path: str, top_k: int, debug: bool = False, file_filter: set = None) -> dict:
    with open(dataset_path, encoding="utf-8") as f:
        raw = json.load(f)

    # Keep only proper Q&A entries (skip comment/template entries)
    questions = [
        q for q in raw
        if isinstance(q, dict)
        and q.get("id")
        and not q["id"].startswith("_")
        and "_SKIP" not in q["id"]
        and (q.get("answer_keywords") or q.get("source_files"))
    ]

    if file_filter:
        questions = [q for q in questions if any(f in file_filter for f in q.get("source_files", []))]

    if not questions:
        print("No evaluable questions found.")
        print("Questions need an 'id' plus 'answer_keywords' or 'source_files'.")
        return {}

    print(f"\nEvaluating {len(questions)} questions  (top_k={top_k})\n")
    col = f"{'ID':<22} {'Hit':>4} {'P@K':>5} {'MRR':>5}  Source keywords"
    print(col)
    print("─" * 72)

    results = []
    for q in questions:
        qid      = q["id"]
        question = q["question"].strip()
        keywords = q.get("answer_keywords", [])
        sources  = q.get("source_files", [])

        nodes   = await retrieve(question, sources, top_k)
        metrics = compute_question_metrics(nodes, keywords, sources, top_k)

        kw_preview = (", ".join(f'"{k}"' for k in keywords[:2])
                      if keywords else f"file: {sources[0] if sources else '?'}")
        hit_sym = "✓" if metrics["hit"] else "✗"
        print(f"{qid:<22} {hit_sym:>4} {metrics['precision']:>5.2f} {metrics['mrr']:>5.2f}  {kw_preview}")

        # --debug: print retrieved chunks for misses so keywords can be corrected
        if debug and not metrics["hit"]:
            print(f"\n  ── DEBUG: retrieved chunks for '{qid}' ──")
            for i, node in enumerate(nodes):
                fname   = node.metadata.get("file_name", "?")
                snippet = node.get_content().replace("\n", " ")[:1200]
                print(f"  [{i+1}] {fname}: {snippet}…")
            print()

        results.append({"id": qid, **metrics})

    # ── Aggregate ────────────────────────────────────────────────────────────
    n        = len(results)
    hit_rate = sum(r["hit"]       for r in results) / n
    prec     = sum(r["precision"] for r in results) / n
    mrr      = sum(r["mrr"]       for r in results) / n
    # Recall@K ≈ Hit Rate (assumes 1 relevant chunk per question)
    recall   = hit_rate

    print("─" * 72)
    print(f"\n  Questions evaluated : {n}")
    print(f"  Hit Rate @ {top_k:<2}      : {hit_rate:.3f}  ({hit_rate * 100:.1f}%)")
    print(f"  Precision @ {top_k:<2}     : {prec:.3f}")
    print(f"  Recall @ {top_k:<2}        : {recall:.3f}  (≈ Hit Rate, 1 relevant doc assumed)")
    print(f"  MRR @ {top_k:<2}           : {mrr:.3f}\n")

    return {
        "n_questions" : n,
        "top_k"       : top_k,
        "hit_rate"    : round(hit_rate, 3),
        "precision"   : round(prec,     3),
        "recall"      : round(recall,   3),
        "mrr"         : round(mrr,      3),
        "per_question": results,
    }


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RAG retrieval evaluation")
    parser.add_argument(
        "--dataset", default=str(Path(__file__).parent / "eval_dataset.json"),
        help="Path to eval_dataset.json"
    )
    parser.add_argument(
        "--top-k", type=int, default=SIMILARITY_TOP_K,
        help=f"Number of chunks to retrieve (default: {SIMILARITY_TOP_K})"
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="Print retrieved chunk text for every miss (helps fix wrong keywords)"
    )
    parser.add_argument(
        "--filter", default=None,
        help="Comma-separated file names to restrict questions to (e.g. 'CCF04162026.pdf')"
    )
    args = parser.parse_args()

    if not os.path.exists(args.dataset):
        print(f"Dataset not found: {args.dataset}")
        sys.exit(1)

    file_filter = {x.strip() for x in args.filter.split(",")} if args.filter else None
    asyncio.run(evaluate(args.dataset, args.top_k, debug=args.debug, file_filter=file_filter))
