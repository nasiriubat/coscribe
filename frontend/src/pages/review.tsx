import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, Check, ChevronLeft, Compass, ShieldCheck, Sparkles, ThumbsUp } from "lucide-react";
import { api } from "@/lib/api";
import { track } from "@/lib/events";
import type { JobInfo, Project, ReviewState, VenueSuggestions } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, SectionTitle, Skeleton } from "@/components/ui/misc";
import { JobProgress } from "@/components/papers";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";

const VERDICT: Record<string, { label: string; variant: "success" | "primary" | "warning" | "destructive" }> = {
  accept: { label: "Accept", variant: "success" },
  "minor revision": { label: "Minor revision", variant: "primary" },
  "major revision": { label: "Major revision", variant: "warning" },
  reject: { label: "Reject", variant: "destructive" },
};

export function ReviewPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const state = useQuery({ queryKey: ["review", slug], queryFn: () => api.get<{ review: ReviewState | null; venues: VenueSuggestions | null }>(`/api/projects/${slug}/review`) });
  const [filter, setFilter] = useState<"all" | "major" | "minor">("all");
  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "critique") {
      void qc.invalidateQueries({ queryKey: ["review", slug] });
      void qc.invalidateQueries({ queryKey: ["checklist", slug] });
    }
  });
  const run = useMutation({
    mutationFn: () => api.post<JobInfo>(`/api/projects/${slug}/review`),
    onSuccess: (job) => {
      watch(job);
      track("critique_run", { slug });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const suggest = useMutation({
    mutationFn: () => api.post<VenueSuggestions>(`/api/projects/${slug}/venue/suggest`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["review", slug] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const choose = useMutation({
    mutationFn: (venue: string) => api.post<{ venue: string }>(`/api/projects/${slug}/venue`, { venue }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["project", slug] });
      toast.success(`Target venue set to ${r.venue}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (project.isLoading || state.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const review = state.data?.review ?? null;
  const venues = state.data?.venues ?? null;
  const findings = (review?.findings ?? []).filter((f) => filter === "all" || f.severity === filter);
  const verdict = review ? VERDICT[review.verdict] ?? VERDICT["major revision"] : null;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={verdict ? <Badge variant={verdict.variant}>{verdict.label}</Badge> : <Badge>Not reviewed</Badge>}
        title="Review"
        description="A reviewer pass over everything drafted: overclaims, missing evidence, contradictions between sections, structure against the pattern. Major findings land on the checklist. Nothing is changed for you."
        actions={
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={active || !p.counts.sections_drafted}>
            <ShieldCheck className="h-4 w-4" /> {review ? "Review again" : "Run review"}
          </Button>
        }
      />
      <JobProgress jobs={jobs} onDismiss={dismiss} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          {!review ? (
            <EmptyState
              icon={<ShieldCheck />}
              title={p.counts.sections_drafted ? "No review yet" : "Draft something first"}
              description={p.counts.sections_drafted ? "The reviewer reads the drafted sections, the facts and the pattern, then writes a verdict with specific findings." : "The review works on drafted sections. Draft at least one in the Studio."}
              action={p.counts.sections_drafted ? <Button onClick={() => run.mutate()} loading={run.isPending} disabled={active}>Run review</Button> : undefined}
            />
          ) : (
            <div className="flex flex-col gap-5">
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
                  <span>
                    Reviewed {timeAgo(review.created_at)} · {review.drafted_sections} of {review.total_sections} sections · {review.words.toLocaleString()} words
                  </span>
                </div>
                <p className="mt-2 text-[14px] leading-relaxed">{review.summary}</p>
                {review.page_budget ? <p className="mt-2 text-[13px] text-muted-foreground">{review.page_budget}</p> : null}
                {review.strengths.length ? (
                  <div className="mt-4">
                    <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">Strengths</div>
                    <ul className="flex flex-col gap-1 text-[13px]">
                      {review.strengths.map((s, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <ThumbsUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Card>

              <div>
                <SectionTitle
                  right={
                    <div className="flex gap-1">
                      {(["all", "major", "minor"] as const).map((f) => (
                        <button key={f} onClick={() => setFilter(f)} className={cn("rounded-full px-2.5 py-0.5 text-[12px] font-medium", filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}>
                          {f === "all" ? `All ${review.findings.length}` : `${f} ${review.findings.filter((x) => x.severity === f).length}`}
                        </button>
                      ))}
                    </div>
                  }
                >
                  Findings
                </SectionTitle>
                <div className="flex flex-col gap-2.5">
                  {findings.map((f) => (
                    <Card key={f.id} className={cn("p-4", f.severity === "major" && "border-warning/40")}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={f.severity === "major" ? "warning" : "outline"}>{f.severity}</Badge>
                        <Badge variant="outline">{f.kind}</Badge>
                        <span className="text-[12.5px] text-muted-foreground">{f.section}</span>
                      </div>
                      {f.quote ? <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-[13px] italic text-muted-foreground">“{f.quote}”</blockquote> : null}
                      <p className="mt-2 text-[13.5px]">{f.issue}</p>
                      <p className="mt-1.5 flex items-start gap-1.5 text-[13px] text-success">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {f.fix}
                      </p>
                    </Card>
                  ))}
                </div>
              </div>

              {review.cross_section.length ? (
                <div>
                  <SectionTitle>Across sections</SectionTitle>
                  <Card className="divide-y divide-border">
                    {review.cross_section.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 px-4 py-2.5 text-[13px]">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> {c}
                      </div>
                    ))}
                  </Card>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <SectionTitle>Where to submit</SectionTitle>
          <Card className="p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Compass className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-semibold">{p.venue ? `Target: ${p.venue}` : "No target venue yet"}</div>
                <p className="mt-0.5 text-muted-foreground">Three suggestions from your spec and the example papers' venues. You decide; the model can be wrong about details, so verify calls and deadlines.</p>
                <Button size="sm" variant="secondary" className="mt-3" onClick={() => suggest.mutate()} loading={suggest.isPending}>
                  <Sparkles className="h-3.5 w-3.5" /> {venues ? "Suggest again" : "Suggest venues"}
                </Button>
              </div>
            </div>
          </Card>
          {venues ? (
            <div className="mt-3 flex flex-col gap-2.5">
              {venues.suggestions.map((v, i) => (
                <Card key={i} className={cn("p-4", p.venue === v.venue && "border-primary/50")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold">{v.venue}</span>
                    <Badge variant={v.fit === "high" ? "success" : "outline"}>{v.fit} fit</Badge>
                    <Badge variant="outline">{v.track}</Badge>
                  </div>
                  <p className="mt-1.5 text-[13px]">{v.why}</p>
                  <dl className="mt-2 grid gap-1 text-[12.5px] text-muted-foreground">
                    <div><span className="font-medium text-foreground">Length: </span>{v.typical_length}</div>
                    <div><span className="font-medium text-foreground">Risk: </span>{v.risk}</div>
                    <div><span className="font-medium text-foreground">AI policy: </span>{v.ai_policy_note}</div>
                    <div><span className="font-medium text-foreground">Template: </span>{v.template}</div>
                  </dl>
                  <Button size="sm" variant={p.venue === v.venue ? "secondary" : "primary"} className="mt-3" onClick={() => choose.mutate(v.venue)} disabled={p.venue === v.venue}>
                    {p.venue === v.venue ? "Selected" : "Use this venue"}
                  </Button>
                </Card>
              ))}
              <Card className="p-4 text-[13px]">
                <div className="font-semibold">Recommendation</div>
                <p className="mt-1 text-muted-foreground">{venues.recommendation}</p>
                <div className="mt-3 font-semibold">Before submitting</div>
                <ul className="mt-1 flex flex-col gap-1">
                  {venues.before_submitting.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-muted-foreground">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {b}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ) : null}
        </div>
      </div>

      <NextStepBar p={p} current="review" />
    </div>
  );
}
