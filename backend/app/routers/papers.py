"""Exemplars (project) and sources (author profile): ingest, list, read, delete, learn."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import storage
from ..config import get_settings
from ..db import get_db
from ..deps import current_user
from ..ingest import service as ingest
from ..ingest.arxiv import parse_arxiv_id
from ..jobs import create_job, job_dict, start_job
from ..learn import service as learn
from ..models import User
from ..security import llm_limiter
from .profiles import get_visible, require_owner
from .projects import get_owned

router = APIRouter(prefix="/api", tags=["papers"])

MAX_PDF_BYTES = 40 * 1024 * 1024


class ArxivIn(BaseModel):
    ref: str = Field(min_length=3, max_length=200, description="arXiv id or URL")


class LearnIn(BaseModel):
    max_chars_per_paper: int | None = Field(default=None, ge=2000, le=400_000)


def _learn_budget(body: LearnIn | None) -> int:
    return body.max_chars_per_paper if body and body.max_chars_per_paper else get_settings().learn_max_chars_per_paper


async def _read_pdf(file: UploadFile) -> bytes:
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted here")
    data = await file.read()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(413, "PDF larger than 40 MB")
    if data[:4] != b"%PDF":
        raise HTTPException(400, "That file is not a PDF")
    return data


# ------------------------------------------------------------------ project exemplars


@router.get("/projects/{slug}/exemplars")
def list_exemplars(slug: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_owned(db, user, slug)
    return ingest.list_papers(storage.project_dir(p.slug) / "exemplars")


@router.get("/projects/{slug}/exemplars/{paper_id}")
def get_exemplar(slug: str, paper_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_owned(db, user, slug)
    r = ingest.read_paper(storage.project_dir(p.slug) / "exemplars", paper_id)
    if not r:
        raise HTTPException(404, "Exemplar not found")
    meta, md = r
    summary = None
    sp = storage.project_dir(p.slug) / "exemplars" / paper_id / "summary.json"
    if sp.exists():
        summary = sp.read_text(encoding="utf-8")
    return {"meta": meta, "markdown": md, "summary": summary}


def start_exemplar_ingest(db: Session, user: User, project, arxiv_id: str) -> dict:
    """Queue an arXiv paper as a project exemplar. Shared with the literature scan."""
    root = storage.project_dir(project.slug) / "exemplars"
    job = create_job(db, user_id=user.id, type="ingest_arxiv", project_id=project.id, message=f"Queued {arxiv_id}")
    start_job(job, lambda ctx: ingest.ingest_arxiv(root, arxiv_id, ctx))
    return job_dict(job)


def start_exemplar_pdf_ingest(db: Session, user: User, project, url: str, title: str = "") -> dict:
    """Queue an open-access PDF as a project exemplar."""
    root = storage.project_dir(project.slug) / "exemplars"
    job = create_job(
        db, user_id=user.id, type="ingest_pdf", project_id=project.id, message=f"Queued {title or url}"[:200]
    )
    start_job(job, lambda ctx: ingest.ingest_pdf_url(root, url, ctx, title))
    return job_dict(job)


@router.post("/projects/{slug}/exemplars/arxiv", status_code=202)
async def add_exemplar_arxiv(
    slug: str, body: ArxivIn, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    p = get_owned(db, user, slug)
    aid = parse_arxiv_id(body.ref)
    if not aid:
        raise HTTPException(400, "That does not look like an arXiv id or URL")
    return start_exemplar_ingest(db, user, p, aid)


@router.post("/projects/{slug}/exemplars/{paper_id}/cite", status_code=201)
def cite_exemplar(slug: str, paper_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Make an exemplar citable: its metadata becomes a verified reference record."""
    from ..ingest import extract as ingest_extract
    from ..refs import scan
    from ..refs import service as refs

    p = get_owned(db, user, slug)
    root = storage.project_dir(p.slug)
    try:
        folder = storage.safe_child(root / "exemplars", paper_id)
    except ValueError as e:
        raise HTTPException(400, "Bad paper id") from e
    meta = ingest_extract.read_meta(folder) if folder.is_dir() else None
    if not meta or meta.get("status") != "ready":
        raise HTTPException(404, "Exemplar not found or not extracted yet")
    cand = scan.candidate_from_meta(meta)
    existing = scan.existing_key_for(root, cand)
    if existing:
        return {"key": existing, "existing": True}
    try:
        rec = refs.accept(root, cand)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"key": rec["key"], "existing": False}


@router.post("/projects/{slug}/exemplars/upload", status_code=202)
async def add_exemplar_pdf(
    slug: str, file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)
):
    p = get_owned(db, user, slug)
    data = await _read_pdf(file)
    root = storage.project_dir(p.slug) / "exemplars"
    job = create_job(db, user_id=user.id, type="ingest_pdf", project_id=p.id, message=f"Queued {file.filename}")
    start_job(job, lambda ctx: ingest.ingest_pdf(root, data, file.filename or "paper.pdf", ctx))
    return job_dict(job)


@router.delete("/projects/{slug}/exemplars/{paper_id}", status_code=204)
def delete_exemplar(slug: str, paper_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_owned(db, user, slug)
    if not ingest.delete_paper(storage.project_dir(p.slug) / "exemplars", paper_id):
        raise HTTPException(404, "Exemplar not found")
    storage.git_commit(storage.project_dir(p.slug), f"Remove exemplar {paper_id}")


@router.post("/projects/{slug}/learn", status_code=202)
async def learn_playbook(
    slug: str, body: LearnIn | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    p = get_owned(db, user, slug)
    if not llm_limiter.allow(user.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Slow down")
    budget = _learn_budget(body)
    job = create_job(db, user_id=user.id, type="learn_playbook", project_id=p.id, message="Queued")
    start_job(
        job,
        lambda ctx: learn.learn_playbook(
            p.id, ctx, max_chars_per_paper=budget, concurrency=get_settings().learn_concurrency
        ),
    )
    return job_dict(job)


# ------------------------------------------------------------------ profile sources


@router.get("/profiles/{slug}/sources")
def list_sources(slug: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_visible(db, user, slug)
    return ingest.list_papers(storage.profile_dir(p.slug) / "sources")


@router.post("/profiles/{slug}/sources/arxiv", status_code=202)
async def add_source_arxiv(slug: str, body: ArxivIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_visible(db, user, slug)
    require_owner(p, user)
    aid = parse_arxiv_id(body.ref)
    if not aid:
        raise HTTPException(400, "That does not look like an arXiv id or URL")
    root = storage.profile_dir(p.slug) / "sources"
    job = create_job(db, user_id=user.id, type="ingest_arxiv", profile_id=p.id, message=f"Queued {aid}")
    start_job(job, lambda ctx: ingest.ingest_arxiv(root, aid, ctx))
    return job_dict(job)


@router.post("/profiles/{slug}/sources/upload", status_code=202)
async def add_source_pdf(
    slug: str, file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)
):
    p = get_visible(db, user, slug)
    require_owner(p, user)
    data = await _read_pdf(file)
    root = storage.profile_dir(p.slug) / "sources"
    job = create_job(db, user_id=user.id, type="ingest_pdf", profile_id=p.id, message=f"Queued {file.filename}")
    start_job(job, lambda ctx: ingest.ingest_pdf(root, data, file.filename or "paper.pdf", ctx))
    return job_dict(job)


@router.delete("/profiles/{slug}/sources/{paper_id}", status_code=204)
def delete_source(slug: str, paper_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_visible(db, user, slug)
    require_owner(p, user)
    if not ingest.delete_paper(storage.profile_dir(p.slug) / "sources", paper_id):
        raise HTTPException(404, "Source not found")
    storage.git_commit(storage.profile_dir(p.slug), f"Remove source {paper_id}")


@router.post("/profiles/{slug}/learn", status_code=202)
async def learn_voice(
    slug: str, body: LearnIn | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    p = get_visible(db, user, slug)
    require_owner(p, user)
    if not llm_limiter.allow(user.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Slow down")
    budget = _learn_budget(body)
    job = create_job(db, user_id=user.id, type="learn_profile", profile_id=p.id, message="Queued")
    profile_id, concurrency = p.id, get_settings().learn_concurrency

    async def run(ctx):
        try:
            return await learn.learn_profile(profile_id, ctx, max_chars_per_paper=budget, concurrency=concurrency)
        except BaseException:  # includes a Cancel from the UI
            learn.settle_profile_status(profile_id)
            raise

    start_job(job, run)
    return job_dict(job)
