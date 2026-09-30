"""Render every prompt template with representative data so Jinja errors surface in CI, not in a paid LLM call."""

from app.learn.context import render


def test_paper_summary_renders():
    out = render(
        "paper_summary.j2",
        kind_name="Tool paper",
        paper="## Introduction\n\nText.",
        sections=[{"level": 2, "title": "Introduction", "words": 350}, {"level": 3, "title": "Sub", "words": 80}],
        total_words=4200,
    )
    assert "Tool paper" in out
    assert "## Introduction — 350 words" in out and "### Sub — 80 words" in out
    assert "4200 words" in out
    assert "=== PAPER" in out


def test_playbook_renders_with_and_without_kind_notes():
    base = dict(kind_name="Tool paper", summaries=['{"title": "A"}', '{"title": "B"}'])
    with_notes = render("playbook.j2", kind_notes="# Tool paper\n\nNotes.", **base)
    without = render("playbook.j2", kind_notes="", **base)
    assert "Notes." in with_notes and "Notes." not in without
    assert "--- Paper 2 ---" in without
    for key in ("structure", "argumentation", "evaluation", "related_work", "venue"):
        assert f'"{key}"' in without


def test_style_templates_render():
    s = render("style_sample.j2", sample="We built it. It works.")
    assert "We built it." in s
    p = render("style_profile.j2", profile_name="Nasir", stats='{"papers": 2}', observations=['{"openers": []}'])
    assert "# Voice: Nasir" in p and "--- Paper 1 ---" in p


def test_draft_system_forbids_invented_example_particulars():
    from app.learn.context import render

    out = render(
        "draft_system.j2", kind_name="Tool paper", profile="", house_style="", playbook="", facts="", ref_keys=""
    )
    assert "illustrative material" in out and "Never state a particular and then ask for it" in out


def test_interview_round_uses_scan_when_present():
    from app.learn.context import render

    base = dict(kind_name="Empirical study", spec="S", plan="", kind_rounds="R", playbook="", previous="")
    without = render("interview_round.j2", scan="", **base)
    assert "LITERATURE SCAN" not in without and "From the scan" not in without
    with_scan = render(
        "interview_round.j2", scan="- “Robots Are Here” (Prather, 2023)\n  abstract: novices and Copilot", **base
    )
    assert "LITERATURE SCAN" in with_scan and "Robots Are Here" in with_scan
    assert "From the scan (confirm before relying on it)" in with_scan
    chat = render("chat_system.j2", kind_name="k", title="t", spec="", plan="", interview="", scan="")
    assert "Sources page" in chat and "no scan yet" in chat


def test_voice_filter_drops_conflicting_advice_and_states_precedence():
    from app.studio import hygiene

    profile = "# Voice: X\n\n## Sentences\n- Uses em dashes for asides.\n- Long, layered sentences.\n"
    profile += "- Likes semicolons; a lot.\n"
    out = hygiene.filter_voice(profile)
    assert "em dashes" not in out and "semicolons" not in out.split("House style overrides")[0]
    assert "Long, layered sentences." in out and "House style overrides the voice on hygiene" in out
    assert hygiene.filter_voice("") == ""


def test_interview_round_addresses_the_starting_point():
    from app.learn.context import render

    base = dict(kind_name="Empirical study", spec="S", plan="", kind_rounds="R", playbook="", previous="", scan="")
    assert "who built something and wants to write a Empirical study about it." in render("interview_round.j2", **base)
    idea = render("interview_round.j2", entry="idea", **base)
    assert "has not run the study yet" in idea and "built something" not in idea
    draft = render("interview_round.j2", entry="draft", **base)
    assert "has already written a draft" in draft and "built something" not in draft
