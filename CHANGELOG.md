# Changelog

## Unreleased

- Unsaved text is no longer lost silently: leaving a page with unsaved changes asks first, a
  reload gets the browser's prompt, the Studio saves your edits when you switch section, and
  tabbed editors keep their text when you change tab.
- "Skip for now" on Sources, Learn the pattern and Interview, with one line on what is lost.
- Draft-first projects go from the description straight to the Studio.
- Running jobs can be cancelled; a cancelled ingest leaves no half-read paper behind.
- A page that fails to load says whether the project is gone or the server did not answer, and
  offers Try again. A crashed page offers Reload.
- Members in a workspace without a connected model are told to ask the administrator.
- The progress strip marks the step you are on; the footer says "Still open from earlier" when
  it points back; each step has one name in the stepper, the breadcrumb and the page title.
- The interview prompt addresses idea-first and draft-first projects as such.

## 0.1.0 (2026-09-25)

First public release.

- Projects with three starting points: something built, an idea, or an existing draft.
- Exemplar papers from arXiv or PDF; a learned playbook of how papers of the kind are built.
- Optional author voice profiles learned from an author's own papers; the house style always
  wins on hygiene.
- Research design from an idea, interview rounds with suggested answers, a side chat with
  pinning, facts extraction, an approvable outline.
- Studio: section-by-section drafting from the outline only, `[NEEDS]` and `[CITE]` placeholders
  instead of invented content, house-style lint, Fix issues with a redline the author accepts,
  version history, a checklist of open items.
- References from Semantic Scholar, OpenAlex, arXiv, `.bib` import or by hand; a literature scan
  from the project's own idea; background readings read in full with a reading card; a Citations
  tab that shows what each cited paper says, the matching passage, and a verdict on demand;
  Find a source for any sentence.
- Figures from Mermaid or uploads; results tables from CSV or XLSX.
- Reviewer-style critique with venue suggestions; export to LNCS, ACM or a custom template as
  PDF, LaTeX zip and DOCX.
- Multi-user workspace with an admin: providers, a model per purpose, paper kinds, house style,
  users, site pages and SEO, storage cleanup and backups, usage, SMTP mail, an opt-in usage-event
  log with a study kit.
- Docker image with Docling for offline PDF extraction.
