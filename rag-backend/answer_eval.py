#!/usr/bin/env python3
"""
answer_eval.py  —  End-to-end answer quality evaluation for the RAG assistant.

Measures three things for every question that has an `expected_answer` field:
  • Correctness  – does the actual answer match the expected answer? (LLM judge)
  • Faithfulness – is the answer grounded in the retrieved context?  (existing /eval endpoint)
  • Relevance    – does the answer address the question?             (existing /eval endpoint)

Usage
-----
  cd rag-backend
  python answer_eval.py \\
      --email admin@example.com \\
      --password yourpassword \\
      --files "Devis_NAWAARNI.docx" "CCF04162026.pdf" \\  # files already in a session
      --session-id <uuid>                                  # get from the UI URL or /sessions

  # Or let the script discover sessions automatically:
  python answer_eval.py --email admin@example.com --password yourpassword --auto

Options
-------
  --url        Backend URL (default: http://localhost:8000)
  --email      Login email
  --password   Login password
  --session-id Session UUID to use for /ask calls
  --auto       Discover the first available session automatically
  --limit N    Only run the first N questions (useful for quick smoke-tests)
  --filter     Comma-separated list of source_file names to restrict questions
  --dataset    Path to eval_dataset.json (default: ./eval_dataset.json)
  --no-color   Disable ANSI colors in output

Dependencies (all already in the project venv):
  pip install requests python-dotenv ollama
"""

import argparse
import json
import os
import sys
import time
import re
import textwrap
from pathlib import Path
import requests
from dotenv import load_dotenv

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────

DEFAULT_URL    = "http://localhost:8000"
DATASET_PATH   = Path(__file__).parent / "eval_dataset.json"
LLM_MODEL      = os.getenv("LLM_MODEL", "qwen2.5:7b")
OLLAMA_BASE    = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
SSE_TIMEOUT    = 120          # seconds to wait for /ask SSE stream
JUDGE_RETRIES  = 2            # retries on malformed judge response

# ── ANSI colours ──────────────────────────────────────────────────────────────

USE_COLOR = True

def _c(code: str, text: str) -> str:
    if not USE_COLOR:
        return text
    return f"\033[{code}m{text}\033[0m"

GREEN  = lambda t: _c("32", t)
YELLOW = lambda t: _c("33", t)
RED    = lambda t: _c("31", t)
BOLD   = lambda t: _c("1",  t)
DIM    = lambda t: _c("2",  t)
CYAN   = lambda t: _c("36", t)

# ── Auth ──────────────────────────────────────────────────────────────────────

def login(url: str, email: str, password: str) -> str:
    """Return a JWT access token."""
    r = requests.post(f"{url}/auth/login",
                      json={"email": email, "password": password},
                      timeout=15)
    if r.status_code != 200:
        sys.exit(f"Login failed ({r.status_code}): {r.text}")
    return r.json()["access_token"]

# ── File discovery ────────────────────────────────────────────────────────────

def get_indexed_files(url: str, token: str) -> list[str]:
    """Return list of file names that are indexed and ready."""
    r = requests.get(f"{url}/documents",
                     headers={"Authorization": f"Bearer {token}"},
                     timeout=15)
    if r.status_code != 200:
        sys.exit(f"Could not list documents ({r.status_code}): {r.text}")
    docs = r.json()
    ready = [d["name"] for d in docs if d.get("status", "ready") == "ready"]
    return ready

# ── Call /ask and collect SSE answer ─────────────────────────────────────────

def call_ask(url: str, token: str, question: str, files: list[str], provider: str = "local", groq_model: str | None = None) -> tuple[str, float, float]:
    """
    POST /ask and collect the streamed answer.
    Returns (answer_text, faithfulness_0_to_1, relevance_0_to_1).
    F/R come from the `eval` SSE event if ENABLE_EVAL=true; otherwise -1.
    """
    payload = {"question": question, "files": files, "history": [], "provider": provider, "fast": True}
    if groq_model:
        payload["groq_model"] = groq_model
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "text/event-stream",
    }

    answer_chunks: list[str] = []
    faithfulness = -1.0
    relevance    = -1.0

    try:
        with requests.post(
            f"{url}/ask",
            json=payload,
            headers=headers,
            stream=True,
            timeout=SSE_TIMEOUT,
        ) as resp:
            if resp.status_code != 200:
                return f"[HTTP {resp.status_code}] {resp.text[:200]}", -1.0, -1.0

            buffer = ""
            for raw in resp.iter_content(chunk_size=None, decode_unicode=True):
                buffer += raw
                while "\n\n" in buffer:
                    event_str, buffer = buffer.split("\n\n", 1)
                    for line in event_str.splitlines():
                        if line.startswith("data:"):
                            try:
                                data = json.loads(line[5:].strip())
                            except json.JSONDecodeError:
                                continue
                            t = data.get("type", "")
                            if t == "token":
                                answer_chunks.append(data.get("content", ""))
                            elif t == "eval":
                                faithfulness = float(data.get("faithfulness",    -1))
                                relevance    = float(data.get("answer_relevance", -1))
                            elif t == "error":
                                msg = data.get('message','')
                                print(f"  [ask error] {msg[:200]}")
                                return f"[error] {msg}", -1.0, -1.0
    except requests.Timeout:
        return "[timeout]", -1.0, -1.0
    except Exception as e:
        return f"[exception] {e}", -1.0, -1.0

    return "".join(answer_chunks).strip(), faithfulness, relevance

# ── LLM-as-judge: correctness ─────────────────────────────────────────────────

JUDGE_PROMPT = """\
You are evaluating a RAG system answer for correctness.

Question       : {question}
Expected answer: {expected}
Actual answer  : {actual}

Score the actual answer for CORRECTNESS on a scale of 0.0 to 1.0.

Scoring guide:
  1.0  — Fully correct. All key facts match the expected answer.
  0.75 — Mostly correct. Minor omission or slight inaccuracy.
  0.5  — Partially correct. At least one key fact is right but important info is missing or wrong.
  0.25 — Barely relevant. Mentions the topic but misses the core fact.
  0.0  — Wrong or the system said it cannot answer.

Important:
- Ignore phrasing differences; score on factual accuracy only.
- If the actual answer says "I don't know" or "not found in the document", score 0.0.
- Reply with ONLY a JSON object on a single line, nothing else:
  {{"score": <float 0.0-1.0>, "reason": "<one short sentence>"}}
"""

def judge_correctness(question: str, expected: str, actual: str, provider: str = "local") -> tuple[float, str]:
    """Keyword-overlap scorer — no LLM, no rate limits, works offline."""
    if not actual or actual.startswith("["):
        return 0.0, "system returned error or empty answer"

    stop = {
        "le","la","les","un","une","des","de","du","en","et","est","ce","que","qui",
        "dans","par","sur","pour","avec","au","aux","se","on","il","elle","ils","elles",
        "the","a","an","is","of","in","to","and","for","at","be","this","that","with","are","was",
    }

    def tokens(s):
        return {w for w in re.sub(r"[^a-z0-9àâçéèêëîïôùûü]", " ", s.lower()).split()
                if w not in stop and len(w) > 2}

    exp_tok = tokens(expected)
    act_tok = tokens(actual)
    if not exp_tok:
        return -1.0, "expected answer has no meaningful words"

    overlap = len(exp_tok & act_tok) / len(exp_tok)
    if overlap >= 0.7:
        return 1.0,  f"good overlap ({overlap:.0%} of expected keywords found)"
    elif overlap >= 0.4:
        return 0.75, f"partial overlap ({overlap:.0%} of expected keywords found)"
    elif overlap >= 0.2:
        return 0.5,  f"low overlap ({overlap:.0%} of expected keywords found)"
    else:
        return 0.0,  f"almost no overlap ({overlap:.0%} of expected keywords found)"

# ── Score colour helper ────────────────────────────────────────────────────────

def score_color(s: float) -> str:
    if s < 0:
        return DIM("  N/A")
    pct = f"{s*100:5.1f}%"
    if s >= 0.75:
        return GREEN(pct)
    elif s >= 0.5:
        return YELLOW(pct)
    else:
        return RED(pct)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global USE_COLOR

    parser = argparse.ArgumentParser(description="End-to-end answer quality eval")
    parser.add_argument("--url",        default=DEFAULT_URL)
    parser.add_argument("--email",      required=True)
    parser.add_argument("--password",   required=True)
    parser.add_argument("--limit",      type=int, default=None,
                        help="Run only the first N questions")
    parser.add_argument("--filter",     default=None,
                        help="Comma-separated file names to restrict questions to")
    parser.add_argument("--dataset",    default=str(DATASET_PATH))
    parser.add_argument("--no-color",   action="store_true")
    parser.add_argument("--auto",       action="store_true",
                        help="Auto-discover indexed files (default behaviour, flag for compatibility)")
    parser.add_argument("--provider",   default="local", choices=["local", "cloud", "openai"],
                        help="LLM provider to use for /ask calls (default: local)")
    parser.add_argument("--groq-model", default=None,
                        help="Override Groq model for this run only, e.g. llama-3.1-8b-instant")
    args = parser.parse_args()

    if args.no_color:
        USE_COLOR = False

    # ── Load dataset ──
    with open(args.dataset, encoding="utf-8") as f:
        raw = json.load(f)

    file_filter = set()
    if args.filter:
        file_filter = {x.strip() for x in args.filter.split(",")}

    questions = []
    for entry in raw:
        if not entry.get("id") or "_SKIP" in entry.get("id", ""):
            continue
        if not entry.get("expected_answer"):
            continue
        if not entry.get("source_files"):
            continue
        if file_filter:
            if not any(f in file_filter for f in entry["source_files"]):
                continue
        questions.append(entry)

    if args.limit:
        questions = questions[:args.limit]

    if not questions:
        sys.exit("No questions with expected_answer found (check --filter or dataset).")

    print(BOLD(f"\n=== Answer Quality Eval  ({len(questions)} questions) ===\n"))

    # ── Auth + file list ──
    print(DIM("Logging in…"))
    token = login(args.url, args.email, args.password)

    session_files = get_indexed_files(args.url, token)
    if not session_files:
        sys.exit("No indexed files found. Upload and index files in the UI first.")
    print(DIM(f"Found {len(session_files)} indexed file(s): {', '.join(session_files[:5])}{'…' if len(session_files) > 5 else ''}\n"))

    # ── Run eval ──
    results = []
    col_w   = 46   # question column width

    header = (
        f"{'#':>3}  "
        f"{'Question':<{col_w}}  "
        f"{'Correct':>8}  "
        f"{'Faith':>7}  "
        f"{'Relev':>7}  "
        f"Reason"
    )
    print(BOLD(header))
    print("─" * (len(header) + 20))

    for i, q in enumerate(questions, 1):
        question = q["question"]
        expected = q["expected_answer"]
        files    = q["source_files"]

        # Use only files that exist in the session
        ask_files = [f for f in files if f in session_files]
        if not ask_files:
            ask_files = session_files   # fallback: all session files

        # Call /ask
        actual, faith, relev = call_ask(args.url, token, question, ask_files, args.provider, groq_model=args.groq_model)

        # Judge correctness
        correctness, reason = judge_correctness(question, expected, actual, provider=args.provider)

        results.append({
            "id":          q["id"],
            "question":    question,
            "expected":    expected,
            "actual":      actual,
            "correctness": correctness,
            "faithfulness":faith,
            "relevance":   relev,
            "reason":      reason,
        })

        q_short = textwrap.shorten(question, col_w)
        r_short = textwrap.shorten(reason, 50)
        print(
            f"{i:>3}.  "
            f"{q_short:<{col_w}}  "
            f"{score_color(correctness)}  "
            f"{score_color(faith)}  "
            f"{score_color(relev)}  "
            f"{DIM(r_short)}"
        )

        if args.provider in ("cloud", "groq") and i < len(questions):
            time.sleep(3)   # ~20 req/min — stays under Groq 30 RPM limit

    # ── Summary ──
    def avg(key):
        vals = [r[key] for r in results if r[key] >= 0]
        return sum(vals) / len(vals) if vals else -1.0

    n        = len(results)
    avg_c    = avg("correctness")
    avg_f    = avg("faithfulness")
    avg_r    = avg("relevance")
    pass_c   = sum(1 for r in results if r["correctness"] >= 0.75)
    pass_pct = pass_c / n * 100

    print("\n" + "─" * (len(header) + 20))
    print(BOLD(
        f"\n{'SUMMARY':}\n"
        f"  Questions evaluated : {n}\n"
        f"  Pass (≥0.75)        : {pass_c}/{n}  ({pass_pct:.1f}%)\n"
        f"  Avg Correctness     : {score_color(avg_c)}\n"
        f"  Avg Faithfulness    : {score_color(avg_f)}\n"
        f"  Avg Relevance       : {score_color(avg_r)}\n"
    ))

    # ── Failures ──
    failures = [r for r in results if r["correctness"] < 0.5]
    if failures:
        print(BOLD(RED(f"  Low-scoring questions ({len(failures)}):")))
        for r in failures:
            print(f"    {RED('✗')}  [{r['id']}]  {textwrap.shorten(r['question'], 60)}")
            print(f"       expected : {textwrap.shorten(r['expected'], 70)}")
            print(f"       actual   : {textwrap.shorten(r['actual'],   70)}")
            print(f"       reason   : {r['reason']}")
            print()

    # ── Save results ──
    out_path = Path(args.dataset).parent / "answer_eval_results.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "summary": {
                "n": n,
                "pass_count": pass_c,
                "pass_pct": round(pass_pct, 1),
                "avg_correctness": round(avg_c, 3),
                "avg_faithfulness": round(avg_f, 3),
                "avg_relevance": round(avg_r, 3),
            },
            "results": results,
        }, f, ensure_ascii=False, indent=2)
    print(BOLD(f"  Results saved → {out_path}"))


if __name__ == "__main__":
    main()
