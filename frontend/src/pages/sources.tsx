import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronLeft, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, SectionTitle, Skeleton } from "@/components/ui/misc";
import { AddPapers, JobProgress, PaperList } from "@/components/papers";
import { NextStepBar } from "@/components/flow";
import { LiteratureScan } from "@/components/literature-scan";
import { ProjectLoadError } from "@/components/load-error";

export function SourcesPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const { jobs, watch, dismiss } = useJobs({ project_id: project.data?.id });

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const base = `/api/projects/${slug}/exemplars`;
  const readingsBase = `/api/projects/${slug}/readings`;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        title="Sources"
        description="Example papers the pattern is learned from. Five to ten papers of the type you are writing, ideally from the venue you target. Any example paper can also be cited with one click."
        actions={
          <Button variant="secondary" onClick={() => navigate(`/projects/${slug}/playbook`)} disabled={!p.counts.exemplars}>
            <Sparkles className="h-4 w-4" /> Go to pattern
          </Button>
        }
      />
      {p.counts.exemplars > 0 && p.counts.exemplars < 5 ? (
        <Card className="mb-4 flex flex-wrap items-center gap-3 border-primary/30 bg-primary-soft/30 px-4 py-3 text-[13px]">
          <BookOpen className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <span className="font-medium">
              {p.counts.exemplars} example paper{p.counts.exemplars === 1 ? "" : "s"} so far. Aim for five to ten.
            </span>{" "}
            <span className="text-muted-foreground">In our own test, a pattern from three papers barely changed the drafts; one from ten was visibly richer in quotes, counts and verbs. The scan below finds candidates from your idea.</span>
          </div>
        </Card>
      ) : null}
      <div className="mb-6">
        <LiteratureScan slug={slug} projectId={p.id} />
      </div>
      <SectionTitle>Example papers: papers to learn the genre from</SectionTitle>
      <p className="mb-3 -mt-1 text-[13px] text-muted-foreground">Five to ten papers of the type you are writing. The pattern is learned from these; each can also be cited with one click.</p>
      <AddPapers arxivUrl={`${base}/arxiv`} uploadUrl={`${base}/upload`} onJob={watch} />
      <JobProgress jobs={jobs.filter((j) => j.type !== "scan" && j.type !== "ingest_reading" && j.type !== "reading_card")} onDismiss={dismiss} />
      <PaperList
        listUrl={base}
        itemUrl={(id) => `${base}/${id}`}
        citeUrl={(id) => `${base}/${id}/cite`}
        emptyTitle="No example papers yet"
        emptyText="Let the scan suggest papers, paste arXiv ids of papers you admire in this genre, or upload PDFs. The tool reads them and learns how they are built."
      />

      <div className="mt-10">
        <SectionTitle>Background reading: papers you read for this work</SectionTitle>
        <p className="mb-3 -mt-1 text-[13px] text-muted-foreground">
          As many as you read, twenty or forty is normal. Each is read in full once and gets a reading card (question, method, result, limitation, relation to your work). The paper becomes a verified reference at once, and drafts may attribute to it what the card says, not only its abstract. Related Work is written from these cards. They never touch the pattern.
        </p>
        <AddPapers arxivUrl={`${readingsBase}/arxiv`} uploadUrl={`${readingsBase}/upload`} onJob={watch} />
        <JobProgress jobs={jobs.filter((j) => j.type === "ingest_reading" || j.type === "reading_card")} onDismiss={dismiss} />
        <PaperList
          listUrl={readingsBase}
          itemUrl={(id) => `${readingsBase}/${id}`}
          emptyTitle="Nothing read yet"
          emptyText="Paste arXiv ids, upload the PDFs you have read, or tick “Read” on scan candidates above. Twenty papers take a few minutes in the background."
        />
      </div>
      <NextStepBar p={p} current="sources" />
    </div>
  );
}
