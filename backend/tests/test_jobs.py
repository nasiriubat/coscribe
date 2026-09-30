import time

from app.ingest import service as ingest_service


def _wait(client, job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_ingest_job_runs_on_event_loop(client, admin, monkeypatch):
    """Starting a job from a request must schedule it on the server loop and report progress."""

    async def fake_ingest(root, arxiv_id, ctx):
        ctx.progress(50, "halfway")
        return {"id": f"arxiv-{arxiv_id}", "title": "Fake", "word_count": 1, "source": "test"}

    monkeypatch.setattr(ingest_service, "ingest_arxiv", fake_ingest)
    r = client.post("/api/projects", headers=admin, json={"title": "Jobs test", "kind": "tool-paper"})
    slug = r.json()["slug"]
    r = client.post(f"/api/projects/{slug}/exemplars/arxiv", headers=admin, json={"ref": "2405.15793"})
    assert r.status_code == 202, r.text
    job = _wait(client, r.json()["id"])
    assert job["status"] == "done"
    assert job["result"]["title"] == "Fake"
    assert job["progress"] == 100

    # failures are captured, never crash the server
    async def boom(root, arxiv_id, ctx):
        raise ValueError("nope")

    monkeypatch.setattr(ingest_service, "ingest_arxiv", boom)
    r = client.post(f"/api/projects/{slug}/exemplars/arxiv", headers=admin, json={"ref": "2405.15793"})
    job = _wait(client, r.json()["id"])
    assert job["status"] == "failed" and "nope" in job["error"]

    assert (
        client.post(f"/api/projects/{slug}/exemplars/arxiv", headers=admin, json={"ref": "garbage"}).status_code == 400
    )
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_running_job_can_be_cancelled(client, admin, monkeypatch):
    """Cancel stops the job, records it as cancelled and frees the project for the next one."""
    import asyncio

    async def slow(root, arxiv_id, ctx):
        ctx.progress(10, "working")
        await asyncio.sleep(30)

    monkeypatch.setattr(ingest_service, "ingest_arxiv", slow)
    r = client.post("/api/projects", headers=admin, json={"title": "Cancel test", "kind": "tool-paper"})
    slug = r.json()["slug"]
    r = client.post(f"/api/projects/{slug}/exemplars/arxiv", headers=admin, json={"ref": "2405.15793"})
    job_id = r.json()["id"]
    deadline = time.time() + 5
    while client.get(f"/api/jobs/{job_id}").json()["status"] != "running" and time.time() < deadline:
        time.sleep(0.05)
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=admin).json() == {"cancelled": True}
    job = _wait(client, job_id)
    assert job["status"] == "failed" and job["error"] == "Cancelled"
    # a finished job cannot be cancelled again
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=admin).json() == {"cancelled": False}
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_learn_requires_exemplars(client, admin):
    r = client.post("/api/projects", headers=admin, json={"title": "Learn test", "kind": "tool-paper"})
    slug = r.json()["slug"]
    r = client.post(f"/api/projects/{slug}/learn", headers=admin, json={"max_chars_per_paper": 15000})
    assert r.status_code == 202
    job = _wait(client, r.json()["id"])
    assert job["status"] == "failed" and "No ingested exemplars" in job["error"]
    client.delete(f"/api/projects/{slug}", headers=admin)


def test_stopped_ingest_leaves_no_half_read_paper(client, tmp_path, monkeypatch):
    """A cancelled ingest must not leave a paper stuck at "processing" that then counts as an example."""
    import asyncio

    import pytest

    from app.ingest import extract
    from app.jobs import JobContext

    def stopped(*args, **kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(extract, "extract_pdf", stopped)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(ingest_service.ingest_pdf(tmp_path, b"%PDF-1.4", "paper.pdf", JobContext("no-job", "no-user")))
    assert list(tmp_path.iterdir()) == []


def test_stopped_voice_learning_does_not_stay_learning(client, admin):
    from app.db import SessionLocal
    from app.learn import service as learn_service
    from app.models import AuthorProfile

    slug = client.post("/api/profiles", headers=admin, json={"name": "Stopped voice"}).json()["slug"]
    pid = client.get(f"/api/profiles/{slug}").json()["id"]

    def set_learning():
        with SessionLocal() as db:
            db.get(AuthorProfile, pid).status = "learning"
            db.commit()

    set_learning()
    learn_service.settle_profile_status(pid)
    assert client.get(f"/api/profiles/{slug}").json()["status"] == "empty"
    client.put(f"/api/profiles/{slug}/style", headers=admin, json={"content": "Short sentences."})
    set_learning()
    learn_service.settle_profile_status(pid)
    assert client.get(f"/api/profiles/{slug}").json()["status"] == "ready"
    client.delete(f"/api/profiles/{slug}", headers=admin)


def test_arxiv_ingest_falls_back_to_the_pdf_when_the_source_is_refused(tmp_path, monkeypatch):
    import asyncio

    import httpx

    from app.ingest import arxiv as arxiv_mod
    from app.ingest import extract
    from app.jobs import JobContext

    async def meta(arxiv_id, client):
        return arxiv_mod.ArxivMeta(
            id=arxiv_id, title="A Paper", authors=["A"], abstract="x", published="2024-01-02", updated="2024-01-02"
        )

    async def refused(arxiv_id, dest, client):
        raise httpx.HTTPStatusError("406 from arXiv", request=None, response=None)

    async def pdf(arxiv_id, dest, client):
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "source.pdf").write_bytes(b"%PDF-1.4")
        return dest / "source.pdf"

    def extract_pdf(folder, path, meta):
        assert path.name == "source.pdf"
        return {"title": meta["title"], "word_count": 10, "source": meta["source"]}

    monkeypatch.setattr(arxiv_mod, "fetch_meta", meta)
    monkeypatch.setattr(arxiv_mod, "fetch_source", refused)
    monkeypatch.setattr(arxiv_mod, "fetch_pdf", pdf)
    monkeypatch.setattr(extract, "extract_pdf", extract_pdf)
    monkeypatch.setattr(JobContext, "progress", lambda self, pct, message=None: None)
    out = asyncio.run(ingest_service.ingest_arxiv(tmp_path, "2401.00001", JobContext("no-job", "no-user")))
    assert out["source"] == "arxiv-pdf" and out["title"] == "A Paper"
