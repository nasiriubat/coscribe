import { useEffect, useState } from "react";
import { Link, matchPath, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, ChevronRight, CircleHelp, CircleSlash, Loader2, LogOut, Moon, Settings2, Sun, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { cancelJob, isCancelled, jobLabel } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { STEPS, titleFor } from "@/lib/flow";
import type { JobInfo, Profile, Project } from "@/lib/types";
import { SiteLogo, useSite } from "@/lib/site";
import { useTheme } from "@/lib/theme";
import { cn, initials, timeAgo } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";

const ADMIN_LABELS: Record<string, string> = {
  providers: "Providers",
  models: "Models",
  kinds: "Paper types",
  "house-style": "House style",
  users: "Users",
  site: "Site",
  pages: "Pages",
  usage: "Usage",
  storage: "Storage",
};

interface Crumb {
  label: string;
  to?: string;
}

/** Breadcrumbs derived from the route, with titles from the query cache when available. */
function useCrumbs(): Crumb[] {
  const { pathname } = useLocation();
  const proj = matchPath("/projects/:slug/:step?", pathname);
  const prof = matchPath("/profiles/:slug", pathname);
  const admin = matchPath("/admin/:section?", pathname);
  const slug = proj?.params.slug ?? "";
  const project = useQuery({
    queryKey: ["project", slug],
    queryFn: () => api.get<Project>(`/api/projects/${slug}`),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const pslug = prof?.params.slug ?? "";
  const profile = useQuery({
    queryKey: ["profile", pslug],
    queryFn: () => api.get<Profile>(`/api/profiles/${pslug}`),
    enabled: !!pslug,
    staleTime: 30_000,
  });

  if (proj) {
    const crumbs: Crumb[] = [{ label: "Library", to: "/library" }, { label: project.data?.title ?? "Project", to: `/projects/${slug}` }];
    const step = STEPS.find((s) => s.to(slug).endsWith(`/${proj.params.step}`));
    if (step) crumbs.push({ label: project.data ? titleFor(step, project.data) : step.title });
    return crumbs;
  }
  if (prof) return [{ label: "Author profiles", to: "/profiles" }, { label: profile.data?.name ?? "Profile" }];
  if (pathname === "/profiles") return [{ label: "Author profiles" }];
  if (admin) {
    const crumbs: Crumb[] = [{ label: "Settings", to: "/admin" }];
    const s = admin.params.section;
    if (s && ADMIN_LABELS[s]) crumbs.push({ label: ADMIN_LABELS[s] });
    return crumbs;
  }
  if (pathname === "/account") return [{ label: "Account" }];
  return [{ label: "Library" }];
}

/** Every active job of the signed-in user, polled while the tab is visible; finished ones linger briefly. */
function useActiveJobs() {
  const [recent, setRecent] = useState<JobInfo[]>([]);
  const q = useQuery({
    queryKey: ["jobs", "active"],
    queryFn: () => api.get<JobInfo[]>("/api/jobs?active=true"),
    refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? 2500 : 15_000),
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
  const active = q.data ?? [];
  useEffect(() => {
    // remember ids that were active so their completion can be shown once
    if (!active.length) return;
    setRecent((prev) => {
      const ids = new Set(prev.map((j) => j.id));
      return [...prev, ...active.filter((j) => !ids.has(j.id))];
    });
  }, [active]);
  const finished = recent.filter((r) => !active.some((a) => a.id === r.id));
  // A job that left the active list was last seen running: fetch how it actually ended.
  const unsettled = finished.filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id).join(",");
  useEffect(() => {
    if (!unsettled) return;
    void Promise.all(unsettled.split(",").map((id) => api.get<JobInfo>(`/api/jobs/${id}`).catch(() => null))).then((fresh) =>
      setRecent((prev) => prev.map((r) => fresh.find((f) => f?.id === r.id) ?? r)),
    );
  }, [unsettled]);
  useEffect(() => {
    if (!finished.length) return;
    const t = setTimeout(() => setRecent((prev) => prev.filter((r) => active.some((a) => a.id === r.id))), 8000);
    return () => clearTimeout(t);
  }, [finished.length, active]);
  return { active, finished };
}

function JobsIndicator() {
  const { active, finished } = useActiveJobs();
  const qc = useQueryClient();
  const cancel = (id: string) =>
    void cancelJob(id)
      .then(() => qc.invalidateQueries({ queryKey: ["jobs", "active"] }))
      .catch((e: Error) => toast.error(e.message));
  const total = active.length;
  if (!total && !finished.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
            total ? "border-primary/30 bg-primary-soft text-primary" : "border-success/30 bg-success-soft text-success",
          )}
          aria-label={total ? `${total} job${total === 1 ? "" : "s"} running` : "Jobs finished"}
        >
          {total ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{total ? `${total} running` : "Done"}</span>
          <span className="sm:hidden">{total || "✓"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[300px] p-1.5">
        <DropdownMenuLabel>Background work</DropdownMenuLabel>
        {[...active, ...finished].map((j) => (
          <div key={j.id} className="flex items-start gap-2.5 rounded-md px-2 py-2 text-[12.5px]">
            {j.status === "queued" || j.status === "running" ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            ) : j.status === "done" ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            ) : isCancelled(j) ? (
              <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
            ) : (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{jobLabel(j.type)}</span>
                <span className="shrink-0 text-[11px] text-subtle">{timeAgo(j.updated_at)}</span>
              </div>
              <div className="truncate text-muted-foreground">{isCancelled(j) ? "Stopped." : (j.error ?? j.message)}</div>
              {j.status === "running" || j.status === "queued" ? (
                <>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(j.progress, 3)}%` }} />
                  </div>
                  <button onClick={() => cancel(j.id)} className="mt-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                    Cancel
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-[12px] font-semibold text-primary ring-offset-background transition-shadow hover:ring-2 hover:ring-primary/30" aria-label="Account menu">
          {initials(user?.display_name ?? "?")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuLabel>
          <span className="block truncate text-[13px] font-medium text-foreground">{user?.display_name}</span>
          <span className="block truncate text-[11.5px] font-normal text-muted-foreground">{user?.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/account")}>
          <UserRound /> Account
        </DropdownMenuItem>
        {user?.role === "admin" ? (
          <DropdownMenuItem onSelect={() => navigate("/admin")}>
            <Settings2 /> Settings
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => navigate("/landing")}>
          <CircleHelp /> How it works
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout().then(() => navigate("/login"))}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar() {
  const crumbs = useCrumbs();
  const site = useSite();
  const { resolved, setTheme } = useTheme();
  const last = crumbs[crumbs.length - 1];

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="mx-auto flex h-[52px] w-full max-w-[1480px] items-center gap-2 px-3 md:px-6 xl:px-10">
        {/* Phone: brand. Desktop: breadcrumbs. */}
        <Link to="/library" className="flex items-center gap-2 md:hidden">
          <SiteLogo className="h-7 w-7" iconClassName="h-4 w-4" />
          <span className="truncate text-[14.5px] font-semibold tracking-tight">{site.name}</span>
        </Link>
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-[13px] md:flex">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
                {i > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" /> : null}
                {c.to && !isLast ? (
                  <Link to={c.to} className="truncate rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span className={cn("truncate px-1.5 py-1", isLast ? "font-medium text-foreground" : "text-muted-foreground")} aria-current={isLast ? "page" : undefined}>
                    {c.label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
        {/* Phone: current page label, centered-ish next to brand */}
        {last && crumbs.length > 1 ? <span className="truncate text-[12.5px] text-muted-foreground md:hidden">· {last.label}</span> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <JobsIndicator />
          <Tooltip content={resolved === "dark" ? "Light mode" : "Dark mode"}>
            <button
              onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={resolved === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </Tooltip>
          <Tooltip content="How it works">
            <Link to="/landing" className="hidden h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:flex" aria-label="How it works">
              <CircleHelp className="h-4 w-4" />
            </Link>
          </Tooltip>
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
