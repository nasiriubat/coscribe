import subprocess
from pathlib import Path

from app.refs import bib as bib_mod
from app.refs import service as svc
from app.refs.providers import Candidate, merge

BIB = r"""
@article{smith2020tender,
  title = {Matching {SMEs} to Public Tenders},
  author = {Smith, John and Doe, Jane},
  journal = {Journal of Procurement},
  year = 2020,
  doi = {10.1000/xyz123}
}

@inproceedings{lee2019,
  title="A Tool for Something",
  author="Lee, Ann",
  booktitle="Proc. of Tools",
  year="2019",
}

@misc{noTitle, year = {2000} }
"""


def test_parse_bib_and_records():
    entries = bib_mod.parse_bib(BIB)
    assert [e["key"] for e in entries] == ["smith2020tender", "lee2019", "noTitle"]
    r = bib_mod.entry_to_record(entries[0])
    assert r["title"] == "Matching SMEs to Public Tenders"
    assert r["authors"] == ["Smith, John", "Doe, Jane"]
    assert r["year"] == 2020 and r["doi"] == "10.1000/xyz123" and r["venue"] == "Journal of Procurement"
    r2 = bib_mod.entry_to_record(entries[1])
    assert r2["venue"] == "Proc. of Tools" and r2["year"] == 2019


def test_key_generation_and_bibtex_roundtrip():
    taken = {"smith2020matching"}
    k = bib_mod.make_key(["John Smith", "Jane Doe"], 2020, "Matching SMEs to Public Tenders", taken)
    assert k == "smith2020matchinga"
    assert bib_mod.make_key(["Doe, Jane"], None, "The of a Tool", set()) == "doetool"
    rec = {
        "key": "x2021y",
        "title": "T & U",
        "authors": ["A B"],
        "year": 2021,
        "venue": "V",
        "bibtype": "inproceedings",
        "doi": "10.1/2",
    }
    tex = bib_mod.record_to_bibtex(rec)
    assert tex.startswith("@inproceedings{x2021y,") and "booktitle = {V}" in tex and "\\&" in tex
    parsed = bib_mod.parse_bib(tex)
    assert parsed[0]["fields"]["doi"] == "10.1/2"


def test_merge_dedupes_by_doi_and_title():
    a = Candidate(
        title="Deep Tender Matching",
        authors=["A"],
        year=2020,
        doi="10.1/A",
        source="semanticscholar",
        score=1.0,
        citation_count=10,
    )
    b = Candidate(title="Deep tender matching.", authors=["A"], year=2020, doi=None, source="openalex", score=0.5)
    c = Candidate(title="Other", authors=["B"], year=2019, doi="10.1/B", source="arxiv", score=0.8)
    merged = merge([[a], [b], [c]])
    assert len(merged) == 2
    top = merged[0]
    assert top.title == "Deep Tender Matching" and set(top.sources) == {"semanticscholar", "openalex"}
    assert top.citation_count == 10


def test_records_store_and_requests(tmp_path: Path):
    root = tmp_path / "proj"
    (root / "references").mkdir(parents=True)
    (root / "sections").mkdir()
    subprocess.run(["git", "init", "-q", root], check=True)
    r = svc.accept(
        root,
        {
            "title": "Deep Tender Matching",
            "authors": ["Ada Lovelace"],
            "year": 2020,
            "source": "openalex",
            "doi": "10.1/A",
        },
    )
    assert r["key"] == "lovelace2020deep" and r["verified_at"]
    assert svc.keys(root) == {"lovelace2020deep"}
    bib = (root / "references" / "refs.bib").read_text()
    assert "@misc{lovelace2020deep," in bib and "doi = {10.1/A}" in bib

    res = svc.import_bib(root, BIB)
    assert res["added"] == ["smith2020tender", "lee2019"] and res["skipped"] == ["noTitle"]
    assert len(svc.list_records(root)) == 3
    assert "@article{smith2020tender," in (root / "references" / "refs.bib").read_text()

    # duplicate key on import gets a generated key
    res2 = svc.import_bib(root, "@article{lee2019, title={Another}, author={Kim, Bo}, year={2019}}")
    assert res2["added"] == ["kim2019another"]

    # citation requests from placeholders and usage counts
    (root / "sections" / "index.json").write_text(
        '{"sections": [{"id": "s1", "title": "Related Work", "file": "01.md"}]}'
    )
    (root / "sections" / "01.md").write_text(
        "Prior work [@lee2019] and [@lee2019; @missing]. [CITE: evidence that CPV filters miss tenders]"
    )
    reqs = svc.requests(root)
    assert reqs == [
        {
            "section": "Related Work",
            "section_id": "s1",
            "text": "evidence that CPV filters miss tenders",
            "query": "CPV filters miss tenders",
        }
    ]
    assert svc.usage(root) == {"lee2019": 2, "missing": 1}

    assert svc.delete(root, "lee2019") is True
    assert svc.delete(root, "../x") is False
    assert "lee2019" not in svc.keys(root)


def test_references_api(client, admin):
    r = client.post("/api/projects", headers=admin, json={"title": "Refs flow", "kind": "tool-paper"})
    slug = r.json()["slug"]
    assert client.get(f"/api/projects/{slug}/references").json() == []
    r = client.post(
        f"/api/projects/{slug}/references/manual",
        headers=admin,
        json={"title": "Manual One", "authors": ["Z Zed"], "year": 2022},
    )
    assert r.status_code == 201 and r.json()["key"] == "zed2022manual" and r.json()["source"] == "manual"
    assert "zed2022manual" in client.get(f"/api/projects/{slug}/references/bib").text
    assert client.get(f"/api/projects/{slug}").json()["counts"]["references"] == 1
    assert client.delete(f"/api/projects/{slug}/references/zed2022manual", headers=admin).status_code == 204
    assert client.delete(f"/api/projects/{slug}/references/zed2022manual", headers=admin).status_code == 404
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_scan_prompts_render_and_adopt(client, admin, monkeypatch):
    import json

    from app import storage
    from app.ingest import service as ingest
    from app.learn.context import render
    from app.refs import scan

    q = render("scan_queries.j2", kind_name="Tool paper", idea="Match tenders to SMEs", plan="", spec="", known="")
    assert "Match tenders" in q and '"queries"' in q
    cands = [{"title": "A", "year": 2020, "venue": None, "citation_count": 3, "abstract": "x"}]
    r = render("scan_rank.j2", kind_name="Tool paper", work="spec", candidates=cands)
    assert "[0] A (2020, 3 citations)" in r

    proj = client.post(
        "/api/projects", json={"title": "Scan Demo", "kind": "tool-paper", "entry": "idea"}, headers=admin
    )
    assert proj.status_code == 201 and proj.json()["entry"] == "idea"
    slug = proj.json()["slug"]
    root = storage.project_dir(slug)
    assert client.get(f"/api/projects/{slug}/references/scan", headers=admin).json() == {"scan": None}
    # a scan needs something to read
    scan.save_scan(
        root,
        {
            "queries": ["tender matching"],
            "themes": ["domain"],
            "candidates": [
                {
                    "title": "Tender matching with LLMs",
                    "authors": ["A. B."],
                    "year": 2024,
                    "arxiv_id": "2401.00001",
                    "doi": None,
                    "url": "https://arxiv.org/abs/2401.00001",
                    "abstract": "",
                    "source": "arxiv",
                    "sources": ["arxiv"],
                    "bibtype": "misc",
                    "relevance": 3,
                    "why": "same problem",
                    "already_reference": False,
                    "already_exemplar": False,
                    "adopted_reference": None,
                    "adopted_exemplar": False,
                },
                {
                    "title": "Procurement analytics",
                    "authors": ["C. D."],
                    "year": 2019,
                    "arxiv_id": None,
                    "doi": "10.1/x",
                    "url": None,
                    "abstract": "",
                    "source": "openalex",
                    "sources": ["openalex"],
                    "bibtype": "article",
                    "relevance": 2,
                    "why": "related",
                    "already_reference": False,
                    "already_exemplar": False,
                    "adopted_reference": None,
                    "adopted_exemplar": False,
                },
            ],
            "errors": [],
            "created_at": "2026-01-01T00:00:00+00:00",
            "tokens_in": 1,
            "tokens_out": 1,
        },
    )
    started = []

    async def fake_ingest(root_, aid, ctx):
        started.append(aid)
        return {"id": aid}

    monkeypatch.setattr(ingest, "ingest_arxiv", fake_ingest)
    r = client.post(
        f"/api/projects/{slug}/references/scan/adopt",
        json={"idx": [0, 1], "as_reference": True, "as_exemplar": True},
        headers=admin,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["references"]) == 2 and len(body["jobs"]) == 1 and body["skipped"] == ["Procurement analytics"]
    assert started == ["2401.00001"]
    keys = {x["key"] for x in client.get(f"/api/projects/{slug}/references", headers=admin).json()}
    assert set(body["references"]) <= keys
    # adopting again is idempotent
    again = client.post(
        f"/api/projects/{slug}/references/scan/adopt",
        json={"idx": [0], "as_reference": True, "as_exemplar": True},
        headers=admin,
    )
    assert again.json()["references"] == [body["references"][0]] and again.json()["jobs"] == []
    stored = json.loads((root / "inputs" / "scan.json").read_text())
    assert stored["candidates"][0]["adopted_exemplar"] is True
    # duplicates are recognised across doi / arxiv / title
    ref_ids, _ = scan._known(root)
    assert "arxiv:2401.00001" in ref_ids and "doi:10.1/x" in ref_ids
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_cite_exemplar_and_entry_update(client, admin):
    import json

    from app import storage

    proj = client.post("/api/projects", json={"title": "Cite Demo", "kind": "tool-paper"}, headers=admin)
    slug = proj.json()["slug"]
    assert proj.json()["entry"] == "built"
    root = storage.project_dir(slug)
    folder = root / "exemplars" / "arxiv-2401-00002"
    folder.mkdir(parents=True)
    (folder / "meta.json").write_text(
        json.dumps(
            {
                "id": "arxiv-2401-00002",
                "arxiv_id": "2401.00002",
                "title": "An Exemplar Tool",
                "authors": ["E. F.", "G. H."],
                "year": 2023,
                "abstract": "Abs",
                "journal_ref": None,
                "doi": None,
                "url": "https://arxiv.org/abs/2401.00002",
                "status": "ready",
            }
        )
    )
    r = client.post(f"/api/projects/{slug}/exemplars/arxiv-2401-00002/cite", headers=admin)
    assert r.status_code == 201, r.text
    key = r.json()["key"]
    assert r.json()["existing"] is False
    again = client.post(f"/api/projects/{slug}/exemplars/arxiv-2401-00002/cite", headers=admin)
    assert again.json() == {"key": key, "existing": True}
    assert client.post(f"/api/projects/{slug}/exemplars/nope/cite", headers=admin).status_code == 404
    assert client.post(f"/api/projects/{slug}/exemplars/..%2F..%2Fx/cite", headers=admin).status_code in (400, 404, 405)
    rec = client.get(f"/api/projects/{slug}/references", headers=admin).json()[0]
    assert rec["arxiv_id"] == "2401.00002" and rec["source"] == "exemplar"
    # entry can change later, and only to a known value
    assert client.patch(f"/api/projects/{slug}", json={"entry": "draft"}, headers=admin).json()["entry"] == "draft"
    assert client.patch(f"/api/projects/{slug}", json={"entry": "other"}, headers=admin).status_code == 422
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_openalex_arxiv_id_and_pdf_from_locations(monkeypatch):
    import asyncio

    from app.refs import providers

    work = {
        "display_name": "A Paper",
        "publication_year": 2024,
        "authorships": [{"author": {"display_name": "A. B."}}],
        "primary_location": {"landing_page_url": "https://doi.org/10.1/x", "source": {"display_name": "Venue"}},
        "best_oa_location": {
            "landing_page_url": "https://arxiv.org/abs/2401.00001v2",
            "pdf_url": "https://arxiv.org/pdf/2401.00001v2",
            "is_oa": True,
        },
        "locations": [],
        "doi": "https://doi.org/10.1/x",
        "type": "article",
        "cited_by_count": 3,
    }

    class FakeResp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"results": [work]}

    class FakeClient:
        async def get(self, *a, **k):
            return FakeResp()

    cands = asyncio.run(providers.openalex(FakeClient(), "q", 5))
    assert cands[0].arxiv_id == "2401.00001" and cands[0].pdf_url == "https://arxiv.org/pdf/2401.00001v2"


def test_openalex_requires_every_word_and_relaxes_when_nothing_matches():
    """Plain OpenAlex search ranked XGBoost first for a CI query; the filter keeps results on topic."""
    import asyncio

    from app.refs import providers

    calls = []

    def work(n):
        return {"id": f"W{n}", "display_name": f"Paper {n}", "doi": None, "locations": [], "cited_by_count": 0}

    class FakeResp:
        status_code = 200

        def __init__(self, results):
            self._results = results

        def raise_for_status(self):
            pass

        def json(self):
            return {"results": self._results}

    class FakeClient:
        async def get(self, url, params=None, **k):
            calls.append(params)
            # the full query matches one work, the relaxed one matches two more
            return FakeResp([work(1)] if len(calls) == 1 else [work(1), work(2), work(3)])

    cands = asyncio.run(providers.openalex(FakeClient(), "continuous integration, build failure: logs", 5))
    assert "search" not in calls[0]
    assert calls[0]["filter"] == "title_and_abstract.search:continuous integration build failure logs"
    assert calls[1]["filter"] == "title_and_abstract.search:continuous integration failure"
    assert [c.title for c in cands] == ["Paper 1", "Paper 2", "Paper 3"]


def test_a_throttling_index_is_skipped_for_a_while(monkeypatch):
    import asyncio

    import httpx

    from app.refs import providers

    asked = {"arxiv": 0}

    async def throttled_arxiv(client, q, limit):
        asked["arxiv"] += 1
        raise httpx.HTTPStatusError("429 from arXiv", request=None, response=None)

    async def fine(client, q, limit):
        return [providers.Candidate(title="On topic", authors=[], year=2024, source="openalex", score=1.0)]

    monkeypatch.setattr(providers, "arxiv", throttled_arxiv)
    monkeypatch.setattr(providers, "openalex", fine)
    monkeypatch.setattr(providers, "semantic_scholar", fine)
    monkeypatch.setattr(providers, "_cooldown_until", {})
    first, errors1 = asyncio.run(providers.search("q"))
    second, errors2 = asyncio.run(providers.search("q"))
    assert asked["arxiv"] == 1  # not asked again during the cool-down
    assert first[0].title == second[0].title == "On topic"
    assert any("rate-limiting" in e for e in errors1)
    assert any("skipped for a few minutes" in e for e in errors2)
