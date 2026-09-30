import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, BookOpenCheck, Check, ExternalLink, Quote, Telescope } from "lucide-react";
import { api } from "@/lib/api";
import { track } from "@/lib/events";
import type { JobInfo, ScanCandidate, ScanState } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { cn, formatNumber, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { JobProgress } from "@/components/papers";

const GROUPS: Array<{ level: 3 | 2 | 1; label: string; hint: string }> = [
  { level: 3, label: "Strong match", hint: "Same problem or the same kind of tool. Read these first." },
  { level: 2, label: "Related", hint: "Worth citing in related work." },
  { level: 1, label: "Maybe", hint: "Tangential. Only if space allows." },
];

type Pick = { cite: boolean; exemplar: boolean; read: boolean };

/**
 * Finds papers for the project from its idea, plan and spec. The scan proposes; the author adopts,
 * either as verified references or, for arXiv papers, as exemplars the playbook learns from.
 */
export function LiteratureScan({ slug, projectId, compact }: { slug: string; projectId?: string; compact?: boolean }) {
  const qc = useQueryClient();
  const scan = useQuery({ queryKey: ["scan", slug], queryFn: () => api.get<{ scan: ScanState | null }>(`/api/projects/${slug}/references/scan`) });
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const { jobs, active, watch, dismiss } = useJobs({ project_id: projectId }, (j) => {
    if (j.type === "scan") {
      void qc.invalidateQueries({ queryKey: ["scan", slug] });
      setPicks({});
    }
  });
  const scanJobs = jobs.filter((j) => j.type === "scan");
  const scanning = scanJobs.some((j) => j.status === "queued" || j.status === "running");

  const run = useMutation({
    mutationFn: () => {
      track("scan_run", { slug });
      return api.post<JobInfo>(`/api/projects/${slug}/references/scan`);
    },
    onSuccess: (job) => watch(job),
    onError: (e: Error) => toast.error(e.message),
  });
  const adopt = useMutation({
    mutationFn: async () => {
      const cite = Object.entries(picks).filter(([, v]) => v.cite).map(([k]) => Number(k));
      const ex = Object.entries(picks).filter(([, v]) => v.exemplar).map(([k]) => Number(k));
      const rd = Object.entries(picks).filter(([, v]) => v.read).map(([k]) => Number(k));
      const out = { references: [] as string[], jobs: [] as JobInfo[], skipped: [] as string[], readJobs: 0 };
      if (cite.length) {
        const r = await api.post<typeof out>(`/api/projects/${slug}/references/scan/adopt`, { idx: cite, as_reference: true, as_exemplar: false });
        out.references = r.references;
      }
      if (ex.length) {
        const r = await api.post<typeof out>(`/api/projects/${slug}/references/scan/adopt`, { idx: ex, as_reference: false, as_exemplar: true });
        out.jobs = r.jobs;
        out.skipped = r.skipped;
      }
      if (rd.length) {
        const r = await api.post<typeof out>(`/api/projects/${slug}/references/scan/adopt`, { idx: rd, as_reference: false, as_reading: true });
        out.jobs = [...out.jobs, ...r.jobs];
        out.readJobs = r.jobs.length;
        out.skipped = [...out.skipped, ...r.skipped];
      }
      return out;
    },
    onSuccess: (r) => {
      r.jobs.forEach(watch);
      void qc.invalidateQueries({ queryKey: ["scan", slug] });
      void qc.invalidateQueries({ queryKey: ["references", slug] });
      void qc.invalidateQueries({ queryKey: ["papers"] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
      setPicks({});
      const parts = [];
      if (r.references.length) parts.push(`${r.references.length} reference${r.references.length === 1 ? "" : "s"} added`);
      const exJobs = r.jobs.length - r.readJobs;
      if (exJobs) parts.push(`${exJobs} example paper${exJobs === 1 ? "" : "s"} queued`);
      if (r.readJobs) parts.push(`${r.readJobs} reading${r.readJobs === 1 ? "" : "s"} queued`);
      if (r.skipped.length) parts.push(`${r.skipped.length} without arXiv source skipped`);
      toast.success(parts.join(" · ") || "Nothing to add");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = scan.data?.scan ?? null;
  const adoptedCount = useMemo(() => (data ? data.candidates.filter((c) => c.adopted_reference || c.adopted_exemplar || c.adopted_reading).length : 0), [data]);
  const [showAll, setShowAll] = useState(false);
  const collapsed = !!data && adoptedCount > 0 && !showAll;
  const counts = useMemo(() => {
    const cite = Object.values(picks).filter((v) => v.cite).length;
    const ex = Object.values(picks).filter((v) => v.exemplar).length;
    const rd = Object.values(picks).filter((v) => v.read).length;
    return { cite, ex, rd };
  }, [picks]);
  const toggle = (i: number, field: keyof Pick) =>
    setPicks((prev) => {
      const cur: Pick = prev[i] ?? { cite: false, exemplar: false, read: false };
      return { ...prev, [i]: { ...cur, [field]: !cur[field] } };
    });
  const selectAll = (level: number, field: keyof Pick) => {
    if (!data) return;
    setPicks((prev) => {
      const next = { ...prev };
      data.candidates.forEach((c, i) => {
        if (c.relevance !== level) return;
        if (field === "exemplar" && ((!c.arxiv_id && !c.pdf_url) || c.adopted_exemplar)) return;
        if (field === "read" && ((!c.arxiv_id && !c.pdf_url) || c.adopted_reading)) return;
        if (field === "cite" && c.adopted_reference) return;
        const cur: Pick = next[i] ?? { cite: false, exemplar: false, read: false };
        next[i] = { ...cur, [field]: true };
      });
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className={cn("flex flex-wrap items-center gap-4 p-4", !data && "border-dashed")}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Telescope className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">Find related papers</div>
          <p className="text-[13px] text-muted-foreground">
            Reads your idea, research plan and specification, writes a few search queries, asks Semantic Scholar, OpenAlex and arXiv, and ranks what comes back. You choose what to cite and what to learn from.
          </p>
          {data ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
              <span>Scanned {timeAgo(data.created_at)} ·</span>
              {data.queries.map((q, i) => (
                <span key={i} className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground" title={data.themes[i]}>
                  {q}
                </span>
              ))}
              {data.skipped_known ? <span>· {data.skipped_known} already in the project</span> : null}
              {data.errors.length ? (
                <Tooltip content={data.errors.join("\n")}>
                  <span className="text-warning">· {data.errors.length} search{data.errors.length === 1 ? "" : "es"} got no answer</span>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button onClick={() => run.mutate()} loading={run.isPending} disabled={scanning || active} variant={data ? "secondary" : "primary"}>
          <Telescope className="h-4 w-4" /> {data ? "Scan again" : "Scan the literature"}
        </Button>
      </Card>
      <JobProgress jobs={scanJobs} onDismiss={dismiss} />

      {data && data.candidates.length === 0 ? <p className="text-[13px] text-muted-foreground">The scan found nothing new. Add more detail to the specification and scan again.</p> : null}

      {collapsed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border bg-muted/40 px-3 py-2 text-[13px]">
          <span className="text-muted-foreground">
            {data!.candidates.length} candidates found, {adoptedCount} already in the project.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            Show the candidates
          </Button>
        </div>
      ) : null}

      {data && data.candidates.length && !collapsed ? (
        <div className={cn("flex flex-col gap-5", compact && "max-h-[60vh] overflow-y-auto pr-1")}>
          {adoptedCount > 0 ? (
            <button onClick={() => setShowAll(false)} className="self-start text-[12px] text-subtle hover:text-foreground">
              Hide the candidates
            </button>
          ) : null}
          {GROUPS.map((g) => {
            const rows = data.candidates.map((c, i) => [c, i] as const).filter(([c]) => c.relevance === g.level);
            if (!rows.length) return null;
            return (
              <section key={g.level}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-[13px] font-semibold uppercase tracking-wide text-subtle">{g.label}</span>
                    <span className="ml-2 text-[12px] text-muted-foreground">{g.hint}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => selectAll(g.level, "cite")}>
                      Cite all
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => selectAll(g.level, "read")}>
                      Read all
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => selectAll(g.level, "exemplar")}>
                      Example paper all
                    </Button>
                  </div>
                </div>
                <Card className="divide-y divide-border">
                  {rows.map(([c, i]) => (
                    <CandidateRow key={i} c={c} pick={picks[i]} onToggle={(f) => toggle(i, f)} />
                  ))}
                </Card>
              </section>
            );
          })}
        </div>
      ) : null}

      {counts.cite || counts.ex || counts.rd ? (
        <div className="sticky bottom-[76px] z-30 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-primary/40 bg-card px-4 py-3 shadow-[0_8px_24px_-12px_rgba(16,24,40,0.25)] md:bottom-4">
          <div className="text-[13px]">
            <span className="font-semibold">{counts.cite}</span> to cite · <span className="font-semibold">{counts.rd}</span> to read in full · <span className="font-semibold">{counts.ex}</span> as example paper{counts.ex === 1 ? "" : "s"}
            <span className="text-muted-foreground"> · citing is instant; reading and example papers fetch the paper and take a minute each, in the background.</span>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPicks({})}>
              Clear
            </Button>
            <Button size="sm" onClick={() => adopt.mutate()} loading={adopt.isPending}>
              <Check className="h-3.5 w-3.5" /> Add selected
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CandidateRow({ c, pick, onToggle }: { c: ScanCandidate; pick?: Pick; onToggle: (f: keyof Pick) => void }) {
  const authors = c.authors.length > 3 ? `${c.authors.slice(0, 3).join(", ")} et al.` : c.authors.join(", ");
  const citeDone = !!c.adopted_reference;
  const exDone = c.adopted_exemplar;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {c.url ? (
            <a href={c.url} target="_blank" rel="noreferrer" className="text-[14px] font-medium leading-snug hover:underline">
              {c.title} <ExternalLink className="inline h-3 w-3 text-subtle" />
            </a>
          ) : (
            <span className="text-[14px] font-medium leading-snug">{c.title}</span>
          )}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">
          {authors}
          {authors && c.year ? " · " : ""}
          {c.year ?? ""}
          {c.venue ? ` · ${c.venue}` : ""}
          {c.citation_count != null ? ` · ${formatNumber(c.citation_count)} citations` : ""}
        </div>
        {c.why ? <p className="mt-1 text-[13px]">{c.why}</p> : null}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {c.sources.map((s) => (
            <Badge key={s} variant="outline">
              {s}
            </Badge>
          ))}
          {c.arxiv_id ? <Badge variant="outline">arXiv {c.arxiv_id}</Badge> : c.pdf_url ? <Badge variant="outline">open PDF</Badge> : null}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 sm:flex-col sm:items-end">
        <PickToggle checked={citeDone || !!pick?.cite} done={citeDone} label={citeDone ? `Cited as ${c.adopted_reference}` : "Cite"} icon={Quote} onClick={() => onToggle("cite")} />
        {c.arxiv_id || c.pdf_url ? (
          <PickToggle
            checked={!!c.adopted_reading || !!pick?.read}
            done={!!c.adopted_reading}
            label={c.adopted_reading ? "Reading" : "Read in full"}
            icon={BookOpen}
            onClick={() => onToggle("read")}
          />
        ) : null}
        {c.arxiv_id || c.pdf_url ? (
          <PickToggle
            checked={exDone || !!pick?.exemplar}
            done={exDone}
            label={exDone ? "Example paper added" : c.arxiv_id ? "Use as example paper" : "Use as example paper (open PDF)"}
            icon={BookOpenCheck}
            onClick={() => onToggle("exemplar")}
          />
        ) : (
          <Tooltip content="No arXiv source or open-access PDF is known for this paper. Upload the PDF in Sources instead.">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-border px-2.5 text-[12.5px] text-subtle">
              <BookOpenCheck className="h-3.5 w-3.5" /> No open copy
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function PickToggle({ checked, done, label, icon: Icon, onClick }: { checked: boolean; done: boolean; label: string; icon: typeof Quote; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={done}
      aria-pressed={checked}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5 text-[12.5px] font-medium transition-colors",
        done ? "border-success/40 bg-success-soft text-success" : checked ? "border-primary bg-primary-soft text-primary" : "border-border-strong text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />} {label}
    </button>
  );
}
