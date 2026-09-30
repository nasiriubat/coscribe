"""arXiv: metadata, LaTeX source, PDF fallback.

arXiv's terms ask for one request every three seconds and answer bursts with 406 or
429. All calls go through a process-wide pacing lock plus a patient retry, and metadata
falls back to the abstract page's citation tags when the API is unhappy.
"""

from __future__ import annotations

import asyncio
import gzip
import html
import io
import re
import tarfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import httpx

ARXIV_ID = re.compile(
    r"(?:arxiv\.org/(?:abs|pdf|e-print)/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)", re.I
)
_NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
_UA = "coscribe/0.1 (self-hosted research tool; contact: admin)"

_MIN_INTERVAL = 3.1  # seconds between requests to arXiv, per their usage policy
_pace_lock = asyncio.Lock()
_last_call = 0.0


def parse_arxiv_id(text: str) -> str | None:
    text = text.strip()
    m = ARXIV_ID.search(text)
    if not m:
        return None
    return m.group(1).replace(".pdf", "")


@dataclass
class ArxivMeta:
    id: str
    title: str
    authors: list[str]
    abstract: str
    published: str
    updated: str
    categories: list[str] = field(default_factory=list)
    comment: str | None = None
    journal_ref: str | None = None
    doi: str | None = None

    @property
    def year(self) -> int | None:
        return int(self.published[:4]) if self.published else None


async def _paced_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict | None = None,
    timeout: float = 60,
    delays: tuple[float, ...] = (0, 4, 10, 20),
) -> httpx.Response:
    """GET with global pacing and retries on 406/429/5xx. Search passes one attempt: it can do without arXiv."""
    global _last_call
    last: Exception | None = None
    for delay in delays:
        if delay:
            await asyncio.sleep(delay)
        async with _pace_lock:
            wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            _last_call = time.monotonic()
        try:
            r = await client.get(url, params=params, timeout=timeout, follow_redirects=True)
        except httpx.TransportError as e:
            last = e
            continue
        if r.status_code in (406, 429, 500, 502, 503, 504):
            last = httpx.HTTPStatusError(f"{r.status_code} from arXiv", request=r.request, response=r)
            continue
        r.raise_for_status()
        return r
    raise last or RuntimeError("arXiv request failed")


def _parse_api(xml_text: str, arxiv_id: str) -> ArxivMeta:
    root = ET.fromstring(xml_text)
    entry = root.find("a:entry", _NS)
    if entry is None or entry.find("a:title", _NS) is None:
        raise ValueError(f"arXiv has no entry for {arxiv_id}")
    title = re.sub(r"\s+", " ", entry.findtext("a:title", "", _NS)).strip()
    if title.lower() == "error":
        raise ValueError(f"arXiv returned an error for {arxiv_id}")
    return ArxivMeta(
        id=arxiv_id,
        title=title,
        authors=[a.findtext("a:name", "", _NS).strip() for a in entry.findall("a:author", _NS)],
        abstract=re.sub(r"\s+", " ", entry.findtext("a:summary", "", _NS)).strip(),
        published=entry.findtext("a:published", "", _NS),
        updated=entry.findtext("a:updated", "", _NS),
        categories=[c.attrib.get("term", "") for c in entry.findall("a:category", _NS)],
        comment=entry.findtext("arxiv:comment", None, _NS),
        journal_ref=entry.findtext("arxiv:journal_ref", None, _NS),
        doi=entry.findtext("arxiv:doi", None, _NS),
    )


def _parse_abs_page(page: str, arxiv_id: str) -> ArxivMeta:
    """Fallback: the abstract page carries Highwire citation_* meta tags."""

    def tags(name: str) -> list[str]:
        return [html.unescape(m) for m in re.findall(rf'<meta name="{name}" content="([^"]*)"', page)]

    title = (tags("citation_title") or [""])[0].strip()
    if not title:
        raise ValueError(f"Could not read metadata for {arxiv_id}")
    authors = [" ".join(reversed(a.split(", ", 1))) if ", " in a else a for a in tags("citation_author")]
    date = (tags("citation_date") or [""])[0].replace("/", "-")
    abstract = ""
    m = re.search(
        r'<blockquote class="abstract[^"]*">\s*(?:<span[^>]*>Abstract:</span>)?\s*(.*?)</blockquote>', page, re.DOTALL
    )
    if m:
        abstract = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", m.group(1)))).strip()
    return ArxivMeta(id=arxiv_id, title=title, authors=authors, abstract=abstract, published=date, updated=date)


async def fetch_meta(arxiv_id: str, client: httpx.AsyncClient) -> ArxivMeta:
    try:
        r = await _paced_get(client, "https://export.arxiv.org/api/query", params={"id_list": arxiv_id}, timeout=30)
        return _parse_api(r.text, arxiv_id)
    except (httpx.HTTPError, ET.ParseError):
        r = await _paced_get(client, f"https://arxiv.org/abs/{arxiv_id}", timeout=30)
        return _parse_abs_page(r.text, arxiv_id)


async def fetch_source(arxiv_id: str, dest: Path, client: httpx.AsyncClient) -> str:
    """Download the e-print into dest. Returns 'latex' when a .tex tree was unpacked, 'pdf' otherwise.

    arXiv serves either a gzipped tarball, a single gzipped .tex, or a PDF when no
    source is available.
    """
    r = await _paced_get(client, f"https://arxiv.org/e-print/{arxiv_id}", timeout=120)
    data = r.content
    dest.mkdir(parents=True, exist_ok=True)
    ctype = r.headers.get("content-type", "")

    if data[:4] == b"%PDF" or "pdf" in ctype:
        (dest / "source.pdf").write_bytes(data)
        return "pdf"

    try:
        raw = gzip.decompress(data)
    except OSError:
        raw = data

    if raw[:4] == b"%PDF":
        (dest / "source.pdf").write_bytes(raw)
        return "pdf"

    src_dir = dest / "src"
    src_dir.mkdir(exist_ok=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tar:
            _safe_extract(tar, src_dir)
        return "latex"
    except tarfile.TarError:
        pass
    # single .tex file
    (src_dir / "main.tex").write_bytes(raw)
    return "latex"


def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    dest_resolved = dest.resolve()
    for member in tar.getmembers():
        if member.issym() or member.islnk():
            continue
        target = (dest / member.name).resolve()
        if dest_resolved not in target.parents and target != dest_resolved:
            continue
        if member.size > 50 * 1024 * 1024:
            continue
        tar.extract(member, dest, filter="data")


async def fetch_pdf(arxiv_id: str, dest: Path, client: httpx.AsyncClient) -> Path:
    r = await _paced_get(client, f"https://arxiv.org/pdf/{arxiv_id}", timeout=120)
    dest.mkdir(parents=True, exist_ok=True)
    p = dest / "source.pdf"
    p.write_bytes(r.content)
    return p


def make_client() -> httpx.AsyncClient:
    # arXiv's edge answers 406 to some clients when they advertise gzip; identity encoding is reliable.
    return httpx.AsyncClient(
        headers={"User-Agent": _UA, "Accept": "*/*", "Accept-Encoding": "identity"}, follow_redirects=True
    )
