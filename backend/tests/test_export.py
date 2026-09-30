import json
import subprocess
from pathlib import Path

from app.export import service as svc
from app.figures import service as figs


def test_latex_preprocess_and_fallback():
    md = (
        "# T\n\n## Intro\n\nWe cite [@a; @b] and [@c]. [NEEDS: a number] and [CITE: some claim].\n\n"
        "- one\n- two\n\n![Arch](figures/arch.svg){#fig:arch}\n"
    )
    tex = svc._fallback_md_to_latex(svc._preprocess_for_latex(md))
    assert "\\cite{a,b}" in tex and "\\cite{c}" in tex
    assert "\\needs{a number}" in tex and "\\citeneeded{some claim}" in tex
    assert "\\section{Intro}" in tex
    assert "\\begin{itemize}" in tex and "\\item one" in tex
    assert "\\includegraphics[width=\\linewidth,height=0.4\\textheight,keepaspectratio]{figures/arch.png}" in tex
    assert "\\label{fig:arch}" in tex


def test_tex_escape_and_inline():
    assert svc._tex_escape("A & B 100% #1 _x_") == "A \\& B 100\\% \\#1 \\_x\\_"
    s = svc._inline("**bold** and *em* with `code` [@k] stays")
    assert "\\textbf{bold}" in s and "\\emph{em}" in s and "\\texttt{code}" in s


def test_templates_seeded_and_status(tmp_path, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "data_dir", tmp_path)
    svc.seed_templates()
    tpls = {t["slug"]: t for t in svc.list_templates()}
    assert set(tpls) >= {"lncs", "acm"}
    assert tpls["acm"]["ready"] is True
    assert tpls["lncs"]["ready"] is False and "llncs.cls" in tpls["lncs"]["missing_files"]
    svc.add_template_file("lncs", "llncs.cls", b"% fake class")
    svc.add_template_file("lncs", "splncs04.bst", b"% fake bst")
    assert svc.template("lncs")["ready"] is True
    try:
        svc.add_template_file("lncs", "evil.sh", b"x")
        raise AssertionError("should reject")
    except ValueError:
        pass
    custom = svc.create_custom_template(
        "My Workshop", "d", "article", "plain", "\\documentclass{article}\\begin{document}<< body >>\\end{document}"
    )
    assert custom["custom"] is True and custom["slug"] == "my-workshop"


def test_wrapper_renders():
    from app.config import get_settings

    tpl_dir = get_settings().seed_dir / "templates" / "lncs"
    tex = svc.render_wrapper(
        tpl_dir,
        {
            "title": "T",
            "subtitle": "",
            "authors": [{"name": "Ada Lovelace", "orcid": ""}],
            "running_authors": "Lovelace",
            "institutes": ["Tampere University"],
            "abstract": "Abs.",
            "keywords": ["a", "b"],
            "keywords_lncs": "a \\and b",
            "keywords_csv": "a, b",
            "body": "\\section{X}",
            "has_bib": True,
            "venue": "PROFES 2027",
        },
    )
    assert "\\documentclass[runningheads]{llncs}" in tex and "\\title{T}" in tex and "\\author{Ada Lovelace}" in tex
    assert "\\keywords{a \\and b}" in tex and "\\bibliographystyle{splncs04}" in tex
    tpl_dir = get_settings().seed_dir / "templates" / "acm"
    tex = svc.render_wrapper(
        tpl_dir,
        {
            "title": "T",
            "subtitle": "",
            "authors": [{"name": "A", "orcid": "", "email": "a@x", "affiliation": "U", "country": "FI"}],
            "running_authors": "A",
            "institutes": ["U"],
            "abstract": "",
            "keywords": [],
            "keywords_lncs": "",
            "keywords_csv": "",
            "venue": "PROFES 2027",
            "body": "",
            "has_bib": False,
        },
    )
    assert "\\documentclass[sigconf" in tex and "\\email{a@x}" in tex and "\\institution{U}" in tex
    assert "\\acmConference[PROFES 2027]{PROFES 2027}{}{}" in tex and "\\setcopyright{none}" in tex


def test_figures_store(tmp_path: Path):
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", root], check=True)
    f = figs.create_mermaid(root, "System Architecture", "The architecture.", "flowchart LR\n  A --> B")
    assert f["name"] == "system-architecture" and f["kind"] == "mermaid" and f["file"] is None
    assert figs.source(root, f).startswith("flowchart LR")
    figs.store_render(root, "system-architecture", b"<svg/>", b"\x89PNGxxxx")
    f = figs.get(root, "system-architecture")
    assert f["file"] == "system-architecture.svg" and f["png_file"] == "system-architecture.png"
    # editing the source invalidates renders
    f = figs.update(root, "system-architecture", source="flowchart TD\n  A --> C")
    assert f["file"] is None and f["png_file"] is None
    img = figs.create_image(root, "results", "Recall per company", b"\x89PNGdata", "image/png")
    assert img["file"] == "results.png" and img["png_file"] == "results.png"
    assert figs.file_path(root, "results").name == "results.png"
    assert figs.delete(root, "results") and figs.get(root, "results") is None
    assert len(json.loads((root / "figures" / "index.json").read_text())) == 1


def test_assemble_markdown(tmp_path: Path):
    root = tmp_path / "proj"
    (root / "sections").mkdir(parents=True)
    (root / "sections" / "index.json").write_text(
        json.dumps(
            {
                "sections": [
                    {"id": "1", "order": 1, "title": "Abstract", "file": "01.md"},
                    {"id": "2", "order": 2, "title": "Introduction", "file": "02.md"},
                ]
            }
        )
    )
    (root / "sections" / "01.md").write_text("Short abstract.")
    (root / "sections" / "02.md").write_text("Intro text.")
    abstract, body, _ = svc.assemble_markdown(root, "My Paper")
    assert abstract == "Short abstract."
    assert body.startswith("# My Paper\n\n## Introduction\n\nIntro text.")
    docx_md = svc.markdown_for_docx(abstract, body + " [NEEDS: x]")
    assert "**Abstract.** Short abstract." in docx_md and "**[NEEDS: x]**" in docx_md


def test_authors_are_normalised_for_wrappers():
    from app.config import get_settings

    assert svc.normalise_authors(None)[0]["name"].startswith("[NEEDS")
    got = svc.normalise_authors([{"name": "Ada"}, {"name": ""}, "junk"])
    assert got == [{"name": "Ada", "affiliation": "", "email": "", "country": "", "orcid": ""}]
    # the ACM wrapper reads orcid/email/affiliation/country; a bare author must not crash it
    tex = svc.render_wrapper(
        get_settings().seed_dir / "templates" / "acm",
        {
            "title": "T",
            "subtitle": "",
            "authors": got,
            "running_authors": "Ada",
            "institutes": [""],
            "abstract": "",
            "keywords": [],
            "keywords_lncs": "",
            "keywords_csv": "",
            "venue": "",
            "body": "",
            "has_bib": False,
        },
    )
    assert "\\author{Ada}" in tex


def test_bibliography_only_when_cited():
    assert svc.has_citations("Text \\cite{smith2020} more.") is True
    assert svc.has_citations("", "\\citep{a}") is True
    assert svc.has_citations("No citations here.", "") is False


def test_figure_references_resolve_for_latex_and_docx():
    body = (
        "Intro.\n\n![Arch](figures/arch.svg){#fig:arch}\n\n"
        "See Figure @fig:arch and Figure @fig:none.\n\n![B](figures/b.png)\n"
    )
    assert svc.figure_numbers(body) == {"arch": 1, "b": 2}
    assert "\\ref{fig:arch}" in svc.resolve_fig_refs(body, "latex")
    docx = svc.markdown_for_docx("", body)
    assert "Figure 1 and Figure ?" in docx
