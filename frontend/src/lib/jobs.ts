import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { JobInfo } from "./types";

/** Human names for background job types, shared by every progress list. */
export const JOB_LABELS: Record<string, string> = {
  ingest_arxiv: "Fetching from arXiv",
  ingest_pdf: "Extracting PDF",
  ingest_reading: "Reading a paper",
  reading_card: "Writing the reading card",
  learn_playbook: "Learning the pattern",
  learn_profile: "Learning the voice",
  research_plan: "Designing the study",
  interview_round: "Preparing interview questions",
  outline: "Extracting facts and outlining",
  draft_section: "Drafting a section",
  scan: "Scanning the literature",
  critique: "Reviewing the draft",
  export: "Exporting",
};

/** A job the user stopped. The server records it as failed with this message. */
export function isCancelled(j: JobInfo): boolean {
  return j.status === "failed" && j.error === "Cancelled";
}

export function cancelJob(id: string): Promise<{ cancelled: boolean }> {
  return api.post<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`);
}

export function jobLabel(type: string): string {
  return JOB_LABELS[type] ?? type.replace(/_/g, " ");
}

/**
 * Tracks background jobs for one project or profile. Loads active jobs on mount, streams
 * progress over SSE, and keeps finished jobs visible until dismissed.
 */
export function useJobs(scope: { project_id?: string; profile_id?: string }, onDone?: (job: JobInfo) => void) {
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  const streams = useRef<Record<string, EventSource>>({});
  const qc = useQueryClient();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const upsert = useCallback((j: JobInfo) => setJobs((prev) => ({ ...prev, [j.id]: j })), []);

  const watch = useCallback(
    (job: JobInfo) => {
      upsert(job);
      if (streams.current[job.id] || job.status === "done" || job.status === "failed") return;
      const es = new EventSource(`/api/jobs/${job.id}/events`);
      streams.current[job.id] = es;
      es.addEventListener("job", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as JobInfo;
        upsert(data);
        if (data.status === "done" || data.status === "failed") {
          es.close();
          delete streams.current[job.id];
          void qc.invalidateQueries();
          onDoneRef.current?.(data);
        }
      });
      es.onerror = () => {
        es.close();
        delete streams.current[job.id];
        // fall back to one fetch so the final state is not lost
        void api.get<JobInfo>(`/api/jobs/${job.id}`).then((j) => {
          upsert(j);
          if (j.status === "done" || j.status === "failed") {
            void qc.invalidateQueries();
            onDoneRef.current?.(j);
          }
        });
      };
    },
    [upsert, qc],
  );

  useEffect(() => {
    const params = new URLSearchParams({ active: "true" });
    if (scope.project_id) params.set("project_id", scope.project_id);
    if (scope.profile_id) params.set("profile_id", scope.profile_id);
    if (!scope.project_id && !scope.profile_id) return;
    void api.get<JobInfo[]>(`/api/jobs?${params}`).then((list) => list.forEach(watch));
    const current = streams.current;
    return () => {
      Object.values(current).forEach((es) => es.close());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.project_id, scope.profile_id]);

  const dismiss = (id: string) =>
    setJobs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const list = Object.values(jobs).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = list.some((j) => j.status === "queued" || j.status === "running");
  return { jobs: list, active, watch, dismiss };
}
