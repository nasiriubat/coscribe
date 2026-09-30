"""Critique pass (SPEC 4.9) and venue suggestion (SPEC 4.10)."""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime
from pathlib import Path

from .. import storage
from ..db import SessionLocal
from ..ingest import extract as ingest_extract
from ..jobs import JobContext
from ..kinds import kind_exists, kind_name, read_kind
from ..learn.context import budget_markdown, render
from ..llm.base import Message
from ..llm.jsonio import extract_json
from ..llm.registry import complete
from ..models import Project
from . import service as studio


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _project(project_id: str) -> tuple[Project, Path]:
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        if not p:
            raise ValueError("Project not found")
        db.expunge(p)
    return p, storage.project_dir(p.slug)


def load_review(root: Path) -> dict | None:
    p = root / "review.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
    return None


def load_venues(root: Path) -> dict | None:
    p = root / "inputs" / "venues.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
    return None


def _draft_text(root: Path) -> tuple[str, int, int, int]:
    index = studio.load_index(root)
    parts, words, drafted = [], 0, 0
    for s in sorted(index["sections"], key=lambda x: x["order"]):
        text = studio.read_section(root, s).strip()
        if text:
            drafted += 1
            words += studio._word_count(text)
            parts.append(f"## {s['title']} ({studio._word_count(text)} words)\n\n{text}\n")
    return "\n".join(parts), words, drafted, len(index["sections"])


async def run_critique(project_id: str, ctx: JobContext) -> dict:
    project, root = _project(project_id)
    draft, words, drafted, total = _draft_text(root)
    if not draft.strip():
        raise ValueError("Nothing drafted yet. Draft at least one section first.")
    kname = kind_name(project.kind) if kind_exists(project.kind) else project.kind
    kfiles = read_kind(project.kind)["files"] if kind_exists(project.kind) else {}
    playbook = "\n\n".join(
        budget_markdown(storage.read_text(root / "playbook" / f), n)
        for f, n in (("argumentation.md", 3000), ("evaluation.md", 3000), ("structure.md", 2000))
    )
    if not storage.read_text(root / "inputs" / "facts.md").strip():
        # Draft-first projects skip the outline step that extracts facts. Without them the reviewer
        # reported every number the author wrote as unsupported, although the description has them.
        from ..interview.service import extract_facts

        ctx.progress(5, "Collecting the facts from your description first")
        await extract_facts(project_id, ctx)
    ctx.progress(10, f"Reading {drafted} drafted section(s), {words:,} words")
    prompt = render(
        "critique.j2",
        kind_name=kname,
        venue=project.venue or "",
        kind_notes=kfiles.get("kind.md", ""),
        checklist=kfiles.get("checklist.md", ""),
        playbook=playbook,
        facts=storage.read_text(root / "inputs" / "facts.md")[:6000],
        draft=budget_markdown(draft, 60_000),
        total_words=words,
    )
    ctx.progress(30, "Reviewing")
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(
            db,
            "critique",
            [Message("user", prompt)],
            project=p,
            user_id=ctx.user_id,
            max_tokens=4000,
            temperature=0.2,
            json_mode=True,
        )
    data = extract_json(result.text)
    findings = data.get("findings") or []
    review = {
        "verdict": data.get("verdict", "major revision"),
        "summary": data.get("summary", ""),
        "strengths": data.get("strengths") or [],
        "findings": [{**f, "id": secrets.token_hex(4)} for f in findings],
        "cross_section": data.get("cross_section") or [],
        "page_budget": data.get("page_budget", ""),
        "words": words,
        "drafted_sections": drafted,
        "total_sections": total,
        "created_at": _now(),
        "tokens_in": result.usage.input_tokens,
        "tokens_out": result.usage.output_tokens,
    }
    storage.write_text(root / "review.json", json.dumps(review, indent=2, ensure_ascii=False))

    # Major findings become checklist items so they are tracked to resolution.
    items = studio.load_checklist(root)
    seen = {(i["section"], i["text"].lower()) for i in items}
    added = 0
    for f in review["findings"]:
        if f.get("severity") != "major":
            continue
        text = f"Reviewer: {f.get('issue', '').strip()} Fix: {f.get('fix', '').strip()}".strip()
        key = (f.get("section", "Whole paper"), text.lower())
        if key not in seen:
            items.append(
                {
                    "id": secrets.token_hex(4),
                    "section": f.get("section", "Whole paper"),
                    "text": text[:600],
                    "source": "critique",
                    "status": "open",
                    "created_at": _now(),
                }
            )
            seen.add(key)
            added += 1
    studio.save_checklist(root, items)
    storage.git_commit(root, f"Critique: {review['verdict']}, {len(findings)} findings")
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        if p and p.stage == "drafting":
            p.stage = "review"
            db.commit()
    ctx.progress(100, f"Verdict: {review['verdict']}. {len(findings)} findings, {added} added to the checklist.")
    return {
        "verdict": review["verdict"],
        "findings": len(findings),
        "checklist_added": added,
        "tokens_in": result.usage.input_tokens,
        "tokens_out": result.usage.output_tokens,
    }


async def suggest_venues(project_id: str, user_id: str) -> dict:
    project, root = _project(project_id)
    kname = kind_name(project.kind) if kind_exists(project.kind) else project.kind
    _, words, drafted, total = _draft_text(root)
    venues = []
    ex_root = root / "exemplars"
    if ex_root.exists():
        for d in sorted(ex_root.iterdir()):
            meta = ingest_extract.read_meta(d) if d.is_dir() else None
            if meta and meta.get("status") == "ready":
                where = meta.get("journal_ref") or meta.get("comment") or "venue not stated (arXiv)"
                venues.append(f"- {meta.get('title', '')[:80]}: {where}")
    prompt = render(
        "venue.j2",
        kind_name=kname,
        spec=budget_markdown(storage.read_text(root / "inputs" / "system-spec.md"), 8000),
        plan=budget_markdown(storage.read_text(root / "inputs" / "research-plan.md"), 3000),
        venue_notes=storage.read_text(root / "playbook" / "venue.md")[:3000],
        exemplar_venues="\n".join(venues),
        total_words=words,
        drafted_sections=drafted,
        total_sections=total,
    )
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(
            db,
            "interview",
            [Message("user", prompt)],
            project=p,
            user_id=user_id,
            max_tokens=2500,
            temperature=0.4,
            json_mode=True,
        )
    data = extract_json(result.text)
    data["created_at"] = _now()
    data["tokens_in"] = result.usage.input_tokens
    data["tokens_out"] = result.usage.output_tokens
    storage.write_text(root / "inputs" / "venues.json", json.dumps(data, indent=2, ensure_ascii=False))
    storage.git_commit(root, "Venue suggestions")
    return data
