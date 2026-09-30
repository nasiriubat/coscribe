import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, Feather, FileText, Plus } from "lucide-react";
import { api } from "@/lib/api";
import type { Profile, Project, Provider, PurposeAssignment, User } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, ProgressRing, SectionTitle, Skeleton } from "@/components/ui/misc";
import { NewProfileDialog, NewProjectDialog } from "@/components/dialogs";
import { useAuth } from "@/lib/auth";

export function projectProgress(p: Project): number {
  // Six gates to a full draft, weighted so drafting dominates the second half.
  let score = 0;
  if (p.counts.has_spec) score += 1;
  if (p.counts.exemplars > 0) score += 1;
  if (p.counts.playbook_files > 0) score += 1;
  if (p.counts.interview_rounds.rounds > 0) score += 1;
  if (["outline", "drafting", "review", "export"].includes(p.stage)) score += 1;
  const drafting = p.counts.sections ? p.counts.sections_drafted / p.counts.sections : 0;
  return Math.min(100, Math.round(((score + drafting * 5) / 10) * 100));
}

export function ProjectCard({ p }: { p: Project }) {
  const navigate = useNavigate();
  return (
    <Card interactive onClick={() => navigate(`/projects/${p.slug}`)} className="group flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="primary">{p.kind_name}</Badge>
            {p.venue ? <Badge variant="outline">{p.venue}</Badge> : null}
          </div>
          <h3 className="text-[15px] font-semibold leading-snug">{p.title}</h3>
        </div>
        <ProgressRing value={projectProgress(p)} />
      </div>
      <div className="mt-4 flex items-center gap-4 text-[12.5px] text-muted-foreground">
        <span>{p.counts.exemplars} example paper{p.counts.exemplars === 1 ? "" : "s"}</span>
        <span>{p.counts.sections} section{p.counts.sections === 1 ? "" : "s"}</span>
        <span>{p.counts.references} ref{p.counts.references === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[12px] text-subtle">
        <span>
          {p.profile_name ? `Voice: ${p.profile_name} · ` : ""}updated {timeAgo(p.updated_at)}
        </span>
        <ArrowRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </Card>
  );
}

export function ProfileCard({ p }: { p: Profile }) {
  const navigate = useNavigate();
  const status =
    p.status === "ready" ? <Badge variant="success">Ready</Badge> : p.status === "learning" ? <Badge variant="warning">Learning</Badge> : <Badge>Empty</Badge>;
  return (
    <Card interactive onClick={() => navigate(`/profiles/${p.slug}`)} className="flex min-w-0 items-center gap-4 p-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Feather className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-[14.5px] font-semibold">{p.name}</h3>
          {status}
          {p.shareable ? <Badge variant="outline">Shared</Badge> : null}
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {p.source_count} source paper{p.source_count === 1 ? "" : "s"} · by {p.owner_name}
        </p>
      </div>
    </Card>
  );
}

/** Shown to admins until the workspace can actually run: a provider with a key, a model per
 *  purpose, and at least one other member. Each line links to where it is fixed. */
function FirstRunChecklist() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api.get<Provider[]>("/api/providers") });
  const purposes = useQuery({ queryKey: ["purposes"], queryFn: () => api.get<PurposeAssignment[]>("/api/purposes") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/api/users") });
  const [alone, setAlone] = useState(() => {
    try {
      return localStorage.getItem("pw.firstRun.alone") === "1";
    } catch {
      return false;
    }
  });
  if (!providers.data || !purposes.data || !users.data) return null;
  const hasProvider = providers.data.some((p) => p.enabled && p.has_key);
  const unassigned = purposes.data.filter((p) => !p.model);
  const hasMembers = alone || users.data.filter((u) => u.is_active).length >= 2;
  const items = [
    { done: hasProvider, label: hasProvider ? "A model provider is connected" : "Connect a model provider and add its API key", to: "/admin/providers" },
    { done: unassigned.length === 0, label: unassigned.length === 0 ? "Every purpose has a model" : `Pick a model for ${unassigned.length} purpose${unassigned.length === 1 ? "" : "s"} (${unassigned.map((p) => p.purpose).join(", ")})`, to: "/admin/models" },
    { done: hasMembers, label: hasMembers ? "Colleagues invited" : "Invite a colleague, or skip this if you work alone", to: "/admin/users" },
  ];
  if (items.every((i) => i.done)) return null;
  const doneCount = items.filter((i) => i.done).length;
  return (
    <Card className="mb-6 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold">Set up the workspace</h3>
          <p className="text-[12.5px] text-muted-foreground">Nobody can draft until the first two are done. This card disappears by itself.</p>
        </div>
        <span className="text-[12px] tabular-nums text-subtle">
          {doneCount} of {items.length}
        </span>
      </div>
      <ol className="flex flex-col gap-1">
        {items.map((it) => (
          <li key={it.to}>
            <Link to={it.to} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
              {it.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Circle className="h-4 w-4 shrink-0 text-border-strong" />}
              <span className={it.done ? "text-muted-foreground line-through" : ""}>{it.label}</span>
              {!it.done ? <ArrowRight className="ml-auto h-3.5 w-3.5 text-subtle" /> : null}
            </Link>
          </li>
        ))}
      </ol>
      {!hasMembers && hasProvider && unassigned.length === 0 ? (
        <button
          onClick={() => {
            setAlone(true);
            try {
              localStorage.setItem("pw.firstRun.alone", "1");
            } catch {
              /* fine without storage */
            }
          }}
          className="mt-2 px-2 text-[12.5px] font-medium text-primary hover:underline"
        >
          I work alone, hide this
        </button>
      ) : null}
    </Card>
  );
}

/** Members cannot fix the workspace themselves, so they are told who can instead of meeting errors. */
function WorkspaceNotReady() {
  const ws = useQuery({ queryKey: ["workspace"], queryFn: () => api.get<{ ready: boolean; admin_name: string | null }>("/api/auth/workspace") });
  if (!ws.data || ws.data.ready) return null;
  return (
    <Card className="mb-6 border-warning/40 bg-warning-soft/30 p-4">
      <h3 className="text-[14px] font-semibold">The workspace is not set up yet</h3>
      <p className="text-[12.5px] text-muted-foreground">
        No AI model is connected, so nothing can be drafted, scanned or reviewed. Ask {ws.data.admin_name ?? "your administrator"} to finish the set-up. You can already create a project and describe your work.
      </p>
    </Card>
  );
}

export function LibraryPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api.get<Profile[]>("/api/profiles") });
  const [newProject, setNewProject] = useState(false);
  const [newProfile, setNewProfile] = useState(false);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="animate-in">
      <PageHeader
        title={`${greeting}, ${user?.display_name?.split(" ")[0] ?? ""}`}
        description="Pick up a paper where you left it, or start a new one."
        actions={
          <>
            <Button variant="secondary" onClick={() => setNewProfile(true)}>
              <Feather className="h-4 w-4" /> New profile
            </Button>
            <Button onClick={() => setNewProject(true)}>
              <Plus className="h-4 w-4" /> New project
            </Button>
          </>
        }
      />

      {user?.role === "admin" ? <FirstRunChecklist /> : <WorkspaceNotReady />}

      <SectionTitle>Projects</SectionTitle>
      {projects.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[168px]" />
          ))}
        </div>
      ) : projects.data && projects.data.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FileText />}
          title="No projects yet"
          description="A project is one paper. Add the papers you want to learn from, describe what you built, and the interview takes it from there."
          action={
            <Button onClick={() => setNewProject(true)}>
              <Plus className="h-4 w-4" /> Create your first project
            </Button>
          }
        />
      )}

      <div className="mt-10">
        <SectionTitle
          right={
            <Link to="/profiles" className="text-[12.5px] font-medium text-primary hover:underline">
              See all
            </Link>
          }
        >
          Author profiles
        </SectionTitle>
        {profiles.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-[72px]" />
            ))}
          </div>
        ) : profiles.data && profiles.data.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {profiles.data.slice(0, 6).map((p) => (
              <ProfileCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Feather />}
            title="No author profiles"
            description="Upload someone's papers, yours or a colleague's, and the tool learns how they write. Projects then draft in that voice."
            action={
              <Button variant="secondary" onClick={() => setNewProfile(true)}>
                <Plus className="h-4 w-4" /> New profile
              </Button>
            }
            className="py-8"
          />
        )}
      </div>

      <NewProjectDialog open={newProject} onOpenChange={setNewProject} onCreated={(p) => navigate(`/projects/${p.slug}`)} />
      <NewProfileDialog open={newProfile} onOpenChange={setNewProfile} onCreated={(p) => navigate(`/profiles/${p.slug}`)} />
    </div>
  );
}

export function ProfilesPage() {
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api.get<Profile[]>("/api/profiles") });
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="animate-in">
      <PageHeader
        title="Author profiles"
        description="Each profile captures one person's tone and habits. Use your own, or learn from a colleague whose papers get accepted."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New profile
          </Button>
        }
      />
      {profiles.data && profiles.data.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.data.map((p) => (
            <ProfileCard key={p.id} p={p} />
          ))}
        </div>
      ) : profiles.isLoading ? (
        <Skeleton className="h-[72px]" />
      ) : (
        <EmptyState icon={<Feather />} title="No author profiles" description="Create one to start learning a voice." />
      )}
      <NewProfileDialog open={open} onOpenChange={setOpen} onCreated={(p) => navigate(`/profiles/${p.slug}`)} />
    </div>
  );
}
