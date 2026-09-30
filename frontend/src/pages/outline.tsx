import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ChevronLeft, ListTree, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import type { JobInfo, Project } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownEditor } from "@/components/markdown-editor";
import { JobProgress } from "@/components/papers";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";

function FileEditor({ slug, name, minHeight, emptyHint }: { slug: string; name: string; minHeight: number; emptyHint: string }) {
  const qc = useQueryClient();
  const url = `/api/projects/${slug}/files/${name}`;
  const q = useQuery({ queryKey: ["project", slug, "file", name], queryFn: () => api.get<{ content: string }>(url) });
  const save = async (content: string) => {
    await api.put(url, { content });
    await qc.invalidateQueries({ queryKey: ["project", slug] });
  };
  if (!q.data) return <Skeleton className="h-[560px]" />;
  return <MarkdownEditor value={q.data.content} onSave={save} minHeight={minHeight} emptyHint={emptyHint} />;
}

export function OutlinePage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "outline" && j.status === "done") {
      void qc.invalidateQueries({ queryKey: ["project", slug] });
    }
  });
  const generate = useMutation({
    mutationFn: () => api.post<JobInfo>(`/api/projects/${slug}/outline/generate`),
    onSuccess: (job) => watch(job),
    onError: (e: Error) => toast.error(e.message),
  });
  const approve = useMutation({
    mutationFn: () => api.post<{ stage: string }>(`/api/projects/${slug}/outline/approve`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", slug] });
      toast.success("Outline approved. Drafting can start from it.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const approved = ["outline", "drafting", "review", "export"].includes(p.stage);
  const ir = p.counts.interview_rounds;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={approved ? <Badge variant="success">Approved</Badge> : p.counts.has_outline ? <Badge variant="warning">Draft outline, not approved</Badge> : <Badge>Not started</Badge>}
        title="Outline"
        description="One line per paragraph, built from the pattern structure and only the facts you gave. Missing pieces are marked [NEEDS: …] so they become checklist items. Approve it before drafting."
        actions={
          <>
            <Button variant="secondary" onClick={() => generate.mutate()} loading={generate.isPending} disabled={active || !p.counts.has_spec}>
              <Sparkles className="h-4 w-4" /> {p.counts.has_outline ? "Regenerate" : "Generate outline"}
            </Button>
            <Button onClick={() => approve.mutate()} loading={approve.isPending} disabled={!p.counts.has_outline || approved || active}>
              <CheckCircle2 className="h-4 w-4" /> {approved ? "Approved" : "Approve outline"}
            </Button>
          </>
        }
      />

      {!p.counts.has_spec ? (
        <Card className="mb-4 p-4 text-[13px] text-muted-foreground">The outline needs your description of the work. <Link to={`/projects/${slug}/spec`} className="font-medium text-primary hover:underline">Write it first</Link>.</Card>
      ) : ir.rounds === 0 ? (
        <Card className="mb-4 flex items-center justify-between gap-4 p-4 text-[13px]">
          <span className="text-muted-foreground">
            No interview yet. You can outline from the spec alone, but the outline will have more [NEEDS] gaps.
          </span>
          <Link to={`/projects/${slug}/interview`} className="shrink-0 font-medium text-primary hover:underline">
            Run the interview
          </Link>
        </Card>
      ) : ir.open > 0 ? (
        <Card className="mb-4 p-4 text-[13px] text-muted-foreground">
          {ir.open} interview question{ir.open === 1 ? "" : "s"} still open. Answered questions are used; open ones become gaps.
        </Card>
      ) : null}

      <JobProgress jobs={jobs} onDismiss={dismiss} />

      <Tabs defaultValue="outline">
        <TabsList>
          <TabsTrigger value="outline">
            <ListTree className="mr-1.5 h-3.5 w-3.5" /> Outline
          </TabsTrigger>
          <TabsTrigger value="facts">Facts</TabsTrigger>
        </TabsList>
        <TabsContent value="outline" forceMount className="data-[state=inactive]:hidden">
          <FileEditor slug={slug} name="outline" minHeight={560} emptyHint="Generate the outline, or write it yourself. One line per paragraph." />
        </TabsContent>
        <TabsContent value="facts" forceMount className="data-[state=inactive]:hidden">
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            Names, numbers and claims extracted from your spec and answers. Every draft reads this file, which is how sections stay consistent with each other. Edit anything that is wrong.
          </p>
          <FileEditor slug={slug} name="facts" minHeight={560} emptyHint="Facts are extracted when the outline is generated." />
        </TabsContent>
      </Tabs>
      <NextStepBar p={p} current="outline" />
    </div>
  );
}
