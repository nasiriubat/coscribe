import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, Settings2, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { KindSummary, Profile, Project, ProjectEntry } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, ProgressRing, SectionTitle, Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/dialogs";
import { NextUp, Stepper } from "@/components/flow";
import { projectProgress } from "./library";
import { ProjectLoadError } from "@/components/load-error";

const NONE = "__none__";

function ProjectSettingsDialog({ p, open, onOpenChange, onDelete }: { p: Project; open: boolean; onOpenChange: (o: boolean) => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const kinds = useQuery({ queryKey: ["kinds"], queryFn: () => api.get<KindSummary[]>("/api/kinds"), enabled: open });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api.get<Profile[]>("/api/profiles"), enabled: open });
  const [title, setTitle] = useState(p.title);
  const [kind, setKind] = useState(p.kind);
  const [profileId, setProfileId] = useState(p.profile_id ?? NONE);
  const [venue, setVenue] = useState(p.venue ?? "");
  const [entry, setEntry] = useState<ProjectEntry>(p.entry ?? "built");

  const save = useMutation({
    mutationFn: () =>
      api.patch<Project>(`/api/projects/${p.slug}`, {
        title: title.trim(),
        kind,
        entry,
        profile_id: profileId === NONE ? null : profileId,
        clear_profile: profileId === NONE,
        venue,
      }),
    onSuccess: (np) => {
      qc.setQueryData(["project", p.slug], np);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      toast.success("Project updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Project settings">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label="Paper type" hint="Changing the type re-seeds unanswered interview rounds. Written sections are never touched.">
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(kinds.data ?? []).map((k) => (
                  <SelectItem key={k.slug} value={k.slug}>
                    {k.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Starting point" hint="Changes the order and wording of the first steps. Nothing is deleted.">
            <Select value={entry} onValueChange={(v) => setEntry(v as ProjectEntry)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="built">I built something</SelectItem>
                <SelectItem value="idea">I have an idea</SelectItem>
                <SelectItem value="draft">I have a draft</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Author voice (optional)" hint="Learned from one author's own papers. Without one, drafts follow the house style.">
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>House style</SelectItem>
                  {(profiles.data ?? []).map((pr) => (
                    <SelectItem key={pr.id} value={pr.id}>
                      {pr.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Target venue">
              <Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Optional" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
        <div className="mt-6 flex items-center justify-between gap-4 rounded-[var(--radius-sm)] border border-destructive/30 bg-destructive-soft/40 px-3 py-2.5">
          <div className="text-[12.5px]">
            <div className="font-semibold">Delete this project</div>
            <div className="text-muted-foreground">Removes every file, draft and version. Cannot be undone.</div>
          </div>
          <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectHomePage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  // "?settings=1" opens the dialog, so other pages can link straight to a project's settings.
  const [params, setParams] = useSearchParams();
  const [settings, setSettingsOpen] = useState(params.get("settings") === "1");
  const setSettings = (open: boolean) => {
    setSettingsOpen(open);
    if (!open && params.has("settings")) setParams({}, { replace: true });
  };
  const [confirmDelete, setConfirmDelete] = useState(false);

  const del = useMutation({
    mutationFn: () => api.delete(`/api/projects/${slug}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project deleted");
      navigate("/library");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (project.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;

  return (
    <div className="animate-in">
      <Link to="/library" className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> Library
      </Link>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <Badge variant="primary">{p.kind_name}</Badge>
            {p.venue ? <Badge variant="outline">{p.venue}</Badge> : null}
            <Badge variant="outline" title={p.profile_name ? "Drafts follow this author's learned voice." : "Drafts follow the house style. Attach an author profile in Settings to draft in a specific voice."}>
              {p.profile_name ? `Voice: ${p.profile_name}` : "Voice: house style"}
            </Badge>
          </span>
        }
        title={p.title}
        description={`${p.owner_name} · created ${new Date(p.created_at).toLocaleDateString()}`}
        actions={
          <>
            <div className="mr-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <ProgressRing value={projectProgress(p)} size={28} />
              {projectProgress(p)}%
            </div>
            <Button variant="secondary" onClick={() => setSettings(true)}>
              <Settings2 className="h-4 w-4" /> Settings
            </Button>
          </>
        }
      />

      <div className="mb-8">
        <NextUp p={p} />
      </div>

      <SectionTitle>Steps</SectionTitle>
      <Stepper p={p} />

      <ProjectSettingsDialog
        key={p.updated_at}
        p={p}
        open={settings}
        onOpenChange={setSettings}
        onDelete={() => {
          setSettings(false);
          setConfirmDelete(true);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this project?"
        description={`"${p.title}" and all its files, drafts and history will be removed. This cannot be undone.`}
        onConfirm={() => del.mutate()}
        busy={del.isPending}
      />
    </div>
  );
}
