import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import type { JobInfo, Project } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownEditor } from "@/components/markdown-editor";
import { BUDGETS, JobProgress } from "@/components/papers";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";
import { stepTitle } from "@/lib/flow";

const FILES = [
  { key: "structure", label: "Structure", hint: "Section order, purpose and length." },
  { key: "argumentation", label: "Argumentation", hint: "How the problem is set up and contributions are stated." },
  { key: "evaluation", label: "Evaluation", hint: "What counts as evidence and how it is reported." },
  { key: "related-work", label: "Related work", hint: "How prior work is grouped and positioned against." },
  { key: "venue", label: "Venue", hint: "Target venue, page budget, formatting signals." },
];

export function BudgetPicker({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {BUDGETS.map((b) => (
        <button
          key={b.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(b.value)}
          className={cn(
            "rounded-[var(--radius-sm)] border p-3 text-left transition-colors hover:bg-muted disabled:opacity-60",
            value === b.value ? "border-primary bg-primary-soft/60" : "border-border",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold">{b.label}</span>
            {b.value === 40_000 ? <span className="text-[10.5px] font-medium uppercase tracking-wide text-primary">Recommended</span> : null}
          </div>
          <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{b.hint}</div>
          <div className="mt-1 text-[11px] tabular-nums text-subtle">
            {b.minutes} min for ten papers · about {b.tokens}k tokens per paper
          </div>
        </button>
      ))}
    </div>
  );
}

export function PlaybookPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const [budget, setBudget] = useState(40_000);
  const [lastResult, setLastResult] = useState<JobInfo | null>(null);
  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "learn_playbook" && j.status === "done") {
      setLastResult(j);
      FILES.forEach((f) => void qc.invalidateQueries({ queryKey: ["project", slug, "file", `playbook/${f.key}`] }));
    }
  });

  const learn = useMutation({
    mutationFn: () => api.post<JobInfo>(`/api/projects/${slug}/learn`, { max_chars_per_paper: budget }),
    onSuccess: (job) => watch(job),
    onError: (e: Error) => toast.error(e.message),
  });

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const learned = p.counts.playbook_files > 0;
  const result = lastResult?.result as { papers?: number; tokens_in?: number; tokens_out?: number } | null;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={learned ? <Badge variant="success">{p.counts.playbook_files} of 5 files learned</Badge> : <Badge>Not learned yet</Badge>}
        title={stepTitle("playbook", p)}
        description="How papers like your example papers are built: structure, argument, evidence, related work and venue. Learned once, then yours to edit."
      />

      <Card className="mb-6 p-5">
        <div className="flex items-start gap-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14.5px] font-semibold">{learned ? "Learn again" : "Learn from example papers"}</h3>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              The model reads each paper once, then writes the pattern from its notes. The budget caps how much of each paper it reads; every section is still represented.
              {p.counts.exemplars ? ` ${p.counts.exemplars} example paper${p.counts.exemplars === 1 ? "" : "s"} ready.` : " Add example papers on the Sources page first."}
            </p>
            <div className="mt-4">
              <BudgetPicker value={budget} onChange={setBudget} disabled={active} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => learn.mutate()} loading={learn.isPending} disabled={active || !p.counts.exemplars}>
                <Sparkles className="h-4 w-4" /> {learned ? "Relearn pattern" : "Learn pattern"}
              </Button>
              {!p.counts.exemplars ? (
                <Link to={`/projects/${slug}/sources`} className="text-[13px] font-medium text-primary hover:underline">
                  Add sources
                </Link>
              ) : null}
              {result ? (
                <span className="text-[12.5px] text-muted-foreground">
                  Last run: {result.papers} papers, {((result.tokens_in ?? 0) + (result.tokens_out ?? 0)).toLocaleString()} tokens
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </Card>

      <JobProgress jobs={jobs} onDismiss={dismiss} />

      <Tabs defaultValue="structure">
        <TabsList>
          {FILES.map((f) => (
            <TabsTrigger key={f.key} value={f.key}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {FILES.map((f) => (
          <TabsContent key={f.key} value={f.key} forceMount className="data-[state=inactive]:hidden">
            <p className="mb-2 text-[12.5px] text-muted-foreground">{f.hint}</p>
            <PlaybookFile slug={slug} fileKey={f.key} />
          </TabsContent>
        ))}
      </Tabs>
      <NextStepBar p={p} current="playbook" />
    </div>
  );
}

function PlaybookFile({ slug, fileKey }: { slug: string; fileKey: string }) {
  const qc = useQueryClient();
  const url = `/api/projects/${slug}/files/playbook/${fileKey}`;
  const q = useQuery({ queryKey: ["project", slug, "file", `playbook/${fileKey}`], queryFn: () => api.get<{ content: string }>(url) });
  const save = async (content: string) => {
    await api.put(url, { content });
    await qc.invalidateQueries({ queryKey: ["project", slug] });
  };
  if (!q.data) return <Skeleton className="h-[420px]" />;
  return <MarkdownEditor value={q.data.content} onSave={save} minHeight={420} emptyHint="Nothing learned yet. Run the learning step above or write this file by hand." />;
}
