"""Playbook and author-profile learning. Map (one call per paper) then reduce (one call)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from .. import storage
from ..db import SessionLocal
from ..ingest import extract
from ..jobs import JobContext
from ..kinds import kind_exists, kind_name, read_kind
from ..llm.base import LLMError, Message
from ..llm.jsonio import complete_json
from ..llm.registry import complete
from ..models import AuthorProfile, Project
from . import stats as stats_mod
from .context import budget_markdown, render, sample_for_style

PLAYBOOK_KEYS = {
    "structure": "structure.md",
    "argumentation": "argumentation.md",
    "evaluation": "evaluation.md",
    "related_work": "related-work.md",
    "venue": "venue.md",
}


def _ready_papers(root: Path) -> list[tuple[Path, dict, str]]:
    out = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        meta = extract.read_meta(d) if d.is_dir() else None
        if meta and meta.get("status") == "ready" and (d / "extracted.md").exists():
            out.append((d, meta, (d / "extracted.md").read_text(encoding="utf-8")))
    return out


async def _map_call(
    sem: asyncio.Semaphore, purpose: str, prompt: str, *, project: Project | None, user_id: str, max_tokens: int
) -> dict:
    async with sem:
        with SessionLocal() as db:
            proj = db.get(Project, project.id) if project else None
            data, result = await complete_json(
                db,
                purpose,
                [Message("user", prompt)],
                project=proj,
                user_id=user_id,
                max_tokens=max_tokens,
                temperature=0.2,
            )
    usage = result.usage
    return {"data": data, "tokens_in": usage.input_tokens, "tokens_out": usage.output_tokens}


# ------------------------------------------------------------------ playbook


async def learn_playbook(project_id: str, ctx: JobContext, *, max_chars_per_paper: int, concurrency: int = 3) -> dict:
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if not project:
            raise ValueError("Project not found")
        slug, kind = project.slug, project.kind
    root = storage.project_dir(slug)
    papers = _ready_papers(root / "exemplars")
    if not papers:
        raise ValueError("No ingested exemplars. Add papers on the Sources page first.")

    kname = kind_name(kind) if kind_exists(kind) else kind
    kind_notes = read_kind(kind)["files"].get("kind.md", "") if kind_exists(kind) and kind != "other" else ""

    ctx.progress(3, f"Summarising {len(papers)} papers, up to {max_chars_per_paper:,} characters each")
    sem = asyncio.Semaphore(concurrency)
    tokens_in = tokens_out = 0
    summaries: list[str] = []
    done = 0

    async def one(folder: Path, meta: dict, md: str):
        nonlocal done, tokens_in, tokens_out
        text = budget_markdown(md, max_chars_per_paper)
        sections = [s for s in meta.get("sections", []) if s.get("level", 2) <= 3][:40]
        prompt = render(
            "paper_summary.j2",
            kind_name=kname,
            paper=text,
            sections=sections,
            total_words=meta.get("word_count", len(md.split())),
        )
        r = await _map_call(sem, "learn", prompt, project=project, user_id=ctx.user_id, max_tokens=2500)
        data = r["data"]
        data.setdefault("title", meta.get("title"))
        (folder / "summary.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        done += 1
        tokens_in += r["tokens_in"]
        tokens_out += r["tokens_out"]
        ctx.progress(
            5 + int(60 * done / len(papers)), f"Summarised {done} of {len(papers)}: {meta.get('title', '')[:60]}"
        )
        return json.dumps(data, ensure_ascii=False)

    results = await asyncio.gather(*(one(f, m, md) for f, m, md in papers), return_exceptions=True)
    failures = [r for r in results if isinstance(r, Exception)]
    summaries = [r for r in results if isinstance(r, str)]
    if not summaries:
        raise LLMError(f"All summaries failed: {failures[0]}")

    ctx.progress(70, "Synthesising the playbook")
    prompt = render("playbook.j2", kind_name=kname, kind_notes=kind_notes, summaries=summaries)
    with SessionLocal() as db:
        proj = db.get(Project, project_id)
        data, result = await complete_json(
            db,
            "learn",
            [Message("user", prompt)],
            project=proj,
            user_id=ctx.user_id,
            max_tokens=7000,
            temperature=0.3,
        )
    tokens_in += result.usage.input_tokens
    tokens_out += result.usage.output_tokens

    written = []
    for key, filename in PLAYBOOK_KEYS.items():
        content = data.get(key)
        if isinstance(content, str) and content.strip():
            storage.write_text(root / "playbook" / filename, content.strip() + "\n")
            written.append(filename)
    storage.git_commit(root, f"Learn playbook from {len(summaries)} exemplars")
    with SessionLocal() as db:
        proj = db.get(Project, project_id)
        if proj and proj.stage in ("setup", "sources"):
            proj.stage = "playbook"
            db.commit()
    summary = {
        "papers": len(summaries),
        "failed": len(failures),
        "files": written,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "max_chars_per_paper": max_chars_per_paper,
    }
    ctx.progress(100, f"Playbook written from {len(summaries)} papers ({tokens_in + tokens_out:,} tokens)")
    return summary


# ------------------------------------------------------------------ author profile


def settle_profile_status(profile_id: str) -> None:
    """After a learn run that was stopped or failed: show what is on disk instead of "learning" forever."""
    with SessionLocal() as db:
        p = db.get(AuthorProfile, profile_id)
        if p and p.status == "learning":
            p.status = "ready" if storage.read_text(storage.profile_dir(p.slug) / "style.md").strip() else "empty"
            db.commit()


async def learn_profile(profile_id: str, ctx: JobContext, *, max_chars_per_paper: int, concurrency: int = 3) -> dict:
    with SessionLocal() as db:
        prof = db.get(AuthorProfile, profile_id)
        if not prof:
            raise ValueError("Profile not found")
        slug, name = prof.slug, prof.name
        prof.status = "learning"
        db.commit()
    root = storage.profile_dir(slug)
    papers = _ready_papers(root / "sources")
    if not papers:
        with SessionLocal() as db:
            p = db.get(AuthorProfile, profile_id)
            if p:
                p.status = "empty"
                db.commit()
        raise ValueError("No ingested source papers. Add this author's papers first.")

    ctx.progress(3, f"Reading {len(papers)} papers for voice, up to {max_chars_per_paper:,} characters each")
    sem = asyncio.Semaphore(concurrency)
    tokens_in = tokens_out = 0
    per_paper_stats = []
    done = 0

    async def one(folder: Path, meta: dict, md: str):
        nonlocal done, tokens_in, tokens_out
        st = stats_mod.text_stats(md)
        per_paper_stats.append(st)
        sample = sample_for_style(md, max_chars_per_paper)
        r = await _map_call(
            sem, "learn", render("style_sample.j2", sample=sample), project=None, user_id=ctx.user_id, max_tokens=1500
        )
        (folder / "style-notes.json").write_text(
            json.dumps({**r["data"], "stats": st}, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        done += 1
        tokens_in += r["tokens_in"]
        tokens_out += r["tokens_out"]
        ctx.progress(5 + int(60 * done / len(papers)), f"Studied {done} of {len(papers)}: {meta.get('title', '')[:60]}")
        return json.dumps(r["data"], ensure_ascii=False)

    results = await asyncio.gather(*(one(f, m, md) for f, m, md in papers), return_exceptions=True)
    failures = [r for r in results if isinstance(r, Exception)]
    observations = [r for r in results if isinstance(r, str)]
    if not observations:
        with SessionLocal() as db:
            p = db.get(AuthorProfile, profile_id)
            if p:
                p.status = "empty"
                db.commit()
        raise LLMError(f"All style passes failed: {failures[0]}")

    ctx.progress(70, "Writing the voice profile")
    merged = stats_mod.merge_stats(per_paper_stats)
    prompt = render(
        "style_profile.j2", profile_name=name, stats=json.dumps(merged, indent=2), observations=observations
    )
    with SessionLocal() as db:
        result = await complete(
            db, "learn", [Message("user", prompt)], user_id=ctx.user_id, max_tokens=2500, temperature=0.3
        )
    tokens_in += result.usage.input_tokens
    tokens_out += result.usage.output_tokens
    style = result.text.strip() + "\n"
    storage.write_text(root / "style.md", style)
    storage.write_text(root / "stats.json", json.dumps(merged, indent=2))
    storage.git_commit(root, f"Learn voice from {len(observations)} papers")
    with SessionLocal() as db:
        p = db.get(AuthorProfile, profile_id)
        if p:
            p.status = "ready"
            db.commit()
    ctx.progress(100, f"Voice profile written from {len(observations)} papers ({tokens_in + tokens_out:,} tokens)")
    return {
        "papers": len(observations),
        "failed": len(failures),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "max_chars_per_paper": max_chars_per_paper,
    }
