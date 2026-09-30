from conftest import login


def test_health(client):
    assert client.get("/api/health").json()["ok"] is True


def test_me_requires_login(client):
    client.cookies.clear()
    assert client.get("/api/auth/me").status_code == 401


def test_login_and_me(client):
    h = login(client)
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    assert r.json()["must_change_password"] is True
    assert h["x-csrf-token"]


def test_wrong_password(client):
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": "admin@test.local", "password": "nope-nope"})
    assert r.status_code == 401


def test_csrf_required_on_writes(client):
    login(client)
    r = client.patch("/api/auth/me", json={"display_name": "X"})
    assert r.status_code == 403


def test_change_password_flow(client):
    h = login(client)
    r = client.post(
        "/api/auth/change-password",
        headers=h,
        json={"current_password": "adminpass123", "new_password": "newpass12345"},
    )
    assert r.status_code == 200
    assert r.json()["must_change_password"] is False
    # back to original so other tests keep working
    r = client.post(
        "/api/auth/change-password",
        headers=h,
        json={"current_password": "newpass12345", "new_password": "adminpass123"},
    )
    assert r.status_code == 200


def test_user_crud_and_isolation(client):
    h = login(client)
    r = client.post(
        "/api/users",
        headers=h,
        json={"email": "bob@test.local", "display_name": "Bob", "password": "bobpass12345", "role": "user"},
    )
    assert r.status_code == 201, r.text
    bob_id = r.json()["id"]

    # Bob cannot access admin endpoints
    hb = login(client, "bob@test.local", "bobpass12345")
    assert client.get("/api/users").status_code == 403
    assert client.get("/api/providers").status_code == 403

    # Bob creates a project; admin sees it, another user would not
    r = client.post("/api/projects", headers=hb, json={"title": "Bob's tool", "kind": "tool-paper"})
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]

    h = login(client)
    assert any(p["slug"] == slug for p in client.get("/api/projects").json())
    client.delete(f"/api/users/{bob_id}", headers=h)
    assert client.get(f"/api/projects/{slug}").status_code == 404


def test_site_settings_and_pages(client):
    client.cookies.clear()
    s = client.get("/api/site").json()
    assert s["name"] == "Coscribe" and s["logo_url"] is None
    assert [p["slug"] for p in s["nav_pages"]] == ["about", "contact"]  # seeded on first boot
    assert "Disallow: /api/" in client.get("/robots.txt").text
    h = login(client)
    r = client.put("/api/admin/site", headers=h, json={"name": "TUNI Papers", "tagline": "t", "seo": {"index": False}})
    assert r.status_code == 200 and r.json()["name"] == "TUNI Papers"
    assert client.get("/robots.txt").text.strip() == "User-agent: *\nDisallow: /"
    r = client.post(
        "/api/admin/pages",
        headers=h,
        json={"title": "About us", "content": "# About\n\nHello", "published": False, "show_in_nav": True},
    )
    assert r.status_code == 201 and r.json()["slug"] == "about-us"
    pid = r.json()["id"]
    assert client.get("/api/pages/about-us").status_code == 404  # unpublished
    client.patch(f"/api/admin/pages/{pid}", headers=h, json={"published": True})
    assert client.get("/api/pages/about-us").json()["content"].startswith("# About")
    assert {"slug": "about-us", "title": "About us"} in client.get("/api/site").json()["nav_pages"]
    assert client.put("/api/admin/site", headers=h, json={"name": "X", "homepage": "nope"}).status_code == 400
    assert client.put("/api/admin/site", headers=h, json={"name": "X", "homepage": "about-us"}).status_code == 200
    client.delete(f"/api/admin/pages/{pid}", headers=h)
    assert client.get("/api/admin/site", headers=h).json()["homepage"] == "landing"
    client.put("/api/admin/site", headers=h, json={"name": "Coscribe", "seo": {"index": True}})


def test_workspace_reports_whether_models_are_set_up(client):
    """Members read this to learn why nothing drafts; it needs a login and exposes no keys."""
    client.cookies.clear()
    assert client.get("/api/auth/workspace").status_code == 401
    login(client)
    body = client.get("/api/auth/workspace").json()
    assert set(body) == {"ready", "admin_name"}
    assert isinstance(body["ready"], bool) and body["admin_name"]
