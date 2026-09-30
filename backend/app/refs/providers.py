"""Academic search: Semantic Scholar, OpenAlex, arXiv. Free, structured, no keys required.

Each provider returns normalized candidate records. Results are merged and deduplicated
by DOI, then by normalized title.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field

import httpx

from ..config import get_settings
from ..ingest.arxiv import _paced_get

_UA = "coscribe/0.1 (self-hosted research tool; contact: admin)"
_NS = {"a": "http://www.w3.org/2005/Atom"}


@dataclass
class Candidate:
    title: str
    authors: list[str]
    year: int | None
    venue: str | None = None
    doi: str | None = None
    url: str | None = None
    arxiv_id: str | None = None
    pdf_url: str | None = None  # open-access PDF when the index knows one
    abstract: str | None = None
    citation_count: int | None = None
    source: str = ""
    sources: list[str] = field(default_factory=list)
    bibtype: str = "misc"
    score: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def _clean_abstract(s: str | None) -> str | None:
    if not s:
        return None
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()[:1500]


# ------------------------------------------------------------------ providers


async def semantic_scholar(client: httpx.AsyncClient, q: str, limit: int) -> list[Candidate]:
    headers = {}
    key = get_settings().semantic_scholar_api_key
    if key:
        headers["x-api-key"] = key
    params = {
        "query": q,
        "limit": limit,
        "fields": "title,authors,year,venue,externalIds,abstract,citationCount,url,publicationTypes",
    }
    r = await client.get(
        "https://api.semanticscholar.org/graph/v1/paper/search", params=params, headers=headers, timeout=12
    )
    if r.status_code == 429:
        # Unauthenticated quota is shared by everyone; one patient retry usually gets through.
        await asyncio.sleep(3)
        r = await client.get(
            "https://api.semanticscholar.org/graph/v1/paper/search", params=params, headers=headers, timeout=12
        )
    r.raise_for_status()
    out = []
    for i, p in enumerate(r.json().get("data", [])):
        ext = p.get("externalIds") or {}
        types = p.get("publicationTypes") or []
        bibtype = "article" if "JournalArticle" in types else "inproceedings" if "Conference" in types else "misc"
        out.append(
            Candidate(
                title=p.get("title") or "",
                authors=[a.get("name", "") for a in p.get("authors") or []],
                year=p.get("year"),
                venue=p.get("venue") or None,
                doi=ext.get("DOI"),
                url=p.get("url"),
                arxiv_id=ext.get("ArXiv"),
                abstract=_clean_abstract(p.get("abstract")),
                citation_count=p.get("citationCount"),
                source="semanticscholar",
                bibtype=bibtype,
                score=1.0 / (i + 1),
            )
        )
    return out


def _openalex_abstract(inv: dict | None) -> str | None:
    if not inv:
        return None
    positions: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        for i in idxs:
            positions.append((i, word))
    positions.sort()
    return _clean_abstract(" ".join(w for _, w in positions))


async def _openalex_works(client: httpx.AsyncClient, terms: str, limit: int) -> list[dict]:
    # OpenAlex's plain `search` matches any word and favours highly cited works, so a query like
    # "CI build failure log analysis" returned XGBoost and mortality studies. The title-and-abstract
    # filter requires every word, which is what a literature search means.
    params = {"filter": f"title_and_abstract.search:{terms}", "per-page": limit, "mailto": "coscribe@example.org"}
    r = await client.get("https://api.openalex.org/works", params=params, timeout=12)
    if r.status_code == 429:
        # OpenAlex's polite pool allows ~10 requests/s; a burst from the scan can trip it.
        await asyncio.sleep(2.5)
        r = await client.get("https://api.openalex.org/works", params=params, timeout=12)
    r.raise_for_status()
    return r.json().get("results", [])


async def openalex(client: httpx.AsyncClient, q: str, limit: int) -> list[Candidate]:
    words = re.findall(r"[\w\-]+", q)  # commas and colons would break the filter syntax
    works = await _openalex_works(client, " ".join(words), limit)
    if len(works) < 3 and len(words) > 3:
        # Every word required can leave almost nothing; the three longest words keep the topic.
        longest = sorted(words, key=len, reverse=True)[:3]
        core = [w for w in words if w in longest][:3]  # in the order the author wrote them
        seen = {w.get("id") for w in works}
        works += [w for w in await _openalex_works(client, " ".join(core), limit) if w.get("id") not in seen]
    out = []
    for i, w in enumerate(works[:limit]):
        ids = w.get("ids") or {}
        doi = (w.get("doi") or "").replace("https://doi.org/", "") or None
        loc = w.get("primary_location") or {}
        src = (loc.get("source") or {}).get("display_name")
        wtype = w.get("type") or ""
        bibtype = "article" if wtype == "article" else "inproceedings" if "proceedings" in wtype else "misc"
        arxiv = None
        pdf_url = None
        locations = [loc, w.get("best_oa_location") or {}, *(w.get("locations") or [])]
        for cand in locations:
            for lid in (cand.get("landing_page_url") or "", cand.get("pdf_url") or ""):
                m = re.search(r"arxiv\.org/(?:abs|pdf)/([\w.\-]+?)(?:v\d+)?(?:\.pdf)?$", lid)
                if m and not arxiv:
                    arxiv = m.group(1)
            if not pdf_url and cand.get("pdf_url") and cand.get("is_oa", True):
                pdf_url = cand["pdf_url"]
        if not pdf_url:
            pdf_url = (w.get("open_access") or {}).get("oa_url") or None
        out.append(
            Candidate(
                title=w.get("display_name") or w.get("title") or "",
                authors=[(a.get("author") or {}).get("display_name", "") for a in w.get("authorships") or []],
                year=w.get("publication_year"),
                venue=src,
                doi=doi,
                url=loc.get("landing_page_url") or ids.get("openalex"),
                arxiv_id=arxiv,
                pdf_url=pdf_url,
                abstract=_openalex_abstract(w.get("abstract_inverted_index")),
                citation_count=w.get("cited_by_count"),
                source="openalex",
                bibtype=bibtype,
                score=1.0 / (i + 1),
            )
        )
    return out


async def arxiv(client: httpx.AsyncClient, q: str, limit: int) -> list[Candidate]:
    terms = " AND ".join(f"all:{t}" for t in re.findall(r"[A-Za-z0-9\-]{3,}", q)[:8]) or f"all:{q}"
    r = await _paced_get(
        client,
        "https://export.arxiv.org/api/query",
        params={"search_query": terms, "max_results": limit},
        timeout=20,
        delays=(0,),
    )
    root = ET.fromstring(r.text)
    out = []
    for i, e in enumerate(root.findall("a:entry", _NS)):
        aid = (e.findtext("a:id", "", _NS) or "").rsplit("/", 1)[-1]
        aid = re.sub(r"v\d+$", "", aid)
        pub = e.findtext("a:published", "", _NS)
        doi = None
        for link in e.findall("a:link", _NS):
            if link.attrib.get("title") == "doi":
                doi = link.attrib.get("href", "").replace("http://dx.doi.org/", "").replace("https://doi.org/", "")
        out.append(
            Candidate(
                title=re.sub(r"\s+", " ", e.findtext("a:title", "", _NS)).strip(),
                authors=[a.findtext("a:name", "", _NS).strip() for a in e.findall("a:author", _NS)],
                year=int(pub[:4]) if pub[:4].isdigit() else None,
                venue="arXiv",
                doi=doi,
                url=f"https://arxiv.org/abs/{aid}",
                arxiv_id=aid,
                abstract=_clean_abstract(e.findtext("a:summary", "", _NS)),
                citation_count=None,
                source="arxiv",
                bibtype="misc",
                score=0.8 / (i + 1),
            )
        )
    return out


# ------------------------------------------------------------------ merge


def merge(lists: list[list[Candidate]]) -> list[Candidate]:
    by_key: dict[str, Candidate] = {}
    for cands in lists:
        for c in cands:
            if not c.title:
                continue
            key = ("doi:" + c.doi.lower()) if c.doi else ("t:" + norm_title(c.title)[:80])
            alt = "t:" + norm_title(c.title)[:80]
            existing = by_key.get(key) or by_key.get(alt)
            if existing:
                existing.score += c.score
                existing.sources = sorted({*existing.sources, c.source})
                for f in ("doi", "arxiv_id", "abstract", "venue", "url"):
                    if not getattr(existing, f) and getattr(c, f):
                        setattr(existing, f, getattr(c, f))
                if (c.citation_count or 0) > (existing.citation_count or 0):
                    existing.citation_count = c.citation_count
                if not existing.year and c.year:
                    existing.year = c.year
                by_key[key] = existing
                by_key[alt] = existing
            else:
                c.sources = [c.source]
                by_key[key] = c
                by_key[alt] = c
    uniq = {id(c): c for c in by_key.values()}
    out = list(uniq.values())
    for c in out:
        c.score += 0.15 * math.log1p(c.citation_count or 0) / 5 + 0.2 * (len(c.sources) - 1)
    out.sort(key=lambda c: c.score, reverse=True)
    return out


# An index that throttles this server is skipped for a while instead of being asked again on
# every query: a throttled arXiv answers 429 only after ~16 s, which made a six-query scan take
# twenty minutes.
COOLDOWN_S = 300.0
_cooldown_until: dict[str, float] = {}


def _throttled(e: Exception) -> bool:
    return any(code in str(e) for code in ("429", "406"))


async def search(q: str, limit: int = 12) -> tuple[list[Candidate], list[str]]:
    q = q.strip()
    errors: list[str] = []
    indexes = {
        "Semantic Scholar": lambda c: semantic_scholar(c, q, limit),
        "OpenAlex": lambda c: openalex(c, q, limit),
        "arXiv": lambda c: arxiv(c, q, min(limit, 8)),
    }
    now = time.monotonic()
    active = {name: fn for name, fn in indexes.items() if _cooldown_until.get(name, 0) <= now}
    for name in indexes.keys() - active.keys():
        errors.append(f"{name} was rate-limiting this server, so it is skipped for a few minutes.")
    async with httpx.AsyncClient(
        headers={"User-Agent": _UA, "Accept-Encoding": "identity"}, follow_redirects=True
    ) as client:
        results = await asyncio.gather(*(fn(client) for fn in active.values()), return_exceptions=True)
    lists: list[list[Candidate]] = []
    for name, r in zip(active, results, strict=True):
        if isinstance(r, Exception):
            errors.append(friendly_index_error(name, r))
            if _throttled(r):
                _cooldown_until[name] = time.monotonic() + COOLDOWN_S
        else:
            lists.append(r)
    return merge(lists)[:limit], errors


def friendly_index_error(index: str, e: Exception) -> str:
    """What the author can do about it, not the HTTP trace."""
    text = str(e)
    if "429" in text:
        if index == "Semantic Scholar":
            return "Semantic Scholar is rate-limiting this server. A free API key lifts the limit (see README)."
        return f"{index} is rate-limiting this server right now. Try again in a minute."
    if "406" in text and index == "arXiv":
        return "arXiv refused the request (406). It throttles by address; try again in a few minutes."
    if "timed out" in text.lower() or "timeout" in text.lower():
        return f"{index} did not answer in time."
    return f"{index} could not be reached ({type(e).__name__})."
