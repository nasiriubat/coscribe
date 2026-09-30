import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, Compass, Lightbulb, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import type { JobInfo, Project } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, SectionTitle, Skeleton } from "@/components/ui/misc";
import { MarkdownEditor } from "@/components/markdown-editor";
import { JobProgress } from "@/components/papers";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";

type Mode = "refine" | "explore";

export function DesignPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const idea = useQuery({ queryKey: ["project", slug, "file", "idea"], queryFn: () => api.get<{ content: string }>(`/api/projects/${slug}/files/idea`) });
  const plan = useQuery({ queryKey: ["project", slug, "file", "research-plan"], queryFn: () => api.get<{ content: string }>(`/api/projects/${slug}/files/research-plan`) });
  const [mode, setMode] = useState<Mode>("refine");
  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "research_plan" && j.status === "done") void qc.invalidateQueries({ queryKey: ["project", slug] });
  });

  const generate = useMutation({
    mutationFn: () => api.post<JobInfo>(`/api/projects/${slug}/design/generate`, { mode }),
    onSuccess: (job) => watch(job),
    onError: (e: Error) => toast.error(e.message),
  });

  const saveFile = (name: string) => async (content: string) => {
    await api.put(`/api/projects/${slug}/files/${name}`, { content });
    await qc.invalidateQueries({ queryKey: ["project", slug] });
  };

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const hasIdea = !!idea.data?.content.trim();

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={p.counts.has_plan ? <Badge variant="success">Plan written</Badge> : p.entry === "idea" ? <Badge variant="primary">Start here</Badge> : <Badge>Optional stage</Badge>}
        title="Research design"
        description="From an idea to a study that reviewers of this type of paper would accept. The plan works backwards from the evidence checklist and never contains results."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div>
          <SectionTitle>Your idea</SectionTitle>
          {idea.data ? (
            <MarkdownEditor
              value={idea.data.content}
              onSave={saveFile("idea")}
              minHeight={260}
              placeholder={"What you have or want to do, in your own words.\n\nExamples:\n- I built a tool that matches public tenders to small companies. I want to publish it but do not know what to evaluate.\n- I have access to 3 years of CI logs from my company. What could I study?"}
              emptyHint="Switch to Edit and describe the idea. Rough is fine."
            />
          ) : (
            <Skeleton className="h-[260px]" />
          )}

          <Card className="mt-4 p-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["refine", "Refine my idea", "I know roughly what I want. Sharpen it into research questions and a minimum study.", Lightbulb],
                  ["explore", "Find a direction", "I have a tool, data or a topic. Propose two or three directions and recommend one.", Compass],
                ] as const
              ).map(([key, label, hint, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  disabled={active}
                  className={cn(
                    "flex items-start gap-3 rounded-[var(--radius-sm)] border p-3 text-left transition-colors hover:bg-muted disabled:opacity-60",
                    mode === key ? "border-primary bg-primary-soft/60" : "border-border",
                  )}
                >
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", mode === key ? "text-primary" : "text-muted-foreground")} />
                  <span>
                    <span className="block text-[13px] font-semibold">{label}</span>
                    <span className="block text-[12px] leading-snug text-muted-foreground">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button onClick={() => generate.mutate()} loading={generate.isPending} disabled={active || !hasIdea}>
                <Sparkles className="h-4 w-4" /> {p.counts.has_plan ? "Regenerate plan" : "Design the study"}
              </Button>
              {!hasIdea ? <span className="text-[12.5px] text-muted-foreground">Save your idea first.</span> : null}
            </div>
          </Card>
          <div className="mt-4">
            <JobProgress jobs={jobs} onDismiss={dismiss} />
          </div>
        </div>

        <div>
          <SectionTitle>Research plan</SectionTitle>
          {plan.data ? (
            <MarkdownEditor
              value={plan.data.content}
              onSave={saveFile("research-plan")}
              minHeight={620}
              emptyHint="The plan appears here: research questions, the claim, method options, the minimum study, an evidence map and what to search for. Edit it freely."
            />
          ) : (
            <Skeleton className="h-[620px]" />
          )}
        </div>
      </div>
      <NextStepBar p={p} current="design" />
    </div>
  );
}
