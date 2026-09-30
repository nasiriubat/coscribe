import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Lightbulb, PenLine } from "lucide-react";
import { api } from "@/lib/api";
import type { KindSummary, Profile, Project, ProjectEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const ENTRIES: Array<{ value: ProjectEntry; label: string; icon: typeof FileText; next: string }> = [
  { value: "built", label: "I built something", icon: FileText, next: "You start by describing the system; the interview fills what a reviewer would ask." },
  { value: "idea", label: "I have an idea", icon: Lightbulb, next: "You start with research design: refine or explore the idea and get a study plan first." },
  { value: "draft", label: "I have a draft", icon: PenLine, next: "You describe the work briefly, then paste your sections into the Studio as your own." },
];

export function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: Project) => void }) {
  const qc = useQueryClient();
  const kinds = useQuery({ queryKey: ["kinds"], queryFn: () => api.get<KindSummary[]>("/api/kinds"), enabled: open });
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("tool-paper");
  const [entry, setEntry] = useState<ProjectEntry>("built");

  const create = useMutation({
    mutationFn: () =>
      api.post<Project>("/api/projects", {
        title: title.trim(),
        kind,
        entry,
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      setTitle("");
      onCreated(p);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const selectedKind = kinds.data?.find((k) => k.slug === kind);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New project" description="One project is one paper. You can change everything later.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Where are you starting from?" hint={ENTRIES.find((e) => e.value === entry)?.next}>
            <div role="radiogroup" className="grid grid-cols-3 gap-2">
              {ENTRIES.map((e) => (
                <button
                  key={e.value}
                  type="button"
                  role="radio"
                  aria-checked={entry === e.value}
                  onClick={() => setEntry(e.value)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors",
                    entry === e.value ? "border-primary bg-primary-soft/50" : "border-border hover:bg-muted/60",
                  )}
                >
                  <e.icon className={cn("h-4 w-4", entry === e.value ? "text-primary" : "text-muted-foreground")} />
                  <span className="text-[13px] font-medium leading-tight">{e.label}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field label="Working title">
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={entry === "idea" ? "A working title for the idea; you can change it" : "Tender Scout: matching public tenders to SMEs"} required />
          </Field>
          <Field label="Paper type" hint={selectedKind?.summary}>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a type" />
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
          <p className="text-[12px] text-muted-foreground">Drafts follow the house style. An author voice and a target venue can be set later in Project settings; the Review step suggests venues.</p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!title.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NewProfileDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (p: Profile) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shareable, setShareable] = useState(false);

  const create = useMutation({
    mutationFn: () => api.post<Profile>("/api/profiles", { name: name.trim(), description: description.trim() || null, shareable }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      onOpenChange(false);
      setName("");
      setDescription("");
      onCreated?.(p);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New author profile" description="A profile learns one person's voice from their papers and can be reused across projects.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nasir" required />
          </Field>
          <Field label="Notes" hint="Optional. Who this is, what they write about.">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[72px]" />
          </Field>
          <label className="flex items-center justify-between gap-4 rounded-[var(--radius-sm)] border border-border px-3 py-2.5">
            <span>
              <span className="block text-[13px] font-medium">Share with the workspace</span>
              <span className="block text-[12px] text-muted-foreground">Other members can use this profile in their projects.</span>
            </span>
            <Switch checked={shareable} onCheckedChange={setShareable} />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create profile
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description} className="max-w-md">
        <DialogFooter className="mt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
