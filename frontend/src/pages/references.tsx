import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, BookMarked, Check, ChevronLeft, Copy, Download, ExternalLink, Plus, Quote, Search, Telescope, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { track } from "@/lib/events";
import type { Project, RefCandidate, RefRecord, RefRequest } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/input";
import { EmptyState, PageHeader, SectionTitle, Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/dialogs";
import { NextStepBar } from "@/components/flow";
import { LiteratureScan } from "@/components/literature-scan";
import { ProjectLoadError } from "@/components/load-error";

function authorsLine(a: string[] | undefined, max = 3): string {
  if (!a?.length) return "";
  return a.length > max ? `${a.slice(0, max).join(", ")} et al.` : a.join(", ");
}

function ManualDialog({ slug, open, onOpenChange }: { slug: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: "", authors: "", year: "", venue: "", doi: "", url: "" });
  const add = useMutation({
    mutationFn: () =>
      api.post<RefRecord>(`/api/projects/${slug}/references/manual`, {
        title: f.title.trim(),
        authors: f.authors
          .split(/;|\band\b/)
          .map((s) => s.trim())
          .filter(Boolean),
        year: f.year ? Number(f.year) : null,
        venue: f.venue.trim() || null,
        doi: f.doi.trim() || null,
        url: f.url.trim() || null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["references", slug] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
      onOpenChange(false);
      setF({ title: "", authors: "", year: "", venue: "", doi: "", url: "" });
      toast.success(`Added as [@${r.key}]`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a reference by hand" description="For sources the search cannot find: reports, standards, tool documentation. You vouch for it, so it counts as verified.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
          className="flex flex-col gap-3"
        >
          <Field label="Title">
            <Input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
          </Field>
          <Field label="Authors" hint="Separate with semicolons: Smith, John; Doe, Jane">
            <Input value={f.authors} onChange={(e) => setF({ ...f, authors: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Year">
              <Input value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
            </Field>
            <Field label="Venue or publisher" className="col-span-2">
              <Input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="DOI">
              <Input value={f.doi} onChange={(e) => setF({ ...f, doi: e.target.value })} className="font-mono text-[12.5px]" />
            </Field>
            <Field label="URL">
              <Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} className="font-mono text-[12.5px]" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={add.isPending} disabled={f.title.trim().length < 3}>
              Add reference
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CandidateCard({ c, accepted, onAccept, busy }: { c: RefCandidate; accepted: boolean; onAccept: () => void; busy: boolean }) {
  return (
    <Card className={cn("p-4", accepted && "border-success/40")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-[14px] font-semibold leading-snug">{c.title}</h4>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            {authorsLine(c.authors)}
            {c.year ? ` · ${c.year}` : ""}
            {c.venue ? ` · ${c.venue}` : ""}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            {c.sources.map((s) => (
              <Badge key={s} variant="outline">
                {s === "semanticscholar" ? "Semantic Scholar" : s === "openalex" ? "OpenAlex" : "arXiv"}
              </Badge>
            ))}
            {typeof c.citation_count === "number" ? <span className="text-subtle">{c.citation_count} citations</span> : null}
            {c.doi ? <span className="font-mono text-subtle">doi:{c.doi}</span> : null}
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                Open <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
          {c.abstract ? <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground">{c.abstract}</p> : null}
        </div>
        <Button size="sm" variant={accepted ? "secondary" : "primary"} onClick={onAccept} disabled={accepted} loading={busy}>
          {accepted ? (
            <>
              <Check className="h-3.5 w-3.5" /> Added
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" /> Add
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}

export function ReferencesPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const refs = useQuery({ queryKey: ["references", slug], queryFn: () => api.get<RefRecord[]>(`/api/projects/${slug}/references`) });
  const requests = useQuery({ queryKey: ["ref-requests", slug], queryFn: () => api.get<RefRequest[]>(`/api/projects/${slug}/references/requests`) });
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RefCandidate[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [acceptedTitles, setAcceptedTitles] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [del, setDel] = useState<RefRecord | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const search = useMutation({
    mutationFn: (query: string) => api.post<{ results: RefCandidate[]; errors: string[] }>(`/api/projects/${slug}/references/search`, { q: query, limit: 12 }),
    onSuccess: (r) => {
      setResults(r.results);
      setErrors(r.errors);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const accept = useMutation({
    mutationFn: (c: RefCandidate) => api.post<RefRecord>(`/api/projects/${slug}/references`, { candidate: c }),
    onSuccess: (r, c) => {
      setAcceptedTitles((s) => new Set(s).add(c.title));
      void qc.invalidateQueries({ queryKey: ["references", slug] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
      toast.success(`Added as [@${r.key}]`);
      track("reference_added", { slug, meta: { source: "search" } });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/api/projects/${slug}/references/${key}`),
    onSuccess: () => {
      setDel(null);
      void qc.invalidateQueries({ queryKey: ["references", slug] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const importBib = useMutation({
    mutationFn: (f: File) => api.upload<{ added: string[]; skipped: string[] }>(`/api/projects/${slug}/references/import-bib`, f),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["references", slug] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
      toast.success(`Imported ${r.added.length} reference${r.added.length === 1 ? "" : "s"}${r.skipped.length ? `, skipped ${r.skipped.length} without a title` : ""}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resultsRef = useRef<HTMLDivElement>(null);
  const runSearch = (query: string) => {
    setQ(query);
    if (query.trim().length >= 2) {
      search.mutate(query.trim());
      window.setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };
  // "Search this claim" from the Studio arrives as ?q=; run it once and drop it from the URL.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("q");
  useEffect(() => {
    if (fromUrl) {
      runSearch(fromUrl);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl]);

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const list = refs.data ?? [];
  const reqs = requests.data ?? [];

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={list.length ? <Badge variant="success">{list.length} verified</Badge> : <Badge>None yet</Badge>}
        title="References"
        description="Every citation in the paper is a key that points to a record here. Records come from Semantic Scholar, OpenAlex, arXiv, a .bib file, or your own hand. The draft never cites anything else."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".bib,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importBib.mutate(f);
                e.target.value = "";
              }}
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={importBib.isPending}>
              <Upload className="h-4 w-4" /> Import .bib
            </Button>
            <Button variant="secondary" onClick={() => setManual(true)}>
              <Plus className="h-4 w-4" /> Add by hand
            </Button>
            <Button onClick={() => setScanOpen(true)}>
              <Telescope className="h-4 w-4" /> Suggest from my spec
            </Button>
          </>
        }
      />
      <Dialog open={scanOpen} onOpenChange={setScanOpen}>
        <DialogContent title="Find related papers" description="Suggestions from your idea, plan and specification. Nothing is cited until you add it." className="max-w-3xl">
          <LiteratureScan slug={slug} projectId={p.id} compact />
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          {reqs.length ? (
            <div className="mb-6">
              <SectionTitle>Needs a source</SectionTitle>
              <Card className="divide-y divide-border">
                {reqs.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <div>{r.text}</div>
                      <div className="text-[11.5px] text-subtle">{r.section}</div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => runSearch(r.query)}>
                      <Search className="h-3.5 w-3.5" /> Search
                    </Button>
                  </div>
                ))}
              </Card>
              <p className="mt-2 text-[12px] text-muted-foreground">
                These are [CITE] placeholders the draft left where a claim needs support. Add a reference, then replace the placeholder with its key in the Studio.
              </p>
            </div>
          ) : null}

          <div ref={resultsRef} className="scroll-mt-20" />
          <SectionTitle>Search</SectionTitle>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(q);
            }}
            className="mb-3 flex gap-2"
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, topic or claim, e.g. LLM ranking of procurement notices" />
            <Button type="submit" loading={search.isPending} disabled={q.trim().length < 2}>
              <Search className="h-4 w-4" /> Search
            </Button>
          </form>
          {errors.length ? (
            <div className="mb-3 rounded-[var(--radius-sm)] border border-warning/40 bg-warning-soft/40 px-3 py-2 text-[12.5px] text-muted-foreground">
              {errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          ) : null}
          {search.isPending ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : results === null ? (
            <EmptyState
              icon={<Search />}
              title="Search three academic indexes at once"
              description="Results are merged and deduplicated by DOI. Each added record keeps its metadata and abstract so the draft can cite it for the right claim."
              className="py-10"
            />
          ) : results.length === 0 ? (
            <EmptyState
              icon={<Search />}
              title={errors.length >= 3 ? "The indexes did not answer" : "Nothing found"}
              description={
                errors.length >= 3
                  ? "All three academic indexes are throttling this server right now. You can still add the reference by hand or import a .bib file; both count as verified because you vouch for them."
                  : "Try fewer, more specific words, or the exact title. If you know the paper, add it by hand."
              }
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setManual(true)}>
                    <Plus className="h-3.5 w-3.5" /> Add by hand
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5" /> Import .bib
                  </Button>
                  {q.trim() ? (
                    <Button size="sm" variant="ghost" onClick={() => runSearch(q)}>
                      Try again
                    </Button>
                  ) : null}
                </div>
              }
              className="py-10"
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {results.map((c, i) => (
                <CandidateCard
                  key={i}
                  c={c}
                  accepted={acceptedTitles.has(c.title) || list.some((r) => r.title.toLowerCase() === c.title.toLowerCase())}
                  onAccept={() => accept.mutate(c)}
                  busy={accept.isPending && accept.variables?.title === c.title}
                />
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionTitle
            right={
              list.length ? (
                <a href={`/api/projects/${slug}/references/bib`} download="refs.bib" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">
                  <Download className="h-3.5 w-3.5" /> refs.bib
                </a>
              ) : null
            }
          >
            In this paper
          </SectionTitle>
          {refs.isLoading ? (
            <Skeleton className="h-40" />
          ) : list.length === 0 ? (
            <EmptyState icon={<BookMarked />} title="No references yet" description="Search, import a .bib, or add by hand." className="py-8" />
          ) : (
            <div className="flex flex-col gap-2">
              {list.map((r) => (
                <Card key={r.key} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(`[@${r.key}]`);
                          toast.success(`Copied [@${r.key}]`);
                        }}
                        className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 font-mono text-[11.5px] text-success hover:opacity-80"
                        title="Copy citation"
                      >
                        <Quote className="h-3 w-3" /> @{r.key} <Copy className="h-3 w-3 opacity-60" />
                      </button>
                      <div className="mt-1.5 text-[13px] font-medium leading-snug">{r.title}</div>
                      <div className="mt-0.5 text-[12px] text-muted-foreground">
                        {authorsLine(r.authors, 2)}
                        {r.year ? ` · ${r.year}` : ""}
                        {r.venue ? ` · ${r.venue}` : ""}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-subtle">
                        <span>{r.source === "semanticscholar" ? "Semantic Scholar" : r.source === "openalex" ? "OpenAlex" : r.source === "arxiv" ? "arXiv" : r.source === "bib" ? ".bib" : r.source === "reading" ? "read in full" : r.source === "exemplar" ? "example paper" : "manual"}</span>
                        <span>· cited {r.uses} time{r.uses === 1 ? "" : "s"}</span>
                        {r.card ? (
                          <Badge variant="success" className="cursor-pointer" onClick={() => setOpenCard(openCard === r.key ? null : r.key)}>
                            reading card {openCard === r.key ? "▴" : "▾"}
                          </Badge>
                        ) : null}
                      </div>
                      {r.card && openCard === r.key ? (
                        <dl className="mt-2 grid gap-1.5 rounded-[var(--radius-sm)] bg-muted/40 p-3 text-[12.5px] leading-relaxed">
                          {(
                            [
                              ["Question", r.card.question],
                              ["Method", r.card.method],
                              ["Result", r.card.result],
                              ["Limitation", r.card.limitation],
                              ["Relation", r.card.relation],
                              ["Cite for", r.card.cite_for],
                            ] as Array<[string, string]>
                          ).map(([k, v]) => (
                            <div key={k}>
                              <span className="font-semibold text-subtle">{k}: </span>
                              {v || "not stated"}
                            </div>
                          ))}
                        </dl>
                      ) : null}
                    </div>
                    <button onClick={() => setDel(r)} className="rounded p-1.5 text-subtle hover:bg-destructive-soft hover:text-destructive" aria-label="Remove">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <NextStepBar p={p} current="references" />
      <ManualDialog slug={slug} open={manual} onOpenChange={setManual} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Remove this reference?"
        description={del ? `[@${del.key}] is cited ${del.uses} time${del.uses === 1 ? "" : "s"}. Those citations will show as unverified until you replace them.` : ""}
        confirmLabel="Remove"
        onConfirm={() => del && remove.mutate(del.key)}
        busy={remove.isPending}
      />
    </div>
  );
}
