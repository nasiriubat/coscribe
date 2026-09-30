"""Citation evidence: passages by overlap, model verdicts, finding and rewriting sources."""

import json

from app import storage
from app.llm.base import Completion, Usage
from app.refs import evidence, readings
from app.refs import service as refs

PAPER = """# Robots Are Here

## Introduction

Generative AI tools have arrived in introductory programming courses and instructors are adjusting.

## Method

We ran a think-aloud study with twelve first-year students who used Copilot on debugging tasks over one semester.

## Results

Students accepted 71 percent of suggestions without reading them, and most did not test the code.

## Threats

The study covers one course at one university.
"""


def _reading(root, key="prather2024robots"):
    folder = readings.readings_dir(root) / "arxiv-2401-00001"
    folder.mkdir(parents=True, exist_ok=True)
    from app.ingest.extract import sections_of

    meta = {
        "id": folder.name,
        "title": "Robots Are Here",
        "authors": ["Prather, James"],
        "year": 2024,
        "arxiv_id": "2401.00001",
        "status": "ready",
        "sections": sections_of(PAPER),
    }
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (folder / "extracted.md").write_text(PAPER, encoding="utf-8")
    rec = refs.accept(
        root,
        {
            "title": "Robots Are Here",
            "authors": ["Prather, James"],
            "year": 2024,
            "arxiv_id": "2401.00001",
            "abstract": "Novices using Copilot accepted most suggestions without reading them.",
        },
        key=key,
    )
    rec["reading_id"] = folder.name
    refs._save(root, rec)
    return rec


def test_evidence_finds_passage_and_falls_back_to_abstract(client, admin):
    r = client.post("/api/projects", json={"title": "Evidence", "kind": "empirical-study"}, headers=admin)
    slug = r.json()["slug"]
    root = storage.project_dir(slug)
    _reading(root)
    refs.accept(
        root,
        {"title": "Abstract Only", "authors": ["Doe, J"], "year": 2020, "abstract": "We survey students."},
        key="doe2020abstract",
    )

    sentence = "Novices accept most Copilot suggestions without reading them [@prather2024robots]."
    res = client.post(
        f"/api/projects/{slug}/references/prather2024robots/evidence", json={"sentence": sentence}, headers=admin
    )
    assert res.status_code == 200, res.text
    ev = res.json()
    assert ev["full_text"] is True and ev["source"] == "full_text" and ev["hint"] is None
    assert ev["passages"][0]["section"] == "Results" and "71 percent" in ev["passages"][0]["text"]
    assert "suggestion" in ev["passages"][0]["matched"]  # tokens are stemmed

    res = client.post(
        f"/api/projects/{slug}/references/doe2020abstract/evidence", json={"sentence": sentence}, headers=admin
    )
    ev = res.json()
    assert ev["full_text"] is False and ev["passages"] == [] and "Background reading" in ev["hint"]
    assert ev["what_it_says"] == "We survey students."
    assert (
        client.post(
            f"/api/projects/{slug}/references/nokey/evidence", json={"sentence": sentence}, headers=admin
        ).status_code
        == 404
    )
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_check_find_and_rewrite_use_the_utility_model(client, admin, monkeypatch):
    replies = {
        "cite_check": {"verdict": "partly supported", "reason": "The paper reports acceptance, not reading."},
        "cite_query": {
            "query": "novice programmers accept AI code suggestions",
            "claim": "novices over-accept suggestions",
        },
        "cite_rewrite": {
            "sentence": "Students in one study accepted most suggestions unread [@prather2024robots].",
            "note": "scoped to the study",
        },
    }

    async def fake_complete(db, purpose, messages, **kw):
        text = messages[0].content
        which = (
            "cite_check"
            if "You check one citation" in text
            else "cite_query"
            if "search query" in text
            else "cite_rewrite"
        )
        return Completion(text=json.dumps(replies[which]), model="fake", usage=Usage(500, 60))

    async def fake_search(q, limit=12):
        from app.refs.providers import Candidate

        return [
            Candidate(
                title="Robots Are Here", authors=["Prather"], year=2024, arxiv_id="2401.00001", sources=["arxiv"]
            ),
            Candidate(
                title="New Paper",
                authors=["Lee"],
                year=2025,
                doi="10.1/new",
                abstract="Novices accept.",
                sources=["openalex"],
            ),
        ], []

    monkeypatch.setattr(evidence, "complete", fake_complete)
    monkeypatch.setattr(evidence, "search", fake_search)
    r = client.post("/api/projects", json={"title": "Evidence 2", "kind": "empirical-study"}, headers=admin)
    slug = r.json()["slug"]
    root = storage.project_dir(slug)
    _reading(root)
    sentence = "Novices accept most Copilot suggestions without reading them."

    chk = client.post(
        f"/api/projects/{slug}/references/prather2024robots/check",
        json={"sentence": sentence, "passage": "Students accepted 71 percent"},
        headers=admin,
    )
    assert (
        chk.status_code == 200 and chk.json()["verdict"] == "partly_supported" and "acceptance" in chk.json()["reason"]
    )

    found = client.post(f"/api/projects/{slug}/references/find", json={"sentence": sentence}, headers=admin).json()
    assert found["own"][0]["key"] == "prather2024robots" and found["query"].startswith("novice")
    assert [c["title"] for c in found["candidates"]] == ["New Paper"]  # the known paper is filtered out

    rw = client.post(f"/api/projects/{slug}/references/rewrite", json={"sentence": sentence}, headers=admin).json()
    assert rw["used_keys"] == ["prather2024robots"] and rw["sentence"].endswith("[@prather2024robots].")

    # a rewrite that cites an unknown key is replaced by a placeholder version
    replies["cite_rewrite"] = {"sentence": "Everyone agrees [@made2020up].", "note": ""}
    rw = client.post(f"/api/projects/{slug}/references/rewrite", json={"sentence": sentence}, headers=admin).json()
    assert rw["used_keys"] == [] and "[CITE:" in rw["sentence"] and "made2020up" not in rw["sentence"]
    # an invented key hidden behind a real one in the same group is refused too
    replies["cite_rewrite"] = {"sentence": "Everyone agrees [@prather2024robots; @made2020up].", "note": ""}
    rw = client.post(f"/api/projects/{slug}/references/rewrite", json={"sentence": sentence}, headers=admin).json()
    assert rw["used_keys"] == [] and "made2020up" not in rw["sentence"]
    client.delete(f"/api/projects/{slug}", headers=admin)
