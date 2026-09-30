"""Ingest orchestration: one folder per paper under a root (project exemplars/ or profile sources/)."""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import shutil
from pathlib import Path

from ..jobs import JobContext
from . import arxiv as arxiv_mod
from . import extract

FOLDER_RE = re.compile(r"^[a-z0-9][a-z0-9\-_.]{0,80}$")


def folder_for_arxiv(arxiv_id: str) -> str:
    return "arxiv-" + re.sub(r"[^a-z0-9]+", "-", arxiv_id.lower()).strip("-")


def list_papers(root: Path) -> list[dict]:
    out = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        meta = extract.read_meta(d) or {"id": d.name, "title": d.name, "status": "pending"}
        meta["id"] = d.name
        meta.pop("sections", None)  # keep list responses light
        out.append(meta)
    return out


def _write_pending(folder: Path, meta: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps({**meta, "status": "pending"}, indent=2), encoding="utf-8")


def _write_failed(folder: Path, error: str) -> None:
    meta = extract.read_meta(folder) or {}
    meta["status"] = "failed"
    meta["error"] = error[:1000]
    (folder / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


async def ingest_arxiv(root: Path, arxiv_id: str, ctx: JobContext) -> dict:
    folder = root / folder_for_arxiv(arxiv_id)
    if folder.exists():
        shutil.rmtree(folder)
    _write_pending(folder, {"id": folder.name, "arxiv_id": arxiv_id, "title": arxiv_id})
    try:
        async with arxiv_mod.make_client() as client:
            ctx.progress(5, f"Fetching metadata for {arxiv_id}")
            meta_obj = await arxiv_mod.fetch_meta(arxiv_id, client)
            meta = {
                "id": folder.name,
                "arxiv_id": arxiv_id,
                "title": meta_obj.title,
                "authors": meta_obj.authors,
                "year": meta_obj.year,
                "abstract": meta_obj.abstract,
                "categories": meta_obj.categories,
                "comment": meta_obj.comment,
                "journal_ref": meta_obj.journal_ref,
                "doi": meta_obj.doi,
                "url": f"https://arxiv.org/abs/{arxiv_id}",
            }
            _write_pending(folder, meta)
            ctx.progress(20, "Downloading source")
            kind = await arxiv_mod.fetch_source(arxiv_id, folder, client)
            if kind == "latex":
                ctx.progress(55, "Converting LaTeX to Markdown")
                try:
                    result = await asyncio.to_thread(extract.extract_latex_tree, folder, meta)
                except ValueError:
                    ctx.progress(60, "No usable LaTeX, falling back to PDF")
                    pdf = await arxiv_mod.fetch_pdf(arxiv_id, folder, client)
                    result = await asyncio.to_thread(extract.extract_pdf, folder, pdf, {**meta, "source": "arxiv-pdf"})
            else:
                ctx.progress(55, "Extracting text from PDF")
                result = await asyncio.to_thread(
                    extract.extract_pdf, folder, folder / "source.pdf", {**meta, "source": "arxiv-pdf"}
                )
        ctx.progress(100, f"Ingested {result['title'][:80]}")
        return {
            "id": folder.name,
            "title": result["title"],
            "word_count": result["word_count"],
            "source": result["source"],
        }
    except asyncio.CancelledError:
        shutil.rmtree(folder, ignore_errors=True)  # a stopped ingest leaves no half-read paper behind
        raise
    except Exception as e:
        _write_failed(folder, f"{type(e).__name__}: {e}")
        raise


async def ingest_pdf(root: Path, data: bytes, filename: str, ctx: JobContext) -> dict:
    stem = re.sub(r"[^a-z0-9]+", "-", Path(filename).stem.lower()).strip("-")[:40] or "paper"
    folder = root / f"pdf-{stem}-{secrets.token_hex(3)}"
    _write_pending(folder, {"id": folder.name, "title": Path(filename).stem, "filename": filename})
    try:
        pdf = folder / "source.pdf"
        pdf.write_bytes(data)
        ctx.progress(20, "Extracting text and layout from PDF")
        result = await asyncio.to_thread(
            extract.extract_pdf, folder, pdf, {"id": folder.name, "filename": filename, "source": "pdf"}
        )
        ctx.progress(100, f"Ingested {result['title'][:80]}")
        return {"id": folder.name, "title": result["title"], "word_count": result["word_count"], "source": "pdf"}
    except asyncio.CancelledError:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    except Exception as e:
        _write_failed(folder, f"{type(e).__name__}: {e}")
        raise


def delete_paper(root: Path, paper_id: str) -> bool:
    if not FOLDER_RE.match(paper_id):
        return False
    folder = (root / paper_id).resolve()
    if root.resolve() not in folder.parents or not folder.is_dir():
        return False
    shutil.rmtree(folder)
    return True


def read_paper(root: Path, paper_id: str) -> tuple[dict, str] | None:
    if not FOLDER_RE.match(paper_id):
        return None
    folder = root / paper_id
    meta = extract.read_meta(folder)
    if not meta:
        return None
    md = (folder / "extracted.md").read_text(encoding="utf-8") if (folder / "extracted.md").exists() else ""
    return meta, md


async def ingest_pdf_url(root: Path, url: str, ctx: JobContext, title: str = "") -> dict:
    """Download an open-access PDF and ingest it like an upload. Used when the literature scan
    finds a paper that is not on arXiv but has a public PDF."""
    import httpx

    from ..net import assert_public_url

    ctx.progress(3, f"Downloading {url[:80]}")
    # SSRF guard: validate the target and every redirect hop is a public address before
    # connecting, so an index-supplied pdf_url cannot point the server at an internal host.
    assert_public_url(url)
    async with httpx.AsyncClient(follow_redirects=False, timeout=60, headers={"User-Agent": "coscribe/0.1"}) as client:
        r = await client.get(url)
        hops = 0
        while r.is_redirect and r.next_request is not None:
            if hops >= 5:
                raise ValueError("Too many redirects while downloading the PDF.")
            assert_public_url(str(r.next_request.url))
            r = await client.send(r.next_request)
            hops += 1
    r.raise_for_status()
    data = r.content
    if len(data) > 40 * 1024 * 1024:
        raise ValueError("PDF larger than 40 MB")
    if data[:5] != b"%PDF-":
        raise ValueError("The link did not return a PDF; the publisher may require a login. Upload the file instead.")
    name = re.sub(r"[^A-Za-z0-9]+", "-", title or url.rsplit("/", 1)[-1])[:60].strip("-") or "paper"
    return await ingest_pdf(root, data, f"{name}.pdf", ctx)
