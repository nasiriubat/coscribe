import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, ChevronLeft, Download, FileDown, Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { track } from "@/lib/events";
import type { ExportResult, JobInfo, PaperMeta, Project, TemplateInfo } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { useJobs } from "@/lib/jobs";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/input";
import { PageHeader, SectionTitle, Skeleton } from "@/components/ui/misc";
import { JobProgress } from "@/components/papers";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";

function AuthorsEditor({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ["paper-meta", slug], queryFn: () => api.get<PaperMeta>(`/api/projects/${slug}/paper-meta`) });
  const [form, setForm] = useState<PaperMeta | null>(null);
  useEffect(() => {
    if (meta.data && !form) setForm({ ...meta.data, keywords: meta.data.keywords ?? [] });
  }, [meta.data, form]);
  const save = useMutation({
    mutationFn: () => api.put<PaperMeta>(`/api/projects/${slug}/paper-meta`, form),
    onSuccess: (m) => {
      setForm(m);
      void qc.invalidateQueries({ queryKey: ["paper-meta", slug] });
      toast.success("Paper details saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!form) return <Skeleton className="h-40" />;
  const dirty = JSON.stringify(form) !== JSON.stringify({ ...meta.data, keywords: meta.data?.keywords ?? [] });
  const setAuthor = (i: number, patch: Partial<PaperMeta["authors"][number]>) => setForm({ ...form, authors: form.authors.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14.5px] font-semibold">Authors and keywords</h3>
        <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
          Save
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {form.authors.map((a, i) => (
          <div key={i} className="relative grid gap-2 rounded-[var(--radius-sm)] border border-border p-3 pr-10 sm:grid-cols-2">
            <Input value={a.name} onChange={(e) => setAuthor(i, { name: e.target.value })} placeholder="Full name" />
            <Input value={a.affiliation} onChange={(e) => setAuthor(i, { affiliation: e.target.value })} placeholder="Affiliation" />
            <Input value={a.email} onChange={(e) => setAuthor(i, { email: e.target.value })} placeholder="Email" />
            <Input value={a.country} onChange={(e) => setAuthor(i, { country: e.target.value })} placeholder="Country" />
            <button onClick={() => setForm({ ...form, authors: form.authors.filter((_, j) => j !== i) })} className="absolute right-2 top-2 rounded p-1.5 text-subtle hover:text-destructive" aria-label="Remove author">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <div>
          <Button variant="secondary" size="sm" onClick={() => setForm({ ...form, authors: [...form.authors, { name: "", affiliation: "", email: "", country: "", orcid: "" }] })}>
            <Plus className="h-3.5 w-3.5" /> Add author
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Keywords" hint="Comma separated.">
            <Input
              value={form.keywords.join(", ")}
              onChange={(e) =>
                setForm({
                  ...form,
                  keywords: e.target.value
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="Subtitle" hint="Optional.">
            <Input value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} />
          </Field>
        </div>
      </div>
    </Card>
  );
}

function TemplateCard({ t, selected, onSelect, onUpload, uploading, isAdmin }: { t: TemplateInfo; selected: boolean; onSelect: () => void; onUpload: (f: File) => void; uploading?: boolean; isAdmin: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <button onClick={onSelect} className={cn("rounded-[var(--radius)] border p-4 text-left transition-colors hover:bg-muted/50", selected ? "border-primary bg-primary-soft/40" : "border-border")}>
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-semibold">{t.name}</span>
        {t.ready ? <Badge variant="success">Ready</Badge> : <Badge variant="warning">Needs files</Badge>}
        {t.custom ? <Badge variant="outline">Custom</Badge> : null}
      </div>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{t.description}</p>
      {t.page_limit_hint ? <p className="mt-1 text-[12px] text-subtle">{t.page_limit_hint}</p> : null}
      {!t.ready ? (
        <div className="mt-2 rounded-[var(--radius-sm)] border border-warning/40 bg-warning-soft/40 p-2 text-[12px]">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              Missing {t.missing_files.join(", ")}. {t.notes}{" "}
              {t.download_url ? (
                <a href={t.download_url} target="_blank" rel="noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>
                  Get the files
                </a>
              ) : null}
            </span>
          </div>
          {isAdmin ? (
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".cls,.sty,.bst,.tex,.clo,.def,.cfg"
                className="hidden"
                onChange={(e) => {
                  Array.from(e.target.files ?? []).forEach(onUpload);
                  e.target.value = "";
                }}
              />
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={uploading} title="LaTeX .cls, .sty, .bst and support files, up to 5 MB each">
                <Upload className="h-3.5 w-3.5" /> Upload template files
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

export function ExportPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<{ templates: TemplateInfo[]; tools: { pandoc: boolean; tectonic: boolean } }>("/api/templates") });
  const exports = useQuery({ queryKey: ["exports", slug], queryFn: () => api.get<ExportResult[]>(`/api/projects/${slug}/exports`) });
  const [template, setTemplate] = useState<string>("");
  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "export") void qc.invalidateQueries({ queryKey: ["exports", slug] });
  });

  const run = useMutation({
    mutationFn: () => api.post<JobInfo>(`/api/projects/${slug}/exports`, { template, formats: ["pdf", "docx"] }),
    onSuccess: (job) => watch(job),
    onError: (e: Error) => toast.error(e.message),
  });
  const uploadTpl = useMutation({
    mutationFn: ({ slug: t, file }: { slug: string; file: File }) => api.upload<TemplateInfo>(`/api/templates/${t}/files`, file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template file added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const tools = templates.data?.tools;
  const tpls = templates.data?.templates ?? [];
  if (!template && tpls.length) setTemplate((tpls.find((t) => t.ready) ?? tpls[0]).slug);
  const selected = tpls.find((t) => t.slug === template);

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={
          <span className="flex gap-2">
            {tools && user?.role === "admin" ? (
              <>
                <Badge variant={tools.pandoc ? "success" : "warning"}>Pandoc {tools.pandoc ? "ready" : "missing"}</Badge>
                <Badge variant={tools.tectonic ? "success" : "warning"}>Tectonic {tools.tectonic ? "ready" : "missing"}</Badge>
              </>
            ) : tools && !(tools.pandoc && tools.tectonic) ? (
              <Badge variant="warning">PDF export is not set up on this server. Ask your administrator.</Badge>
            ) : null}
          </span>
        }
        title="Export"
        description="Sections become one Markdown file, then LaTeX in the venue's template, then PDF. DOCX comes from the same Markdown. Placeholders stay visible in red so nothing slips through."
        actions={
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={active || !p.counts.sections_drafted || !selected}>
            <FileDown className="h-4 w-4" /> Export as {selected?.name ?? "…"}
          </Button>
        }
      />

      {p.counts.checklist_open || p.counts.cite_requests ? (
        <Card className="mb-5 flex items-start gap-3 border-warning/40 bg-warning-soft/40 p-4 text-[13px]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <div className="font-semibold">The paper still has gaps</div>
            <div className="text-muted-foreground">
              {p.counts.checklist_open} open checklist item{p.counts.checklist_open === 1 ? "" : "s"}
              {p.counts.cite_requests ? ` and ${p.counts.cite_requests} claim${p.counts.cite_requests === 1 ? "" : "s"} without a source` : ""}. You can export a draft anyway; placeholders print in red.
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-5">
          <div>
            <SectionTitle>Template</SectionTitle>
            <div className="grid gap-3">
              {tpls.map((t) => (
                <TemplateCard key={t.slug} t={t} selected={template === t.slug} onSelect={() => setTemplate(t.slug)} onUpload={(file) => uploadTpl.mutate({ slug: t.slug, file })} uploading={uploadTpl.isPending && uploadTpl.variables?.slug === t.slug} isAdmin={user?.role === "admin"} />
              ))}
            </div>
          </div>
          <AuthorsEditor slug={slug} />
        </div>

        <div>
          <SectionTitle>Exports</SectionTitle>
          <JobProgress jobs={jobs} onDismiss={dismiss} />
          {exports.isLoading ? (
            <Skeleton className="h-32" />
          ) : (exports.data ?? []).length === 0 ? (
            <Card className="p-6 text-center text-[13px] text-muted-foreground">No exports yet. Pick a template and press Export.</Card>
          ) : (
            <div className="flex flex-col gap-3">
              {(exports.data ?? []).map((e) => (
                <Card key={e.stamp} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-semibold">{tpls.find((t) => t.slug === e.template)?.name ?? e.template}</span>
                    <span className="text-[12px] text-subtle">{timeAgo(new Date(`${e.stamp.slice(0, 4)}-${e.stamp.slice(4, 6)}-${e.stamp.slice(6, 8)}T${e.stamp.slice(9, 11)}:${e.stamp.slice(11, 13)}:${e.stamp.slice(13, 15)}Z`).toISOString())}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {e.files
                      .filter((f) => /\.(pdf|docx|zip)$/.test(f))
                      .map((f) => (
                        <a key={f} href={`/api/projects/${slug}/exports/${e.stamp}/${f}`} onClick={() => track("export_downloaded", { slug, meta: { file: f.split(".").pop() ?? "" } })} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted">
                          <Download className="h-3.5 w-3.5" /> {f}
                        </a>
                      ))}
                  </div>
                  {e.warnings.length ? (
                    <ul className="mt-2 flex flex-col gap-1 text-[12px] text-muted-foreground">
                      {e.warnings.map((w, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-warning" /> {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {e.compile_error ? <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">{e.compile_error}</pre> : null}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <NextStepBar p={p} current="export" />
    </div>
  );
}
