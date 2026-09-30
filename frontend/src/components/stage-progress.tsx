import { Link, matchPath, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { type StepKey, stepStates, titleFor } from "@/lib/flow";
import { useSkipped } from "@/lib/skips";
import { cn } from "@/lib/utils";

/**
 * Slim "Step N of M" strip shown at the top of every project stage page, so the flow reads
 * as one guided sequence. Guided by default, not locked: every segment that is not locked is
 * a link, so an experienced user can still jump around. Renders nothing on the project home
 * (which already shows the full stepper) or on any route that is not a flow stage.
 */
export function StageProgress() {
  const { pathname } = useLocation();
  const m = matchPath("/projects/:slug/:step", pathname);
  const slug = m?.params.slug;
  const stepKey = m?.params.step as StepKey | undefined;
  const project = useQuery({
    queryKey: ["project", slug],
    queryFn: () => api.get<Project>(`/api/projects/${slug}`),
    enabled: !!slug,
    staleTime: 30_000,
  });
  useSkipped(slug ?? "");
  if (!m || !stepKey || !project.data) return null;
  const p = project.data;
  const rows = stepStates(p);
  const idx = rows.findIndex((r) => r.step.key === stepKey);
  if (idx < 0) return null;
  const current = rows[idx];

  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">
          Step {idx + 1} of {rows.length} · <span className="font-medium text-foreground">{titleFor(current.step, p)}</span>
        </span>
        <Link to={`/projects/${p.slug}`} className="font-medium text-primary hover:underline">
          All steps
        </Link>
      </div>
      <div className="flex items-center gap-1">
        {rows.map(({ step, state }) => {
          const clickable = state !== "locked" && state !== "soon";
          const here = step.key === stepKey;
          const seg = (
            <span
              aria-current={here ? "step" : undefined}
              className={cn(
                "block rounded-full transition-colors",
                // The page you are on is the thick segment; colour still says done, next or waiting.
                here ? "h-2.5 ring-2 ring-foreground/25 ring-offset-1 ring-offset-card" : "h-1.5",
                state === "done" && "bg-success",
                state === "current" && "bg-primary",
                (state === "todo" || state === "optional") && "bg-border-strong",
                (state === "locked" || state === "soon") && "bg-border",
              )}
            />
          );
          return clickable ? (
            <Link key={step.key} to={step.to(p.slug)} title={titleFor(step, p)} className="flex-1">
              {seg}
            </Link>
          ) : (
            <span key={step.key} title={`${titleFor(step, p)} — not yet available`} className="flex-1">
              {seg}
            </span>
          );
        })}
      </div>
    </div>
  );
}
