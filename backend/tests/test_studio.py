from pathlib import Path

from app.studio import lint as lint_mod
from app.studio import service as svc

HOUSE = """# House style

## Banned words and phrases

Never use these. They are the fingerprints of machine text.

delve, delve into, tapestry, landscape (figurative), leverage (as a verb), it is worth noting,
not only ... but also, plays a crucial role.

## Patterns to avoid
- Triads.
"""

OUTLINE = """# Outline: T

## 1. Abstract (≈ 80 words)
- Summarise the tool.

## Introduction (≈ 900 words)
- Open with the pain.
- [NEEDS: a concrete scenario]
- State contributions.

## Evaluation / Demonstration (≈ 350 words)
- Method.
- [NEEDS: results of the pilot]

## Open items
- [NEEDS: a concrete scenario] (Introduction)
"""


def test_banned_phrase_parsing():
    phrases = lint_mod.banned_phrases(HOUSE)
    assert "delve" in phrases and "leverage" in phrases and "it is worth noting" in phrases
    assert "landscape" in phrases  # parenthetical qualifier stripped
    wrapped = "## Banned words and phrases\n\ndelve, in the\nrealm of, at its core.\n"
    assert lint_mod.banned_phrases(wrapped) == ["delve", "in the realm of", "at its core"]
    assert not any(p.startswith("never") for p in phrases)


def test_lint_findings():
    long = (
        "Furthermore, this is a sentence that keeps going and going with clause after clause after clause "
        "because nobody stopped it and it now has far more than thirty five words in total which is too many."
    )
    text = (
        "# Heading\n\n"
        "We delve into the problem — it is worth noting that tools matter; users agree!\n\n"
        f"{long}\n\n"
        "Furthermore, prior work [@smith2020] and [@ok2021; @nope] found things. "
        "[NEEDS: numbers] Is this good?\n"
    )
    f = lint_mod.lint(text, HOUSE, known_keys={"ok2021"})
    kinds = {x["kind"] for x in f}
    assert {"banned", "dash", "semicolon", "exclamation", "long", "opener", "citation", "needs", "question"} <= kinds
    cites = [x for x in f if x["kind"] == "citation" and x["severity"] == "error"]
    assert {c["excerpt"] for c in cites} == {"[@smith2020]", "[@ok2021; @nope]"}
    assert all(x["line"] >= 1 for x in f)
    summary = lint_mod.summarize(f)
    assert summary["errors"] == 2 and summary["warnings"] >= 4


def test_outline_parsing_and_init(tmp_path: Path):
    parsed = svc.parse_outline(OUTLINE)
    assert [p["title"] for p in parsed] == ["Abstract", "Introduction", "Evaluation / Demonstration"]
    assert parsed[1]["target_words"] == 900 and len(parsed[1]["lines"]) == 3

    root = tmp_path / "proj"
    (root / "inputs").mkdir(parents=True)
    (root / "outline.md").write_text(OUTLINE)
    (root / "references").mkdir()
    (root / "references" / "refs.bib").write_text("@article{ok2021, title={x}}\n")
    import subprocess

    subprocess.run(["git", "init", "-q", root], check=True)
    index = svc.init_sections(root)
    files = sorted(p.name for p in (root / "sections").iterdir())
    assert files == ["01-abstract.md", "02-introduction.md", "03-evaluation-demonstration.md", "index.json"]
    assert index["sections"][1]["target_words"] == 900

    items = svc.load_checklist(root)
    assert {i["text"] for i in items} == {"a concrete scenario", "results of the pilot"}
    assert all(i["source"] == "outline" for i in items)

    # re-init keeps sections and does not duplicate checklist items
    sec = index["sections"][1]
    svc.save_section_text(root, sec, "We open with the pain. [NEEDS: a number]", by_user=True)
    index2 = svc.init_sections(root)
    assert index2["sections"][1]["id"] == sec["id"] and index2["sections"][1]["status"] == "edited"
    texts = [i["text"] for i in svc.load_checklist(root)]
    assert texts.count("a concrete scenario") == 1 and "a number" in texts

    # placeholder removed from the draft closes the draft-sourced item
    svc.save_section_text(root, index2["sections"][1], "We open with the pain. Now with 12 users.", by_user=True)
    by_text = {i["text"]: i for i in svc.load_checklist(root)}
    assert by_text["a number"]["status"] == "resolved"
    assert by_text["a concrete scenario"]["status"] == "open"  # outline-sourced items stay until the user resolves them

    assert svc.known_ref_keys(root) == {"ok2021"}
    hist = svc.history(root, index2["sections"][1])
    assert len(hist) >= 2
    assert "12 users" in svc.version_text(root, index2["sections"][1], hist[0]["sha"])
    assert "[NEEDS: a number]" in svc.version_text(root, index2["sections"][1], hist[1]["sha"])


def test_section_bucket_matching():
    assert svc._bucket("Tool Overview / Architecture") == "design"
    assert svc._bucket("Related Work") == "related"
    assert svc._bucket("Evaluation / Demonstration") == "evaluation"
    assert svc._bucket("Data Availability") is None


def test_studio_api_requires_approved_outline(client, admin):
    r = client.post("/api/projects", headers=admin, json={"title": "Studio flow", "kind": "tool-paper"})
    slug = r.json()["slug"]
    assert client.get(f"/api/projects/{slug}/studio").json()["initialized"] is False
    assert client.post(f"/api/projects/{slug}/studio/init", headers=admin).status_code == 400
    f = client.post(f"/api/projects/{slug}/lint", headers=admin, json={"text": "We delve — deeply."}).json()
    assert {x["kind"] for x in f} >= {"banned", "dash"}
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_review_prompts_render_and_endpoint(client, admin):
    from app.learn.context import render

    out = render(
        "critique.j2",
        kind_name="Tool paper",
        venue="ICSE",
        kind_notes="k",
        checklist="c",
        playbook="p",
        facts="",
        draft="## Intro\n\nText.",
        total_words=2,
    )
    assert "ICSE" in out and "=== DRAFT (2 words) ===" in out
    out = render(
        "venue.j2",
        kind_name="Tool paper",
        spec="s",
        plan="",
        venue_notes="",
        exemplar_venues="",
        total_words=0,
        drafted_sections=0,
        total_sections=0,
    )
    assert '"suggestions"' in out
    r = client.post("/api/projects", headers=admin, json={"title": "Review flow", "kind": "tool-paper"})
    slug = r.json()["slug"]
    assert client.get(f"/api/projects/{slug}/review").json() == {"review": None, "venues": None}
    assert (
        client.post(f"/api/projects/{slug}/venue", headers=admin, json={"venue": "PROFES 2027"}).json()["venue"]
        == "PROFES 2027"
    )
    assert client.get(f"/api/projects/{slug}").json()["counts"]["reviewed"] is False
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_overlap_lint_flags_copied_runs():
    from app.studio.lint import exemplar_overlap, lint

    exemplar = "We evaluated the tool on three industrial case studies with twelve practitioners over six weeks.\n"
    own = (
        "Our approach differs.\n\n"
        "We evaluated the tool on three industrial case studies with twelve practitioners over six weeks, "
        "then stopped.\n"
    )
    hits = exemplar_overlap(own, {"Some Exemplar Paper": exemplar})
    assert len(hits) == 1 and hits[0].kind == "overlap" and hits[0].line == 3
    assert "Some Exemplar Paper" in hits[0].message
    # short coincidences are not flagged
    assert exemplar_overlap("We evaluated the tool on three cases.", {"X": exemplar}) == []
    # wired into lint()
    kinds = {f["kind"] for f in lint(own, "", set(), {"Some Exemplar Paper": exemplar})}
    assert "overlap" in kinds


def test_import_draft_makes_outline_and_owned_sections(client, admin):
    from app import storage
    from app.studio import service as studio

    r = client.post(
        "/api/projects", json={"title": "Imported Draft", "kind": "tool-paper", "entry": "draft"}, headers=admin
    )
    slug = r.json()["slug"]
    md = (
        "# LogLens\n\n## Introduction\nCI logs are long. Developers skim them.\n\nWe built LogLens to help.\n\n"
        "## Approach\nIt groups failing steps and highlights the first cause.\n\n## Evaluation\n"
    )
    res = client.post(f"/api/projects/{slug}/studio/import", json={"markdown": md}, headers=admin)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["imported"]["sections"] == 3 and body["imported"]["with_text"] == 2
    slugs = [s["slug"] for s in body["sections"]]
    assert slugs == ["introduction", "approach", "evaluation"]
    statuses = {s["slug"]: s["status"] for s in body["sections"]}
    assert statuses["introduction"] == "mine" and statuses["evaluation"] == "empty"
    outline = storage.read_text(storage.project_dir(slug) / "outline.md")
    assert (
        "## 1. Introduction" in outline
        and "- CI logs are long." in outline
        and "[NEEDS: this section has a heading" in outline
    )
    intro = next(s for s in body["sections"] if s["slug"] == "introduction")
    text = client.get(f"/api/projects/{slug}/sections/{intro['id']}", headers=admin).json()["content"]
    assert text.startswith("CI logs are long.")
    assert client.get(f"/api/projects/{slug}", headers=admin).json()["stage"] == "drafting"
    # a second import is refused rather than overwriting the author's text
    assert client.post(f"/api/projects/{slug}/studio/import", json={"markdown": md}, headers=admin).status_code == 400
    assert studio.import_draft.__doc__
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_mechanical_hygiene_pass_keeps_protected_spans():
    from app.studio import hygiene

    text = (
        "## Heading — keep\n\n"
        "The parser — a small module — rejects bad input; it logs the reason for each rejection [@smith2020].\n"
        "We were surprised! See [NEEDS: the figure — with numbers] and `code; here`.\n"
        "- a list item; untouched\n"
    )
    out, changes = hygiene.mechanical_pass(text)
    assert "## Heading — keep" in out
    assert "The parser, a small module, rejects bad input. It logs the reason" in out
    assert "[@smith2020]" in out and "[NEEDS: the figure — with numbers]" in out and "`code; here`" in out
    assert "surprised." in out and "- a list item; untouched" in out
    kinds = {c.kind: c.count for c in changes}
    assert kinds == {"dash": 2, "semicolon": 1, "exclamation": 1}
    assert "dashes" in hygiene.describe(changes)


def test_fix_guard_rejects_dropped_citations_and_length_drift():
    from app.studio import fix

    base = "Alpha beta [@a] gamma. [NEEDS: numbers] " + "word " * 60
    assert fix.preserved(base, base) is None
    assert fix.preserved(base, base.replace("[@a]", "")) == "the citations changed"
    assert "placeholder" in fix.preserved(base, base.replace("[NEEDS: numbers]", "[NEEDS: figures]"))
    assert "length" in fix.preserved(base, base + "word " * 40)
    assert "Punctuation" in fix.hygiene_rules(HOUSE + "\n## Punctuation\n- none\n")


def test_fix_endpoint_proposes_without_saving(client, admin, monkeypatch):
    from app.llm.base import Completion, Usage
    from app.studio import fix

    async def fake_complete(db, purpose, messages, **kw):
        assert purpose == "utility"
        text = messages[0].content.split("=== SECTION TEXT ===\n", 1)[1]
        return Completion(text=text.replace("delve into", "examine"), model="fake", usage=Usage(300, 120))

    monkeypatch.setattr(fix, "complete", fake_complete)
    r = client.post("/api/projects", json={"title": "Fix Me", "kind": "tool-paper", "entry": "draft"}, headers=admin)
    slug = r.json()["slug"]
    md = "## Introduction\nWe delve into logs — they are long; developers skim them and miss the cause.\n"
    body = client.post(f"/api/projects/{slug}/studio/import", json={"markdown": md}, headers=admin).json()
    sec = body["sections"][0]
    content = client.get(f"/api/projects/{slug}/sections/{sec['id']}", headers=admin).json()["content"]
    res = client.post(f"/api/projects/{slug}/sections/{sec['id']}/fix", json={"text": content}, headers=admin)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["changed"] and out["model_used"]
    assert "examine" in out["text"] and "—" not in out["text"] and ";" not in out["text"]
    assert out["before_count"] >= 2 and len(out["after"]) < out["before_count"]
    # nothing was written
    again = client.get(f"/api/projects/{slug}/sections/{sec['id']}", headers=admin).json()["content"]
    assert again == content
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_missing_sections_and_add_section(client, admin):
    from app import storage
    from app.interview import service as interview

    r = client.post("/api/projects", json={"title": "Gaps", "kind": "tool-paper", "entry": "draft"}, headers=admin)
    slug = r.json()["slug"]
    md = "## Introduction\nText.\n\n## Approach\nMore text.\n\n## Conclusion\nEnd.\n"
    body = client.post(f"/api/projects/{slug}/studio/import", json={"markdown": md}, headers=admin).json()
    assert "Related work" in body["missing"] and "Evaluation" in body["missing"]
    assert "Introduction" not in body["missing"] and "Design" not in body["missing"]  # Approach covers Design
    res = client.post(f"/api/projects/{slug}/studio/sections", json={"title": "Evaluation"}, headers=admin)
    assert res.status_code == 201, res.text
    out = res.json()
    assert out["section"]["title"] == "Evaluation" and out["section"]["status"] == "empty"
    assert "Evaluation" not in out["missing"] and len(out["sections"]) == 4
    intro = next(s for s in out["sections"] if s["slug"] == "introduction")
    assert intro["status"] == "mine"  # existing text and ownership untouched
    outline = storage.read_text(storage.project_dir(slug) / "outline.md")
    assert "## 4. Evaluation" in outline and outline.index("## 4. Evaluation") < outline.index("## Open items")
    dup = client.post(f"/api/projects/{slug}/studio/sections", json={"title": "Evaluation"}, headers=admin)
    assert dup.status_code == 400
    # pinned notes are carried as unverified
    root = storage.project_dir(slug)
    st = interview.pin_note(root, "Everyone uses AI for debugging now")
    assert st["notes"][-1]["unverified"] is True
    assert "(unverified)" in interview.render_interview_md(st)
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_review_of_a_draft_first_project_extracts_facts_first(client, admin, monkeypatch):
    """Without facts, the reviewer called the author's own numbers fabrications."""
    import asyncio

    from app.interview import service as interview_service
    from app.jobs import JobContext
    from app.llm.base import Completion, Usage
    from app.studio import review

    r = client.post(
        "/api/projects", headers=admin, json={"title": "Draft review", "kind": "tool-paper", "entry": "draft"}
    )
    slug, pid = r.json()["slug"], r.json()["id"]
    client.put(f"/api/projects/{slug}/files/system-spec", headers=admin, json={"content": "Used on 14 repositories."})
    client.post(
        f"/api/projects/{slug}/studio/import",
        headers=admin,
        json={"markdown": "## Intro\n\nWe used it on 14 repositories.\n"},
    )
    seen = {}

    async def fake_facts(project_id, ctx=None):
        from app import storage

        storage.write_text(
            storage.project_dir(slug) / "inputs" / "facts.md", "# Facts\n- 14 repositories (source: spec)\n"
        )
        return {}

    async def fake_complete(db, purpose, messages, **kw):
        seen["prompt"] = messages[0].content
        return Completion(
            text='{"verdict": "accept", "findings": []}', usage=Usage(input_tokens=1, output_tokens=1), model="m"
        )

    monkeypatch.setattr(interview_service, "extract_facts", fake_facts)
    monkeypatch.setattr(review, "complete", fake_complete)
    monkeypatch.setattr(JobContext, "progress", lambda self, pct, message=None: None)
    asyncio.run(review.run_critique(pid, JobContext("no-job", "no-user")))
    assert "14 repositories (source: spec)" in seen["prompt"]
    client.delete(f"/api/projects/{slug}", headers=admin)
