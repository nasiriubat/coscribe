import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, FileText } from "lucide-react";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { MarkdownEditor } from "@/components/markdown-editor";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";
import { stepTitle } from "@/lib/flow";

/** The research plan is planned work; the specification describes it as the study to be run. */
function planToSpec(plan: string): string {
  const body = plan.replace(/^# .*\n+/, "").trim();
  return `# Study description\n\n_Derived from the research plan. Everything below is planned unless you say otherwise; add what already exists at the end._\n\n${body}\n\n## What exists already\n\n`;
}

export function SpecPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const spec = useQuery({ queryKey: ["project", slug, "file", "system-spec"], queryFn: () => api.get<{ content: string }>(`/api/projects/${slug}/files/system-spec`) });
  const plan = useQuery({ queryKey: ["project", slug, "file", "research-plan"], queryFn: () => api.get<{ content: string }>(`/api/projects/${slug}/files/research-plan`) });

  const save = async (content: string) => {
    await api.put(`/api/projects/${slug}/files/system-spec`, { content });
    await qc.invalidateQueries({ queryKey: ["project", slug] });
  };

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        title={stepTitle("spec", p)}
        description={
          p.entry === "idea"
            ? "The specification of what you will build or study, grown from the research plan. The interview reads it to skip what you already said, and the draft may only state what is in here, in your answers, or in the facts."
            : "The system specification. The interview reads it to skip what you already said, and the draft may only state what is in here, in your answers, or in the facts."
        }
      />
      <Card className="p-5">
        <div className="mb-4 flex items-start gap-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <FileText className="h-4 w-4" />
          </span>
          <div className="text-[12.5px] text-muted-foreground">
            {p.entry === "built"
              ? "A specification generated with Claude Code or similar works well: purpose, users, architecture, what it does, what has been evaluated so far."
              : p.entry === "idea"
                ? "Describe the study you will run: the question, the setting and participants, what you can collect, and what already exists. Plain paragraphs are fine."
                : "Say what the paper is about in a few paragraphs: the work, who it is for, what was done and what evidence exists. The interview and the reviewer read this."}{" "}
            Numbers and names you write here become facts the paper can use, so be exact.
          </div>
        </div>
        {spec.data && !spec.data.content.trim() && p.entry === "idea" && plan.data?.content.trim() ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-primary/30 bg-primary-soft/30 px-3 py-2.5 text-[13px]">
            <span>Your research plan already describes the study. Start from it and edit what changed.</span>
            <Button size="sm" variant="secondary" onClick={() => void save(planToSpec(plan.data!.content))}>
              Start from the research plan
            </Button>
          </div>
        ) : null}
        {spec.data ? (
          <MarkdownEditor
            value={spec.data.content}
            onSave={save}
            placeholder={
              p.entry === "built"
                ? "# System name\n\n## Purpose\n\n## Users\n\n## Architecture\n\n## What it does\n\n## Evaluation so far"
                : p.entry === "idea"
                  ? "# Study title\n\n## Question\n\n## Setting and participants\n\n## What you can collect\n\n## Method\n\n## What exists already"
                  : "# Paper title\n\n## What the work is\n\n## Who it is for\n\n## What was done\n\n## Evidence so far"
            }
            emptyHint={p.entry === "built" ? "Switch to Edit and paste your system specification." : "Switch to Edit and describe the work in your own words."}
            minHeight={460}
          />
        ) : (
          <Skeleton className="h-[460px]" />
        )}
      </Card>
      <NextStepBar p={p} current="spec" />
    </div>
  );
}
