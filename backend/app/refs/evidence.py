"""Citation evidence (ROADMAP day 10): what stands behind a `[@key]`, and finding a source
for a sentence that has none.

Three things, in the order a careful author checks them:
1. `evidence()` shows the record's "what it says" and, when the full text is on disk (a
   background reading or an exemplar), the paragraph that best matches the citing sentence.
   Deterministic word overlap, no model, so the author reads the paper's own words.
2. `check()` asks the utility model whether the passage supports the sentence.
3. `find_sources()` ranks the project's own references against a sentence, then asks the
   indexes with a model-written query; `rewrite()` restates a sentence to what the project's
   references actually support when nothing fits.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

from .. import storage
from ..db import SessionLocal
from ..ingest import extract as ingest_extract
from ..learn.context import render
from ..llm.base import Message
from ..llm.jsonio import extract_json
from ..llm.registry import complete
from ..models import Project
from . import readings
from . import service as refs
from .providers import search
from .scan import _identity

_WORD = re.compile(r"[A-Za-z][A-Za-z\-]{2,}")
_STOP = set(
    """the and for that with this from are was were been have has had not but into over under
    between about their there these those than then they them its his her our your which who whom
    while where when what also such more most some many much very can could would should may might
    will shall does did done being use used using based paper study work results result show shows
    shown however therefore thus because within without both each other one two three first second
    section figure table""".split()
)
MAX_PASSAGE = 900
MIN_PARAGRAPH_WORDS = 12
NO_TEXT_HINT = (
    "Only the abstract is on record. Add this paper under Background reading to verify against its full text."
)


def _stem(w: str) -> str:
    """Cheap suffix stripping so "students" meets "student" and "accepted" meets "accept"."""
    for suf in ("ities", "ations", "ation", "ings", "ing", "ies", "ers", "ed", "es", "ly", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            if suf == "ies":
                return w[: -len(suf)] + "y"
            if suf in ("ities",):
                return w[: -len(suf)] + "ity"
            if suf in ("ations", "ation"):
                return w[: -len(suf)] + "ate"
            return w[: -len(suf)]
    return w


def _tokens(text: str) -> list[str]:
    return [_stem(w.lower()) for w in _WORD.findall(text) if w.lower() not in _STOP]


def _paragraphs(md: str, meta: dict) -> list[dict]:
    """Prose paragraphs with the heading they sit under."""
    secs = sorted(meta.get("sections") or [], key=lambda s: s["start"])
    out = []
    pos = 0
    for para in re.split(r"\n\s*\n", md):
        start = md.find(para, pos)
        pos = start + len(para) if start >= 0 else pos
        text = para.strip()
        if not text or text.startswith(("#", "|", "![", "```", "$$")) or len(text.split()) < MIN_PARAGRAPH_WORDS:
            continue
        heading = ""
        for s in secs:
            if s["start"] <= start:
                heading = s["title"]
            else:
                break
        out.append({"section": heading, "text": re.sub(r"\s+", " ", text)})
    return out


def best_passages(md: str, meta: dict, sentence: str, n: int = 2) -> list[dict]:
    """Paragraphs ranked by overlap with the sentence, rare words weighing more."""
    paras = _paragraphs(md, meta)
    if not paras:
        return []
    q = set(_tokens(sentence))
    if not q:
        return []
    docs = [set(_tokens(p["text"])) for p in paras]
    df = {w: sum(1 for d in docs if w in d) for w in q}
    total = len(paras)
    scored = []
    for p, d in zip(paras, docs, strict=True):
        hits = q & d
        if not hits:
            continue
        score = sum(math.log(1 + total / df[w]) for w in hits)
        scored.append((score, len(hits), p))
    scored.sort(key=lambda t: (-t[0], -t[1]))
    out = []
    for score, hits, p in scored[:n]:
        text = p["text"]
        out.append(
            {
                "section": p["section"],
                "text": text[:MAX_PASSAGE] + ("…" if len(text) > MAX_PASSAGE else ""),
                "matched": sorted(q & set(_tokens(text)))[:12],
                "score": round(score, 2),
                "coverage": round(hits / max(1, len(q)), 2),
            }
        )
    return out


def full_text_for(root: Path, record: dict) -> tuple[Path, dict] | None:
    """The folder holding this reference's full text: its reading, or a matching exemplar."""
    if record.get("reading_id"):
        folder = readings.readings_dir(root) / record["reading_id"]
        meta = ingest_extract.read_meta(folder) if folder.is_dir() else None
        if meta and meta.get("status") == "ready":
            return folder, meta
    ids = _identity(record)
    for sub in ("readings", "exemplars"):
        base = root / sub
        if not base.exists():
            continue
        for folder in sorted(base.iterdir()):
            meta = ingest_extract.read_meta(folder) if folder.is_dir() else None
            if meta and meta.get("status") == "ready" and ids & _identity(meta):
                return folder, meta
    return None


def what_it_says(record: dict) -> str:
    if record.get("card"):
        return readings.card_lines(record, full=True)
    return re.sub(r"\s+", " ", (record.get("abstract") or "").strip())


def evidence(root: Path, key: str, sentence: str) -> dict:
    record = refs.get_record(root, key)
    if not record:
        raise ValueError("No verified reference with that key")
    hit = full_text_for(root, record)
    passages: list[dict] = []
    if hit:
        folder, meta = hit
        md = storage.read_text(folder / "extracted.md")
        passages = best_passages(md, meta, sentence)
    source = "full_text" if hit else "card" if record.get("card") else "abstract"
    return {
        "key": key,
        "record": {k: record.get(k) for k in ("title", "authors", "year", "venue", "url", "doi", "arxiv_id", "source")},
        "what_it_says": what_it_says(record),
        "has_card": bool(record.get("card")),
        "full_text": bool(hit),
        "passages": passages,
        "source": source,
        "hint": None if hit else NO_TEXT_HINT,
    }


async def check(project_id: str, key: str, sentence: str, passage: str, user_id: str | None) -> dict:
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if not project:
            raise ValueError("Project not found")
        root = storage.project_dir(project.slug)
        record = refs.get_record(root, key)
        if not record:
            raise ValueError("No verified reference with that key")
        prompt = render(
            "cite_check.j2",
            sentence=sentence.strip()[:1200],
            title=record.get("title", ""),
            what_it_says=what_it_says(record)[:2500],
            passage=passage.strip()[:2500],
        )
        result = await complete(
            db,
            "utility",
            [Message("user", prompt)],
            project=project,
            user_id=user_id,
            max_tokens=300,
            temperature=0.0,
            json_mode=True,
        )
    data = extract_json(result.text)
    verdict = str(data.get("verdict", "")).lower().replace(" ", "_")
    if verdict not in ("supported", "partly_supported", "not_supported"):
        verdict = "partly_supported"
    return {
        "verdict": verdict,
        "reason": str(data.get("reason", "")).strip()[:600],
        "tokens_in": result.usage.input_tokens,
        "tokens_out": result.usage.output_tokens,
    }


def rank_own(root: Path, sentence: str, n: int = 5) -> list[dict]:
    """The project's own references most related to a sentence, by overlap with what they say."""
    q = set(_tokens(sentence))
    if not q:
        return []
    out = []
    for r in refs.list_records(root):
        text = f"{r.get('title', '')} {what_it_says(r)}"
        hits = q & set(_tokens(text))
        if len(hits) < 2:
            continue
        out.append(
            {
                "key": r["key"],
                "title": r.get("title"),
                "year": r.get("year"),
                "has_card": bool(r.get("card")),
                "what_it_says": what_it_says(r)[:400],
                "matched": sorted(hits)[:10],
                "score": round(len(hits) / len(q), 2),
            }
        )
    out.sort(key=lambda x: -x["score"])
    return out[:n]


async def find_sources(project_id: str, sentence: str, user_id: str | None) -> dict:
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if not project:
            raise ValueError("Project not found")
        root = storage.project_dir(project.slug)
        own = rank_own(root, sentence)
        prompt = render("cite_query.j2", sentence=sentence.strip()[:1200], title=project.title)
        result = await complete(
            db,
            "utility",
            [Message("user", prompt)],
            project=project,
            user_id=user_id,
            max_tokens=200,
            temperature=0.2,
            json_mode=True,
        )
    data = extract_json(result.text)
    query = str(data.get("query", "")).strip()[:200] or " ".join(_tokens(sentence)[:8])
    claim = str(data.get("claim", "")).strip()[:200]
    cands, errors = await search(query, 8)
    known: set[str] = set()
    for r in refs.list_records(root):
        known |= _identity(r)
    fresh = [c.to_dict() for c in cands if not (_identity(c.to_dict()) & known)]
    return {
        "own": own,
        "query": query,
        "claim": claim,
        "candidates": fresh,
        "errors": errors,
        "tokens_in": result.usage.input_tokens,
        "tokens_out": result.usage.output_tokens,
    }


async def rewrite(project_id: str, sentence: str, user_id: str | None) -> dict:
    """Restate a sentence to what the project's references support, or hedge it with a placeholder."""
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if not project:
            raise ValueError("Project not found")
        root = storage.project_dir(project.slug)
        own = rank_own(root, sentence, n=6)
        prompt = render(
            "cite_rewrite.j2",
            sentence=sentence.strip()[:1200],
            references=own,
            house_style=storage.read_text(storage.house_style_path())[:3000],
        )
        result = await complete(
            db,
            "utility",
            [Message("user", prompt)],
            project=project,
            user_id=user_id,
            max_tokens=400,
            temperature=0.2,
            json_mode=True,
        )
    data = extract_json(result.text)
    new = str(data.get("sentence", "")).strip()
    known = refs.keys(root)
    # every key in every [@a; @b] group: checking only the first let an invented second key through
    used = [k for group in re.findall(r"\[(@[^\]]+)\]", new) for k in re.findall(r"@([^\s;,\]]+)", group)]
    if not new or any(k not in known for k in used):
        gist = re.sub(r"\s+", " ", sentence.strip())[:90].rstrip(".")
        new = f"{sentence.strip().rstrip('.')} [CITE: {gist}]."
        used = []
    return {
        "sentence": new,
        "used_keys": used,
        "note": str(data.get("note", "")).strip()[:300],
        "tokens_in": result.usage.input_tokens,
        "tokens_out": result.usage.output_tokens,
    }
