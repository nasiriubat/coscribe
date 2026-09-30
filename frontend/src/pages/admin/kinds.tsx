import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookType, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Kind, KindSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionTitle, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/dialogs";

const FILES: Array<{ name: string; label: string; hint: string }> = [
  { name: "kind.md", label: "About", hint: "What the genre is, what reviewers expect, why papers get rejected." },
  { name: "sections.md", label: "Sections", hint: "Default outline when there are no example papers. Example papers win on conflict." },
  { name: "interview.md", label: "Interview", hint: "Question rounds the interview generates concrete questions from." },
  { name: "checklist.md", label: "Checklist", hint: "Evidence a paper of this type must have before export." },
];

function NewKindDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (slug: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<Kind>("/api/kinds", { name: name.trim(), summary: summary.trim() }),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: ["kinds"] });
      onOpenChange(false);
      setName("");
      setSummary("");
      onCreated(k.slug);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New paper type" description="Starts with empty templates you fill in. Members see it in the new project dialog immediately.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Dataset paper" required />
          </Field>
          <Field label="One-line summary">
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Introduces and documents a reusable dataset." />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function KindsPage() {
  const qc = useQueryClient();
  const kinds = useQuery({ queryKey: ["kinds"], queryFn: () => api.get<KindSummary[]>("/api/kinds") });
  const [selected, setSelected] = useState<string | null>(null);
  const active = selected ?? kinds.data?.[0]?.slug ?? null;
  const kind = useQuery({ queryKey: ["kind", active], queryFn: () => api.get<Kind>(`/api/kinds/${active}`), enabled: !!active });
  const [add, setAdd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const saveFile = (filename: string) => async (content: string) => {
    await api.put(`/api/kinds/${active}/files/${filename}`, { content });
    await qc.invalidateQueries({ queryKey: ["kind", active] });
    await qc.invalidateQueries({ queryKey: ["kinds"] });
  };

  const reset = useMutation({
    mutationFn: () => api.post<Kind>(`/api/kinds/${active}/reset`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kind", active] });
      setConfirmReset(false);
      toast.success("Restored the shipped version");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/api/kinds/${active}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kinds"] });
      setSelected(null);
      setConfirmDelete(false);
      toast.success("Type deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <SectionTitle
        right={
          <Button size="sm" onClick={() => setAdd(true)}>
            <Plus className="h-3.5 w-3.5" /> New type
          </Button>
        }
      >
        Paper types
      </SectionTitle>
      <div className="grid gap-5 md:grid-cols-[220px_1fr]">
        <div className="flex flex-col gap-1">
          {kinds.isLoading ? (
            <Skeleton className="h-40" />
          ) : (
            (kinds.data ?? []).map((k) => (
              <button
                key={k.slug}
                onClick={() => setSelected(k.slug)}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-muted",
                  active === k.slug ? "bg-muted font-medium" : "text-muted-foreground",
                )}
              >
                <span className="truncate">{k.name}</span>
                {!k.builtin ? <Badge variant="outline">Custom</Badge> : null}
              </button>
            ))
          )}
        </div>
        <div className="min-w-0">
          {kind.data ? (
            <>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                    <BookType className="h-4 w-4" />
                  </span>
                  <div>
                    <h3 className="text-[16px] font-semibold">{kind.data.name}</h3>
                    <p className="text-[13px] text-muted-foreground">{kind.data.summary}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {kind.data.builtin ? (
                    <Button variant="secondary" size="sm" onClick={() => setConfirmReset(true)}>
                      <RotateCcw className="h-3.5 w-3.5" /> Reset to shipped
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(true)}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              </div>
              <Tabs defaultValue="kind.md" key={kind.data.slug}>
                <TabsList>
                  {FILES.map((f) => (
                    <TabsTrigger key={f.name} value={f.name}>
                      {f.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {FILES.map((f) => (
                  <TabsContent key={f.name} value={f.name} forceMount className="data-[state=inactive]:hidden">
                    <p className="mb-2 text-[12.5px] text-muted-foreground">{f.hint}</p>
                    <MarkdownEditor value={kind.data!.files[f.name] ?? ""} onSave={saveFile(f.name)} minHeight={420} />
                  </TabsContent>
                ))}
              </Tabs>
            </>
          ) : (
            <Skeleton className="h-96" />
          )}
        </div>
      </div>
      <NewKindDialog open={add} onOpenChange={setAdd} onCreated={setSelected} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this type?"
        description="Fails if any project still uses it."
        onConfirm={() => del.mutate()}
        busy={del.isPending}
      />
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset to the shipped version?"
        description="All four files are replaced with the built-in text. Your edits are lost."
        confirmLabel="Reset"
        onConfirm={() => reset.mutate()}
        busy={reset.isPending}
      />
    </div>
  );
}
