"""Research design, interview rounds, side chat, facts and outline (SPEC 4.2.1, 4.3, 4.5).

State lives in the project folder:
    inputs/idea.md            free text idea (user-written)
    inputs/research-plan.md   generated plan (editable)
    inputs/interview.json     rounds, questions, answers, pinned notes
    inputs/interview.md       rendered from interview.json on every save
    inputs/chat.json          side chat transcript
    inputs/facts.md           extracted facts
    outline.md                generated outline (editable)
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path

from .. import storage
from ..db import SessionLocal
from ..figures import tables
from ..jobs import JobContext
from ..kinds import kind_exists, kind_name, read_kind
from ..learn.context import budget_markdown, render
from ..llm.base import Message
from ..llm.jsonio import extract_json
from ..llm.registry import complete
from ..models import Project
from ..refs.scan import load_scan

MAX_ROUNDS = 8


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _strip_fences(text: str) -> str:
    """Models sometimes wrap Markdown in ```markdown fences. Remove one outer fence pair."""
    t = text.strip()
    m = re.fullmatch(r"```[a-zA-Z]*\n(.*?)\n```", t, re.DOTALL)
    return (m.group(1) if m else t).strip()


def _proj(project_id: str) -> tuple[Project, Path]:
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        if not p:
            raise ValueError("Project not found")
        db.expunge(p)
    return p, storage.project_dir(p.slug)


def _set_stage(project_id: str, stage: str, only_if_in: tuple[str, ...] | None = None) -> None:
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        if p and (only_if_in is None or p.stage in only_if_in):
            p.stage = stage
            db.commit()


def _kind_files(kind: str) -> dict[str, str]:
    if kind_exists(kind):
        return read_kind(kind)["files"]
    return {}


# ------------------------------------------------------------------ interview state


def load_interview(root: Path) -> dict:
    p = root / "inputs" / "interview.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"rounds": [], "notes": [], "updated_at": None}


def render_interview_md(state: dict) -> str:
    out = ["# Interview\n"]
    for r in state.get("rounds", []):
        out.append(f"\n## Round {r['index']}: {r['title']}\n")
        for q in r.get("questions", []):
            if q.get("status") == "na":
                out.append(f"\n**Q:** {q['question']}\n\n**A:** Not applicable.\n")
            elif q.get("answer", "").strip():
                out.append(f"\n**Q:** {q['question']}\n\n**A:** {q['answer'].strip()}\n")
    if state.get("notes"):
        out.append("\n## Notes pinned from chat (unverified: the author's thinking, not evidence)\n")
        for n in state["notes"]:
            out.append(f"\n- (unverified) {n['text']}\n")
    return "".join(out).strip() + "\n"


def save_interview(root: Path, state: dict, message: str) -> None:
    state["updated_at"] = _now()
    storage.write_text(root / "inputs" / "interview.json", json.dumps(state, indent=2, ensure_ascii=False))
    storage.write_text(root / "inputs" / "interview.md", render_interview_md(state))
    storage.git_commit(root, message)


def apply_answers(root: Path, answers: list[dict]) -> dict:
    state = load_interview(root)
    by_id = {q["id"]: q for r in state["rounds"] for q in r["questions"]}
    changed = 0
    for a in answers:
        q = by_id.get(a.get("id"))
        if not q:
            continue
        if "answer" in a and a["answer"] is not None:
            q["answer"] = str(a["answer"])[:8000]
        status = a.get("status")
        if status in ("open", "answered", "na"):
            q["status"] = status
        elif q.get("answer", "").strip():
            q["status"] = "answered"
        changed += 1
    if not changed:
        raise ValueError("None of the answer ids match a question in this interview")
    save_interview(root, state, f"Interview: {changed} answer(s)")
    return state


def pin_note(root: Path, text: str) -> dict:
    state = load_interview(root)
    note = {"id": secrets.token_hex(4), "text": text.strip()[:2000], "at": _now(), "unverified": True}
    state.setdefault("notes", []).append(note)
    save_interview(root, state, "Interview: pin note from chat")
    return state


def _previous_rounds_text(state: dict) -> str:
    parts = []
    for r in state.get("rounds", []):
        parts.append(f"Round {r['index']}: {r['title']}")
        for q in r["questions"]:
            ans = "NOT APPLICABLE" if q.get("status") == "na" else (q.get("answer", "").strip() or "(unanswered)")
            parts.append(f"  Q: {q['question']}\n  A: {ans}")
    for n in state.get("notes", []):
        parts.append(f"Pinned note (unverified, from chat): {n['text']}")
    return "\n".join(parts)


def scan_summary(root: Path, limit: int = 8) -> str:
    """Top scan candidates as short lines for prompts. Empty when no scan has run."""
    data = load_scan(root)
    if not data or not data.get("candidates"):
        return ""
    lines = []
    for c in data["candidates"][:limit]:
        who = ", ".join(c.get("authors") or [])[:80]
        why = (c.get("why") or "").strip()
        abstract = (c.get("abstract") or "").strip().replace("\n", " ")[:300]
        lines.append(f"- “{c.get('title', '').strip()}” ({who}{', ' if who else ''}{c.get('year') or 'n.d.'})")
        if why:
            lines.append(f"  why it may matter: {why}")
        if abstract:
            lines.append(f"  abstract: {abstract}")
    return "\n".join(lines)


async def generate_round(project_id: str, ctx: JobContext) -> dict:
    project, root = _proj(project_id)
    state = load_interview(root)
    if len(state["rounds"]) >= MAX_ROUNDS:
        raise ValueError(f"Already {MAX_ROUNDS} rounds. Answer or close the open ones instead of adding more.")
    kfiles = _kind_files(project.kind)
    kname = kind_name(project.kind) if kind_exists(project.kind) else project.kind
    inputs = root / "inputs"
    playbook = "\n\n".join(
        storage.read_text(root / "playbook" / f) for f in ("argumentation.md", "evaluation.md", "structure.md")
    )
    ctx.progress(10, "Reading the specification and earlier answers")
    prompt = render(
        "interview_round.j2",
        kind_name=kname,
        entry=project.entry or "built",
        spec=budget_markdown(storage.read_text(inputs / "system-spec.md"), 14_000),
        plan=budget_markdown(storage.read_text(inputs / "research-plan.md"), 6_000),
        kind_rounds=kfiles.get("interview.md", "(no rounds defined for this kind)"),
        playbook=budget_markdown(playbook, 7_000),
        previous=_previous_rounds_text(state)[:12_000],
        scan=scan_summary(root),
    )
    ctx.progress(30, "Asking the model for the next round")
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(
            db,
            "interview",
            [Message("user", prompt)],
            project=p,
            user_id=ctx.user_id,
            max_tokens=2500,
            temperature=0.4,
            json_mode=True,
        )
    data = extract_json(result.text)
    if data.get("done") or not data.get("questions"):
        state["done"] = True
        save_interview(root, state, "Interview: complete")
        ctx.progress(100, "Nothing left to ask. The interview is complete.")
        return {"done": True, "tokens_in": result.usage.input_tokens, "tokens_out": result.usage.output_tokens}
    idx = len(state["rounds"]) + 1
    questions = []
    for q in data["questions"][:6]:
        questions.append(
            {
                "id": f"r{idx}q{len(questions) + 1}-{secrets.token_hex(2)}",
                "question": str(q.get("question", "")).strip(),
                "why": str(q.get("why", "")).strip(),
                "suggested": str(q.get("suggested", "")).strip(),
                "confidence": q.get("confidence", "low") if q.get("confidence") in ("low", "medium", "high") else "low",
                "answer": "",
                "status": "open",
            }
        )
    state["rounds"].append(
        {
            "index": idx,
            "title": str(data.get("round_title", f"Round {idx}")).strip()[:120],
            "rationale": str(data.get("rationale", "")).strip(),
            "questions": questions,
            "created_at": _now(),
        }
    )
    state["done"] = False
    save_interview(root, state, f"Interview: round {idx} generated")
    _set_stage(project_id, "interview", only_if_in=("setup", "sources", "playbook"))
    ctx.progress(100, f"Round {idx}: {len(questions)} questions")
    return {
        "round": idx,
        "questions": len(questions),
        "tokens_in": result.usage.input_tokens,
        "tokens_out": result.usage.output_tokens,
    }


# ------------------------------------------------------------------ research plan


async def generate_plan(project_id: str, ctx: JobContext, *, mode: str) -> dict:
    project, root = _proj(project_id)
    inputs = root / "inputs"
    idea = storage.read_text(inputs / "idea.md")
    if not idea.strip():
        raise ValueError("Write your idea first, then generate the plan.")
    kfiles = _kind_files(project.kind)
    kname = kind_name(project.kind) if kind_exists(project.kind) else project.kind
    ctx.progress(15, "Designing the study")
    prompt = render(
        "research_plan.j2",
        kind_name=kname,
        mode=mode,
        kind_notes=kfiles.get("kind.md", ""),
        checklist=kfiles.get("checklist.md", ""),
        playbook_eval=budget_markdown(storage.read_text(root / "playbook" / "evaluation.md"), 4_000),
        idea=idea[:12_000],
        spec=budget_markdown(storage.read_text(inputs / "system-spec.md"), 8_000),
    )
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(
            db, "interview", [Message("user", prompt)], project=p, user_id=ctx.user_id, max_tokens=3500, temperature=0.5
        )
    storage.write_text(inputs / "research-plan.md", _strip_fences(result.text) + "\n")
    storage.git_commit(root, f"Research plan generated ({mode})")
    ctx.progress(100, "Research plan written")
    return {"mode": mode, "tokens_in": result.usage.input_tokens, "tokens_out": result.usage.output_tokens}


# ------------------------------------------------------------------ facts and outline


async def extract_facts(project_id: str, ctx: JobContext | None = None) -> dict:
    _, root = _proj(project_id)
    inputs = root / "inputs"
    prompt = render(
        "facts.j2",
        spec=budget_markdown(storage.read_text(inputs / "system-spec.md"), 14_000),
        plan=budget_markdown(storage.read_text(inputs / "research-plan.md"), 5_000),
        interview=storage.read_text(inputs / "interview.md")[:14_000],
        results=tables.prompt_block(root),
    )
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(
            db,
            "utility",
            [Message("user", prompt)],
            project=p,
            user_id=ctx.user_id if ctx else None,
            max_tokens=2000,
            temperature=0.1,
        )
    storage.write_text(inputs / "facts.md", _strip_fences(result.text) + "\n")
    return {"tokens_in": result.usage.input_tokens, "tokens_out": result.usage.output_tokens}


def _target_words(root: Path, kfiles: dict) -> int:
    text = storage.read_text(root / "playbook" / "venue.md") + storage.read_text(root / "playbook" / "structure.md")
    m = re.search(r"(\d{1,2})\s*(?:\u2013|-|to)\s*(\d{1,2})\s*pages", text)
    if m:
        pages = (int(m.group(1)) + int(m.group(2))) / 2
        return int(pages * 550)
    m = re.search(r"(\d{1,2})\s*pages", text + kfiles.get("sections.md", ""))
    if m:
        return int(int(m.group(1)) * 550)
    return 5000


async def generate_outline(project_id: str, ctx: JobContext) -> dict:
    project, root = _proj(project_id)
    inputs = root / "inputs"
    if not storage.read_text(inputs / "system-spec.md").strip():
        raise ValueError("Write the system specification before outlining.")
    kfiles = _kind_files(project.kind)
    kname = kind_name(project.kind) if kind_exists(project.kind) else project.kind
    ctx.progress(10, "Extracting facts from the spec and interview")
    facts_usage = await extract_facts(project_id, ctx)
    ctx.progress(45, "Building the outline")
    prompt = render(
        "outline.j2",
        kind_name=kname,
        title=project.title,
        target_words=_target_words(root, kfiles),
        structure=budget_markdown(storage.read_text(root / "playbook" / "structure.md"), 6_000),
        kind_sections=kfiles.get("sections.md", ""),
        spec=budget_markdown(storage.read_text(inputs / "system-spec.md"), 12_000),
        plan=budget_markdown(storage.read_text(inputs / "research-plan.md"), 5_000),
        interview=storage.read_text(inputs / "interview.md")[:14_000],
        facts=storage.read_text(inputs / "facts.md")[:6_000],
    )
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(
            db, "interview", [Message("user", prompt)], project=p, user_id=ctx.user_id, max_tokens=3500, temperature=0.3
        )
    storage.write_text(root / "outline.md", _strip_fences(result.text) + "\n")
    storage.git_commit(root, "Outline generated")
    body = result.text.split("## Open items")[0]
    needs = len(re.findall(r"\[NEEDS:", body))
    ctx.progress(100, f"Outline written with {needs} open item(s)")
    return {
        "open_items": needs,
        "tokens_in": result.usage.input_tokens + facts_usage["tokens_in"],
        "tokens_out": result.usage.output_tokens + facts_usage["tokens_out"],
    }


# ------------------------------------------------------------------ side chat


def load_chat(root: Path) -> list[dict]:
    p = root / "inputs" / "chat.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return []


def save_chat(root: Path, messages: list[dict]) -> None:
    storage.write_text(root / "inputs" / "chat.json", json.dumps(messages[-200:], indent=2, ensure_ascii=False))


async def chat_reply(project_id: str, user_id: str, text: str) -> dict:
    project, root = _proj(project_id)
    inputs = root / "inputs"
    kname = kind_name(project.kind) if kind_exists(project.kind) else project.kind
    history = load_chat(root)
    user_msg = {"id": secrets.token_hex(4), "role": "user", "content": text.strip()[:6000], "at": _now()}
    history.append(user_msg)
    system = render(
        "chat_system.j2",
        kind_name=kname,
        title=project.title,
        spec=budget_markdown(storage.read_text(inputs / "system-spec.md"), 8_000),
        plan=budget_markdown(storage.read_text(inputs / "research-plan.md"), 4_000),
        interview=storage.read_text(inputs / "interview.md")[:8_000],
        scan=scan_summary(root, limit=12),
    )
    msgs = [Message("system", system)] + [Message(m["role"], m["content"]) for m in history[-12:]]
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        result = await complete(db, "interview", msgs, project=p, user_id=user_id, max_tokens=900, temperature=0.6)
    reply_text = result.text.strip()
    pin = None
    m = re.search(r"^PIN:\s*(.+)$", reply_text, re.MULTILINE)
    if m:
        pin = m.group(1).strip()
        reply_text = reply_text[: m.start()].rstrip()
    reply = {"id": secrets.token_hex(4), "role": "assistant", "content": reply_text, "pin": pin, "at": _now()}
    history.append(reply)
    save_chat(root, history)
    return {"message": user_msg, "reply": reply}
