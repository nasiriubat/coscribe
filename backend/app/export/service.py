"""Export (SPEC 4.10): sections -> Markdown -> LaTeX body (Pandoc) -> venue wrapper -> PDF (Tectonic); DOCX via Pandoc.

Outputs land in exports/<stamp>/ with paper.md, main.tex, refs.bib, figures/, main.pdf, paper.docx
and paper-latex.zip. Missing tools degrade gracefully: the LaTeX zip is always produced.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from jinja2 import Environment, StrictUndefined

from .. import storage
from ..config import get_settings
from ..figures import service as figures
from ..jobs import JobContext
from ..studio import service as studio

# One Tectonic at a time: its package cache is shared, and on a fresh volume three exports
# started together failed with "font cmr10 not loadable" while each downloaded the same files.
_TECTONIC_LOCK = asyncio.Lock()
_FIG_SIZE = "width=\\linewidth,height=0.4\\textheight,keepaspectratio"

_CITE = re.compile(r"\[(@[^\]]+)\]")
_NEEDS = re.compile(r"\[NEEDS:\s*([^\]]+)\]")
_CITEP = re.compile(r"\[CITE:\s*([^\]]+)\]")
_FIG = re.compile(r"!\[([^\]]*)\]\(figures/([a-z0-9\-]+)\.[a-z]+\)(\{#fig:([a-z0-9\-]+)\})?")


def _now_stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S")


# ------------------------------------------------------------------ templates


def templates_dir() -> Path:
    return get_settings().data_dir / "templates"


def seed_templates() -> None:
    src = get_settings().seed_dir / "templates"
    if not src.exists():
        return
    for d in src.iterdir():
        if d.is_dir():
            dst = templates_dir() / d.name
            dst.mkdir(parents=True, exist_ok=True)
            for f in d.iterdir():
                # Built-in wrapper and metadata follow the shipped version; uploaded class files are kept.
                if f.is_file() and (f.name in ("meta.json", "wrapper.tex.j2") or not (dst / f.name).exists()):
                    shutil.copy2(f, dst / f.name)


def list_templates() -> list[dict]:
    out = []
    td = templates_dir()
    if not td.exists():
        return out
    for d in sorted(td.iterdir()):
        meta_p = d / "meta.json"
        if not d.is_dir() or not meta_p.exists():
            continue
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        present = {f.name for f in d.iterdir() if f.is_file()}
        missing = [f for f in meta.get("required_files", []) if f not in present]
        out.append({**meta, "slug": d.name, "missing_files": missing, "ready": not missing, "files": sorted(present)})
    return out


def template(slug: str) -> dict | None:
    return next((t for t in list_templates() if t["slug"] == slug), None)


def add_template_file(slug: str, filename: str, data: bytes) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.\-]{1,80}", filename) or filename in ("meta.json", "wrapper.tex.j2"):
        raise ValueError("Bad file name")
    if Path(filename).suffix.lower() not in (".cls", ".sty", ".bst", ".tex", ".bib", ".clo", ".def", ".cfg"):
        raise ValueError("Only LaTeX class, style, bibliography style and support files are accepted")
    d = templates_dir() / slug
    if not (d / "meta.json").exists():
        raise ValueError("Unknown template")
    (d / filename).write_bytes(data)


def create_custom_template(name: str, description: str, class_name: str, bib_style: str, wrapper: str) -> dict:
    slug = storage.slugify(name, max_length=40) or "custom"
    d = templates_dir() / slug
    n = 2
    while d.exists():
        d = templates_dir() / f"{slug}-{n}"
        n += 1
    d.mkdir(parents=True)
    (d / "meta.json").write_text(
        json.dumps(
            {
                "name": name,
                "description": description,
                "class": class_name,
                "bib_style": bib_style,
                "bib_engine": "bibtex",
                "required_files": [],
                "page_limit_hint": "",
                "notes": "Custom template.",
                "custom": True,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (d / "wrapper.tex.j2").write_text(wrapper, encoding="utf-8")
    return template(d.name)


# ------------------------------------------------------------------ tools


def tool(name: str) -> str | None:
    """Find a tool on PATH or inside the backend virtualenv's bin."""
    found = shutil.which(name)
    if found:
        return found
    venv_bin = Path(__file__).resolve().parents[2] / ".venv" / "bin" / name
    return str(venv_bin) if venv_bin.exists() else None


def tools_status() -> dict:
    return {"pandoc": bool(tool("pandoc")), "tectonic": bool(tool("tectonic"))}


# ------------------------------------------------------------------ assembly


def paper_meta(root: Path) -> dict:
    p = root / "inputs" / "meta.json"
    data = {"authors": [], "keywords": [], "subtitle": ""}
    if p.exists():
        try:
            data.update(json.loads(p.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    return data


def save_paper_meta(root: Path, data: dict) -> dict:
    storage.write_text(root / "inputs" / "meta.json", json.dumps(data, indent=2, ensure_ascii=False))
    storage.git_commit(root, "Paper metadata")
    return data


def assemble_markdown(root: Path, title: str) -> tuple[str, str, list[dict]]:
    """Return (abstract_md, body_md, sections). The section titled Abstract is split out."""
    index = studio.load_index(root)
    abstract = ""
    parts = []
    for s in sorted(index["sections"], key=lambda x: x["order"]):
        text = studio.read_section(root, s).strip()
        if s["title"].strip().lower() == "abstract":
            abstract = text
            continue
        title_line = re.sub(r"^\d+\.\s*", "", s["title"])
        parts.append(f"## {title_line}\n\n{text}\n" if text else f"## {title_line}\n\n")
    body = f"# {title}\n\n" + "\n".join(parts)
    return abstract, body, index["sections"]


_FIG_REF = re.compile(r"@fig:([a-z0-9\-]+)")


def figure_numbers(body: str) -> dict[str, int]:
    """Figure labels in order of appearance, numbered from 1, as LaTeX will number them."""
    numbers: dict[str, int] = {}
    for m in _FIG.finditer(body):
        label = m.group(4) or m.group(2)
        if label not in numbers:
            numbers[label] = len(numbers) + 1
    return numbers


def resolve_fig_refs(md: str, mode: str, numbers: dict[str, int] | None = None) -> str:
    """`Figure @fig:name` in prose: \\ref for LaTeX, the number for DOCX, '?' when the figure is missing."""
    if mode == "latex":
        return _FIG_REF.sub(lambda m: "\\ref{fig:" + m.group(1) + "}", md)
    nums = numbers or {}
    return _FIG_REF.sub(lambda m: str(nums.get(m.group(1), "?")), md)


def markdown_for_docx(abstract: str, body: str) -> str:
    """Pandoc-citeproc friendly Markdown: keep [@key] as is, render placeholders as bold red-ish text."""
    md = resolve_fig_refs(body, "docx", figure_numbers(body))
    if abstract:
        md = md.replace("\n\n", f"\n\n**Abstract.** {abstract}\n\n", 1)
    md = _NEEDS.sub(lambda m: f"**[NEEDS: {m.group(1).strip()}]**", md)
    md = _CITEP.sub(lambda m: f"**[CITE: {m.group(1).strip()}]**", md)
    return md


def _preprocess_for_latex(md: str) -> str:
    # LaTeX gets the PNG render of every figure (Pandoc would emit \includesvg for .svg paths).
    md = re.sub(r"\(figures/([a-z0-9\-]+)\.(svg|jpg|jpeg|webp|pdf)\)", r"(figures/\1.png)", md)
    md = resolve_fig_refs(md, "latex")
    md = _CITE.sub(lambda m: "\\cite{" + ",".join(k.strip().lstrip("@") for k in m.group(1).split(";")) + "}", md)
    md = _NEEDS.sub(lambda m: "\\needs{" + _tex_escape(m.group(1).strip()) + "}", md)
    md = _CITEP.sub(lambda m: "\\citeneeded{" + _tex_escape(m.group(1).strip()) + "}", md)
    return md


def _tex_escape(s: str) -> str:
    return re.sub(r"([&%$#_{}])", r"\\\1", s)


def _fallback_md_to_latex(md: str) -> str:
    """Used only when Pandoc is unavailable: headings, paragraphs, emphasis, lists, figures."""
    out = []
    in_list = False
    for raw in md.splitlines():
        line = raw.rstrip()
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            if in_list:
                out.append("\\end{itemize}")
                in_list = False
            level = len(m.group(1))
            cmd = {1: "", 2: "\\section", 3: "\\subsection", 4: "\\subsubsection"}[level]
            if cmd:
                out.append(f"{cmd}{{{_tex_escape(m.group(2))}}}")
            continue
        fm = _FIG.match(line.strip())
        if fm:
            cap, name = fm.group(1), fm.group(2)
            label = fm.group(4) or name
            out.append(
                f"\\begin{{figure}}[t]\\centering\\includegraphics[{_FIG_SIZE}]{{figures/{name}.png}}\\caption{{{_tex_escape(cap)}}}\\label{{fig:{label}}}\\end{{figure}}"
            )
            continue
        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                out.append("\\begin{itemize}")
                in_list = True
            out.append("\\item " + _inline(re.sub(r"^\s*[-*]\s+", "", line)))
            continue
        if in_list and not line.strip():
            out.append("\\end{itemize}")
            in_list = False
        if line.startswith("\\"):
            out.append(line)
        else:
            out.append(_inline(line))
    if in_list:
        out.append("\\end{itemize}")
    return "\n".join(out)


def _inline(s: str) -> str:
    keep = {}

    def stash(m):
        k = f"@@{len(keep)}@@"
        keep[k] = m.group(0)
        return k

    s = re.sub(r"\\(cite|needs|citeneeded)\{[^}]*\}", stash, s)
    s = _tex_escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\\textbf{\1}", s)
    s = re.sub(r"\*(.+?)\*", r"\\emph{\1}", s)
    s = re.sub(r"`(.+?)`", r"\\texttt{\1}", s)
    for k, v in keep.items():
        s = s.replace(k, v)
    return s


def markdown_to_latex(md: str, workdir: Path) -> tuple[str, str]:
    """Returns (latex, method)."""
    pre = _preprocess_for_latex(md)
    pandoc = tool("pandoc")
    if pandoc:
        r = subprocess.run(
            [
                pandoc,
                "-f",
                "markdown+raw_tex",
                "-t",
                "latex",
                "--wrap=none",
                "--top-level-division=section",
                "--shift-heading-level-by=-1",
            ],
            input=pre,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            cwd=workdir,
        )
        if r.returncode == 0 and r.stdout.strip():
            tex = r.stdout
            # Pandoc renders ![cap](figures/x.svg){#fig:x} into a figure with the svg path; point it at the png.
            tex = re.sub(r"figures/([a-z0-9\-]+)\.(svg|jpg|jpeg|webp)", r"figures/\1.png", tex)
            tex = tex.replace("\\includesvg", "\\includegraphics")
            # graphicx's alt= key is newer than many TeX distributions; drop it.
            tex = re.sub(r"(\\includegraphics\[[^\]]*?),?alt=\{[^}]*\}", r"\1", tex)
            # One size rule for every figure: fit the column, never taller than ~40% of the page,
            # keep the shape. Without it a tall diagram ran off the page and a PNG kept its pixel size.
            tex = re.sub(r"\\includegraphics(\[[^\]]*\])?\{", lambda m: "\\includegraphics[" + _FIG_SIZE + "]{", tex)
            return tex, "pandoc"
    return _fallback_md_to_latex(pre), "fallback"


def _strip_top_title(tex: str, title: str) -> str:
    # With --top-level-division=section the H1 becomes \section{Title}; drop it, the wrapper sets \title.
    esc = re.escape(_tex_escape(title))
    return re.sub(r"\\section\{" + esc + r"\}(\\label\{[^}]*\})?\n*", "", tex, count=1)


_CITE_CMD = re.compile(r"\\(?:cite[tp]?|citep|citet|autocite|textcite)\*?\{")


def has_citations(*tex: str) -> bool:
    return any(_CITE_CMD.search(t or "") for t in tex)


AUTHOR_FIELDS = ("name", "affiliation", "email", "country", "orcid")


def normalise_authors(authors: list[dict] | None) -> list[dict]:
    """Every wrapper may read every author field, so missing keys become empty strings.

    A project exported before its paper metadata is filled in gets one visible placeholder
    author instead of a template crash.
    """
    out = []
    for a in authors or []:
        if not isinstance(a, dict) or not str(a.get("name", "")).strip():
            continue
        out.append({f: str(a.get(f) or "") for f in AUTHOR_FIELDS})
    return out or [{"name": "[NEEDS: author names]", "affiliation": "", "email": "", "country": "", "orcid": ""}]


def render_wrapper(tpl_dir: Path, ctx: dict) -> str:
    # LaTeX is full of "{{", "{%" and "{#", so wrappers use << >>, <% %> and <# #> instead.
    env = Environment(
        undefined=StrictUndefined,
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
        variable_start_string="<<",
        variable_end_string=">>",
        block_start_string="<%",
        block_end_string="%>",
        comment_start_string="<#",
        comment_end_string="#>",
    )
    return env.from_string((tpl_dir / "wrapper.tex.j2").read_text(encoding="utf-8")).render(**ctx)


# ------------------------------------------------------------------ export job


def _pack_latex_zip(out: Path, zip_path: Path) -> None:
    """Zip the export folder for Overleaf, minus the derived DOCX and its scratch Markdown."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in out.rglob("*"):
            if f.is_file() and f.suffix not in (".zip", ".docx") and f.name != "paper-docx.md":
                z.write(f, f.relative_to(out))


async def run_export(project_id: str, ctx: JobContext, *, template_slug: str, formats: list[str]) -> dict:
    from ..db import SessionLocal
    from ..models import Project

    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if not project:
            raise ValueError("Project not found")
        db.expunge(project)
    root = storage.project_dir(project.slug)
    tpl = template(template_slug)
    if not tpl:
        raise ValueError("Unknown template")
    tpl_dir = templates_dir() / template_slug
    meta = paper_meta(root)
    stamp = _now_stamp()
    out = root / "exports" / stamp
    out.mkdir(parents=True, exist_ok=True)
    result: dict = {"stamp": stamp, "template": template_slug, "files": [], "warnings": [], "tools": tools_status()}

    ctx.progress(5, "Assembling sections")
    abstract, body_md, sections = assemble_markdown(root, project.title)
    if not any(studio.read_section(root, s).strip() for s in sections):
        raise ValueError("No drafted sections to export")
    storage.write_text(out / "paper.md", (f"**Abstract.** {abstract}\n\n" if abstract else "") + body_md)
    result["files"].append("paper.md")

    # figures: copy png renders (and svg for reference)
    fig_out = out / "figures"
    fig_out.mkdir(exist_ok=True)
    used = set(re.findall(r"figures/([a-z0-9\-]+)\.[a-z]+", body_md))
    for f in figures.load(root):
        for key in ("png_file", "file"):
            if f.get(key):
                src = root / "figures" / f[key]
                if src.exists():
                    shutil.copy2(src, fig_out / f[key])
        if f["name"] in used and not f.get("png_file"):
            result["warnings"].append(
                f"Figure '{f['name']}' has no PNG render yet; open it on the Figures page to render it."
            )
    bib_src = root / "references" / "refs.bib"
    has_records = bib_src.exists() and bib_src.stat().st_size > 0
    if has_records:
        shutil.copy2(bib_src, out / "refs.bib")
        result["files"].append("refs.bib")

    ctx.progress(25, "Converting Markdown to LaTeX")
    # The wrapper sets \title; strip the H1 so ## headings become \section (not 0.1 subsections).
    body_no_title = re.sub(r"^# .*\n+", "", body_md, count=1)
    # Pandoc shells out (and Tectonic below runs for minutes); jobs share the one event loop,
    # so every blocking subprocess is offloaded to a thread to keep the app responsive (SPEC 3.3).
    body_tex, method = await asyncio.to_thread(markdown_to_latex, body_no_title, out)
    if method == "fallback":
        result["warnings"].append(
            "Pandoc is not installed here; a simpler converter was used for LaTeX (tables and math may need attention)."
        )
    abstract_tex, _ = await asyncio.to_thread(markdown_to_latex, abstract, out) if abstract else ("", method)
    # A bibliography with no \cite prints an empty "References" heading; include it only when used.
    has_bib = has_records and has_citations(body_tex, abstract_tex)
    if has_records and not has_bib:
        result["warnings"].append("No section cites a verified reference yet, so the PDF has no reference list.")
    authors = normalise_authors(meta.get("authors"))
    institutes = []
    for a in authors:
        inst = " ".join(x for x in (a.get("affiliation", ""), a.get("country", "")) if x).strip()
        if inst and inst not in institutes:
            institutes.append(inst)
    wrapper = render_wrapper(
        tpl_dir,
        {
            "title": _tex_escape(project.title),
            "subtitle": _tex_escape(meta.get("subtitle") or ""),
            "authors": [{**a, "name": _tex_escape(a.get("name", ""))} for a in authors],
            "running_authors": _tex_escape(
                ", ".join(a.get("name", "").split()[-1] for a in authors if a.get("name"))[:60] or "Authors"
            ),
            "institutes": [_tex_escape(i) for i in institutes] or [""],
            "abstract": abstract_tex.strip(),
            "keywords": [_tex_escape(k) for k in meta.get("keywords") or []],
            "keywords_lncs": " \\and ".join(_tex_escape(k) for k in meta.get("keywords") or []),
            "keywords_csv": ", ".join(_tex_escape(k) for k in meta.get("keywords") or []),
            "body": body_tex,
            "has_bib": has_bib,
            "venue": _tex_escape(project.venue or ""),
        },
    )
    storage.write_text(out / "main.tex", wrapper)
    result["files"].append("main.tex")
    for f in tpl_dir.iterdir():
        if f.is_file() and f.name not in ("meta.json", "wrapper.tex.j2"):
            shutil.copy2(f, out / f.name)
            result["files"].append(f.name)

    if "pdf" in formats:
        tectonic = tool("tectonic")
        if not tectonic:
            result["warnings"].append(
                "Tectonic is not installed here, so no PDF. "
                "Download the LaTeX zip and compile it, or use the Docker image."
            )
        elif tpl["missing_files"]:
            result["warnings"].append(
                f"Template is missing {', '.join(tpl['missing_files'])}; upload them under Export to compile a PDF."
            )
        else:
            ctx.progress(50, "Compiling PDF with Tectonic")
            async with _TECTONIC_LOCK:
                r = await asyncio.to_thread(
                    subprocess.run,
                    [tectonic, "-X", "compile", "--keep-logs", "--untrusted", "main.tex"],
                    capture_output=True,
                    text=True,
                    timeout=600,
                    check=False,
                    cwd=out,
                )
            log = (r.stdout + "\n" + r.stderr)[-6000:]
            storage.write_text(out / "compile.log", log)
            if r.returncode == 0 and (out / "main.pdf").exists():
                result["files"].append("main.pdf")
            else:
                result["warnings"].append("PDF compilation failed; see compile.log in the export.")
                errors = [ln for ln in log.splitlines() if ln.startswith("error")]
                result["compile_error"] = "\n".join(errors[-8:]) if errors else log[-1500:]

    if "docx" in formats:
        pandoc = tool("pandoc")
        if not pandoc:
            result["warnings"].append("Pandoc is not installed here, so no DOCX.")
        else:
            ctx.progress(75, "Building DOCX with Pandoc")
            md = markdown_for_docx(abstract, body_md)
            md = re.sub(r"\(figures/([a-z0-9\-]+)\.(svg|jpg|jpeg|webp|pdf)\)", r"(figures/\1.png)", md)
            storage.write_text(out / "paper-docx.md", md)
            cmd = [pandoc, "paper-docx.md", "-o", "paper.docx", "--from", "markdown"]
            if has_bib:
                cmd += ["--citeproc", "--bibliography", "refs.bib"]
            r = await asyncio.to_thread(
                subprocess.run, cmd, capture_output=True, text=True, timeout=300, check=False, cwd=out
            )
            if r.returncode == 0 and (out / "paper.docx").exists():
                result["files"].append("paper.docx")
            else:
                result["warnings"].append("DOCX build failed: " + (r.stderr or "unknown error")[-500:])

    ctx.progress(90, "Packing the LaTeX zip")
    zip_path = out / "paper-latex.zip"
    await asyncio.to_thread(_pack_latex_zip, out, zip_path)
    result["files"].append("paper-latex.zip")
    storage.write_text(out / "result.json", json.dumps(result, indent=2))
    ctx.progress(100, f"Export ready: {', '.join(result['files'])}")
    return result


def list_exports(root: Path) -> list[dict]:
    d = root / "exports"
    if not d.exists():
        return []
    out = []
    for e in sorted(d.iterdir(), reverse=True):
        rp = e / "result.json"
        if e.is_dir() and rp.exists():
            try:
                out.append(json.loads(rp.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
    return out[:20]


def export_file(root: Path, stamp: str, filename: str) -> Path | None:
    if not re.fullmatch(r"\d{8}-\d{6}", stamp) or not re.fullmatch(r"[A-Za-z0-9_.\-]+", filename):
        return None
    p = (root / "exports" / stamp / filename).resolve()
    return p if p.exists() and (root / "exports").resolve() in p.parents else None
