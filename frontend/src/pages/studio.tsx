import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  CircleDashed,
  Feather,
  History,
  ListChecks,
  Lock,
  LockOpen,
  Quote,
  Image as ImageIcon,
  PenLine,
  Plus,
  RotateCcw,
  Search as SearchIcon,
  Sparkles,
  Wand2,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ChecklistItem, Figure, FixProposal, JobInfo, LintFinding, Profile, Project, RefRecord, ResultTable, Section, SectionDetail, StudioState } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { useTheme } from "@/lib/theme";
import { diffLines, diffWords } from "@/lib/diff";
import { track } from "@/lib/events";
import { useUnsaved } from "@/lib/unsaved";
import { stepTitle } from "@/lib/flow";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JobProgress } from "@/components/papers";
import { ConfirmDialog } from "@/components/dialogs";
import { RichMarkdown } from "@/components/rich-markdown";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";
import { CitationsPanel, citationRows } from "@/components/citations-panel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const STATUS: Record<Section["status"], { label: string; variant: "neutral" | "primary" | "success" | "warning" }> = {
  empty: { label: "Empty", variant: "neutral" },
  drafted: { label: "Drafted", variant: "primary" },
  edited: { label: "Edited", variant: "success" },
  mine: { label: "Yours", variant: "success" },
};

const SAVE_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘S" : "Ctrl+S";

function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== "undefined" ? window.matchMedia(q).matches : true));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = (e: MediaQueryListEvent) => setMatch(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [q]);
  return match;
}

function ReviewSubTab({
  active,
  onClick,
  label,
  count,
  tone = "muted",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "muted" | "warning";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1 font-medium transition-colors",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count ? (
        <span className={cn("ml-1 rounded-full px-1.5 text-[10px]", tone === "warning" ? "bg-warning text-white" : "bg-muted-foreground/30")}>{count}</span>
      ) : null}
    </button>
  );
}

function words(text: string): number {
  return (text.replace(/\[(NEEDS|CITE):[^\]]*\]/g, "").match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? []).length;
}

function toDiagnostics(view: EditorView, findings: LintFinding[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const doc = view.state.doc;
  for (const f of findings) {
    if (f.line < 1 || f.line > doc.lines) continue;
    const line = doc.line(f.line);
    let from = line.from;
    let to = line.to;
    if (f.excerpt) {
      const idx = line.text.indexOf(f.excerpt);
      if (idx >= 0) {
        from = line.from + idx;
        to = from + f.excerpt.length;
      }
    }
    if (to <= from) to = Math.min(line.to, from + 1);
    out.push({ from, to, severity: f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info", message: f.message });
  }
  return out;
}

function SectionRail({ sections, selected, onSelect }: { sections: Section[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0 [&>button]:min-w-[200px] lg:[&>button]:min-w-0">
      {sections.map((s) => {
        const active = s.id === selected;
        const pct = s.target_words ? Math.min(100, Math.round(((s.words ?? 0) / s.target_words) * 100)) : 0;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cn("group rounded-lg border px-3 py-2.5 text-left transition-colors", active ? "border-primary/40 bg-primary-soft/40" : "border-transparent hover:bg-muted")}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  s.status === "empty" && "bg-border-strong",
                  s.status === "drafted" && "bg-primary",
                  (s.status === "edited" || s.status === "mine") && "bg-success",
                )}
              />
              <span className={cn("min-w-0 flex-1 truncate text-[13px]", active ? "font-semibold" : "font-medium")}>
                {s.order}. {s.title}
              </span>
              {s.status === "mine" ? <Lock className="h-3 w-3 text-success" /> : null}
            </div>
            <div className="mt-1 flex items-center gap-2 pl-4 text-[11.5px] text-subtle">
              <span className="tabular-nums">
                {s.words ?? 0}
                {s.target_words ? ` / ${s.target_words}` : ""} words
              </span>
              {s.open_items ? <span className="text-warning">{s.open_items} open</span> : null}
              {s.lint?.errors ? <span className="text-destructive">{s.lint.errors} err</span> : null}
            </div>
            {s.target_words ? (
              <div className="ml-4 mt-1.5 h-0.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", pct >= 85 ? "bg-success" : "bg-primary/70")} style={{ width: `${pct}%` }} />
              </div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ChecklistPanel({ slug, items, sectionTitle }: { slug: string; items: ChecklistItem[]; sectionTitle: string | null }) {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const patch = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ChecklistItem["status"] }) => api.patch(`/api/projects/${slug}/checklist/${id}`, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["checklist", slug] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const visible = items.filter((i) => showAll || i.section === sectionTitle || i.section === "Whole paper");
  const open = visible.filter((i) => i.status === "open");
  const closed = visible.filter((i) => i.status !== "open");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-[12.5px] text-muted-foreground">
        <span>
          {open.length} open{sectionTitle && !showAll ? " for this section" : ""}
        </span>
        <button onClick={() => setShowAll((v) => !v)} className="font-medium text-primary hover:underline">
          {showAll ? "This section only" : "Whole paper"}
        </button>
      </div>
      {open.length === 0 ? <p className="text-[13px] text-subtle">Nothing open here.</p> : null}
      {open.map((i) => (
        <div key={i.id} className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning-soft/40 p-3 text-[13px]">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div>{i.text}</div>
              <div className="mt-0.5 text-[11.5px] text-subtle">
                {i.section} · from {i.source}
              </div>
            </div>
          </div>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => patch.mutate({ id: i.id, status: "resolved" })}>
              <Check className="h-3.5 w-3.5" /> Resolved
            </Button>
            <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: i.id, status: "limitation" })}>
              State as limitation
            </Button>
          </div>
        </div>
      ))}
      {closed.length ? (
        <details className="text-[12.5px] text-muted-foreground">
          <summary className="cursor-pointer">{closed.length} closed</summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {closed.map((i) => (
              <div key={i.id} className="flex items-start gap-2 rounded-md px-2 py-1">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                <span className="line-through opacity-70">{i.text}</span>
                <button onClick={() => patch.mutate({ id: i.id, status: "open" })} className="ml-auto text-primary hover:underline">
                  Reopen
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

const AUTO_FIXABLE = new Set(["banned", "dash", "semicolon", "long", "opener", "exclamation", "question", "overlap"]);
const KIND_LABEL: Record<string, string> = {
  needs: "open items",
  citation: "citations to verify",
  long: "long sentences",
  banned: "banned phrases",
  dash: "dashes",
  semicolon: "semicolons",
  opener: "repeated openers",
  exclamation: "exclamation marks",
  question: "rhetorical questions",
  overlap: "overlap with an example paper",
};

function claimOf(f: LintFinding): string | null {
  const m = f.excerpt.match(/^\[CITE:\s*([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

function IssuesPanel({ slug, findings, onJump, onFix, fixing, disabled }: { slug: string; findings: LintFinding[]; onJump: (line: number) => void; onFix: () => void; fixing: boolean; disabled: boolean }) {
  if (findings.length === 0) return <p className="text-[13px] text-subtle">No issues. The lint checks house-style rules, placeholders and citation keys.</p>;
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  const fixable = findings.filter((f) => AUTO_FIXABLE.has(f.kind)).length;
  const manual = findings.length - fixable;
  return (
    <div className="flex flex-col gap-1.5">
      {fixable > 0 ? (
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border bg-muted/40 p-2.5">
          <div className="text-[12.5px] text-muted-foreground">
            {fixable} of {findings.length} can be fixed for you{manual ? `. ${manual} need${manual === 1 ? "s" : ""} your call.` : "."}
            <span className="block text-[11.5px] text-subtle">You see every change before it is saved.</span>
          </div>
          <Button size="sm" onClick={onFix} loading={fixing} disabled={disabled}>
            <Wand2 className="h-3.5 w-3.5" /> Fix issues
          </Button>
        </div>
      ) : null}
      {sorted.map((f, i) => {
        const claim = claimOf(f);
        return (
          <div key={i} className="flex items-start gap-1 rounded-md hover:bg-muted">
            <button onClick={() => onJump(f.line)} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-[12.5px]">
              <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", f.severity === "error" ? "bg-destructive" : f.severity === "warning" ? "bg-warning" : "bg-border-strong")} />
              <span className="min-w-0 flex-1">
                <span className="text-foreground">{f.message}</span>
                <span className="ml-1 text-subtle">line {f.line}</span>
              </span>
            </button>
            {claim ? (
              <Tooltip content="Search the three indexes for this claim">
                <Link to={`/projects/${slug}/references?q=${encodeURIComponent(claim.slice(0, 200))}`} className="mr-1 mt-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-primary hover:bg-primary-soft">
                  <SearchIcon className="h-3 w-3" /> Search
                </Link>
              </Tooltip>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function HistoryDialog({ slug, section, current, onRestore, onClose }: { slug: string; section: Section; current: string; onRestore: (text: string) => void; onClose: () => void }) {
  const hist = useQuery({ queryKey: ["history", slug, section.id], queryFn: () => api.get<Array<{ sha: string; timestamp: number; message: string }>>(`/api/projects/${slug}/sections/${section.id}/history`) });
  const [sha, setSha] = useState<string | null>(null);
  const ver = useQuery({ queryKey: ["version", slug, section.id, sha], queryFn: () => api.get<{ content: string }>(`/api/projects/${slug}/sections/${section.id}/versions/${sha}`), enabled: !!sha });
  const diff = useMemo(() => (ver.data ? diffLines(ver.data.content, current) : []), [ver.data, current]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Versions of “${section.title}”`} description="Every save and every draft is a version. Pick one to compare with the current text." className="max-w-4xl">
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <div className="max-h-[60vh] overflow-y-auto">
            {(hist.data ?? []).map((h) => (
              <button
                key={h.sha}
                onClick={() => setSha(h.sha)}
                className={cn("w-full rounded-md px-2.5 py-2 text-left text-[12.5px] hover:bg-muted", sha === h.sha && "bg-muted font-medium")}
              >
                <div className="truncate">{h.message.replace(/^(Edit|Draft) section: .*/, (m) => m.split(" section:")[0])}</div>
                <div className="text-[11.5px] text-subtle">{timeAgo(new Date(h.timestamp * 1000).toISOString())}</div>
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed">
            {!sha ? (
              <p className="text-subtle">Select a version on the left.</p>
            ) : ver.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              diff.map((d, i) => (
                <div key={i} className={cn("whitespace-pre-wrap px-1", d.type === "add" && "bg-success-soft text-success", d.type === "del" && "bg-destructive-soft text-destructive line-through")}>
                  {d.text || " "}
                </div>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="secondary"
            disabled={!ver.data}
            onClick={() => {
              if (ver.data) onRestore(ver.data.content);
              onClose();
            }}
          >
            <RotateCcw className="h-4 w-4" /> Load this version into the editor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FixDialog({ proposal, current, onAccept, onClose, saving }: { proposal: FixProposal; current: string; onAccept: () => void; onClose: () => void; saving: boolean }) {
  const diff = useMemo(() => diffWords(current, proposal.text), [current, proposal.text]);
  const remaining = proposal.after.length;
  const fixed = Math.max(0, proposal.before_count - remaining);
  const parts = [proposal.mechanical ? `Mechanical: ${proposal.mechanical}` : "", proposal.model_used ? `Wording by the model (${(proposal.tokens_in + proposal.tokens_out).toLocaleString()} tokens)` : ""].filter(Boolean);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={proposal.changed ? `${fixed} of ${proposal.before_count} issue${proposal.before_count === 1 ? "" : "s"} resolved` : "Nothing to fix automatically"}
        description={proposal.changed ? "Red is removed, green is added. Citations and placeholders were kept as they were. Nothing is saved until you accept." : undefined}
        className="max-w-3xl"
      >
        {parts.length ? <p className="mb-2 text-[12.5px] text-muted-foreground">{parts.join(" · ")}</p> : null}
        {proposal.note ? <p className="mb-2 rounded-[var(--radius-sm)] bg-warning-soft/50 px-3 py-2 text-[12.5px] text-warning">{proposal.note}</p> : null}
        {proposal.changed ? (
          <div className="max-h-[55vh] overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-muted/30 p-3 text-[13.5px] leading-[1.7]">
            {diff.map((d, i) =>
              d.text === "\n" ? (
                <br key={i} />
              ) : (
                <span key={i} className={cn("whitespace-pre-wrap", d.type === "add" && "rounded-sm bg-success-soft text-success", d.type === "del" && "rounded-sm bg-destructive-soft text-destructive line-through decoration-destructive/60")}>
                  {d.text}
                </span>
              ),
            )}
          </div>
        ) : null}
        {remaining > 0 && proposal.changed ? (
          <p className="mt-2 text-[12px] text-subtle">
            {remaining} finding{remaining === 1 ? "" : "s"} remain{remaining === 1 ? "s" : ""} for you: {Array.from(new Set(proposal.after.map((f) => KIND_LABEL[f.kind] ?? f.kind))).join(", ")}.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {proposal.changed ? "Discard" : "Close"}
          </Button>
          {proposal.changed ? (
            <Button onClick={onAccept} loading={saving}>
              <Check className="h-4 w-4" /> Accept and save
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StudioPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const { resolved } = useTheme();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const studio = useQuery({ queryKey: ["studio", slug], queryFn: () => api.get<StudioState>(`/api/projects/${slug}/studio`) });
  const checklist = useQuery({ queryKey: ["checklist", slug], queryFn: () => api.get<ChecklistItem[]>(`/api/projects/${slug}/checklist`) });
  const refs = useQuery({ queryKey: ["references", slug], queryFn: () => api.get<RefRecord[]>(`/api/projects/${slug}/references`) });
  const figs = useQuery({ queryKey: ["figures", slug], queryFn: () => api.get<Figure[]>(`/api/projects/${slug}/figures`) });
  const tables = useQuery({ queryKey: ["results", slug], queryFn: () => api.get<ResultTable[]>(`/api/projects/${slug}/results`) });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api.get<Profile[]>("/api/profiles") });
  const voiceKey = `pw.voiceHint.${slug}`;
  const [voiceHintHidden, setVoiceHintHidden] = useState(() => {
    try {
      return localStorage.getItem(voiceKey) === "1";
    } catch {
      return false;
    }
  });
  const hideVoiceHint = () => {
    setVoiceHintHidden(true);
    try {
      localStorage.setItem(voiceKey, "1");
    } catch {
      /* private mode: the hint simply returns next visit */
    }
  };
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ["section", slug, selected], queryFn: () => api.get<SectionDetail>(`/api/projects/${slug}/sections/${selected}`), enabled: !!selected });

  const [text, setText] = useState("");
  const [findings, setFindings] = useState<LintFinding[]>([]);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [confirmForce, setConfirmForce] = useState<null | { instructions: string }>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tab, setTab] = useState("preview");
  // Review groups the three "what still needs attention" surfaces so a newcomer meets
  // three tabs (Preview / Plan / Review), not five. reviewTab picks which one shows.
  const [reviewTab, setReviewTab] = useState("checklist");
  const [citeFocus, setCiteFocus] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lintTimer = useRef<number | null>(null);

  const sections = studio.data?.sections ?? [];
  const section = sections.find((s) => s.id === selected) ?? null;
  const serverText = detail.data?.content ?? "";
  const dirty = !!detail.data && text !== serverText;
  useUnsaved(dirty);

  const lastKey = `pw.studio.last.${slug}`;
  useEffect(() => {
    if (selected || !sections.length) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(lastKey);
    } catch {
      /* private mode: open on the first empty section instead */
    }
    setSelected(sections.find((s) => s.id === last)?.id ?? sections.find((s) => s.status === "empty")?.id ?? sections[0].id);
  }, [sections, selected, lastKey]);
  useEffect(() => {
    if (!selected) return;
    try {
      localStorage.setItem(lastKey, selected);
    } catch {
      /* fine without storage */
    }
  }, [selected, lastKey]);

  useEffect(() => {
    if (detail.data) {
      setText(detail.data.content);
      setFindings(detail.data.lint);
    }
  }, [detail.data]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch(setDiagnostics(view.state, toDiagnostics(view, findings)));
  }, [findings, text]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["studio", slug] });
    void qc.invalidateQueries({ queryKey: ["section", slug] });
    void qc.invalidateQueries({ queryKey: ["checklist", slug] });
    void qc.invalidateQueries({ queryKey: ["project", slug] });
  }, [qc, slug]);

  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "draft_section") {
      refresh();
      if (j.status === "done") track("section_drafted", { slug, meta: { words: Number(j.result?.words ?? 0), issues: Number(j.result?.issues ?? 0) } });
    }
  });
  const draftingIds = new Set(jobs.filter((j) => j.status === "queued" || j.status === "running").map((j) => (j.result?.section_id as string) ?? j.message?.replace("Queued: ", "")));

  const init = useMutation({
    mutationFn: () => api.post<StudioState>(`/api/projects/${slug}/studio/init`),
    onSuccess: () => {
      refresh();
      toast.success("Sections created from your outline");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [importText, setImportText] = useState("");
  const importDraft = useMutation({
    mutationFn: () => api.post<StudioState & { imported: { sections: number; with_text: number; words: number } }>(`/api/projects/${slug}/studio/import`, { markdown: importText }),
    onSuccess: (r) => {
      refresh();
      setImportText("");
      toast.success(`Imported ${r.imported.sections} section${r.imported.sections === 1 ? "" : "s"} as yours`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: (content?: string) => api.put<SectionDetail>(`/api/projects/${slug}/sections/${selected}`, { content: content ?? text }),
    onSuccess: (d) => {
      qc.setQueryData(["section", slug, selected], d);
      setText(d.content);
      setFindings(d.lint);
      track("section_saved", { slug, meta: { words: words(d.content), issues: d.lint.length } });
      void qc.invalidateQueries({ queryKey: ["studio", slug] });
      void qc.invalidateQueries({ queryKey: ["checklist", slug] });
      void qc.invalidateQueries({ queryKey: ["project", slug] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const draft = useMutation({
    mutationFn: ({ id, instructions, force }: { id: string; instructions?: string; force?: boolean }) =>
      api.post<JobInfo>(`/api/projects/${slug}/sections/${id}/draft`, { instructions: instructions ?? "", force: !!force }),
    onSuccess: (job) => {
      watch(job);
      setInstructionsOpen(false);
      setInstructions("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [fixProposal, setFixProposal] = useState<FixProposal | null>(null);
  const fix = useMutation({
    mutationFn: () => api.post<FixProposal>(`/api/projects/${slug}/sections/${selected}/fix`, { text }),
    onSuccess: (p) => setFixProposal(p),
    onError: (e: Error) => toast.error(e.message),
  });
  const acceptFix = () => {
    if (!fixProposal) return;
    save.mutate(fixProposal.text, {
      onSuccess: (d) => {
        track("fix_accepted", { slug, meta: { before: fixProposal.before_count, after: d.lint.length, model: fixProposal.model_used } });
        setFixProposal(null);
        toast.success(d.lint.length ? `Saved. ${d.lint.length} finding${d.lint.length === 1 ? "" : "s"} left for you.` : "Saved. No issues left.");
      },
    });
  };
  const addSection = useMutation({
    mutationFn: (title: string) => api.post<StudioState & { section: Section }>(`/api/projects/${slug}/studio/sections`, { title }),
    onSuccess: (r) => {
      refresh();
      void selectSection(r.section.id);
      track("section_added", { slug, meta: { title: r.section.title.slice(0, 60) } });
      toast.success(`Added “${r.section.title}”. Draft it or write it yourself.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const lock = useMutation({
    mutationFn: (mine: boolean) => api.post<Section>(`/api/projects/${slug}/sections/${selected}/lock`, { mine }),
    onSuccess: (s) => {
      refresh();
      toast.success(s.status === "mine" ? "Marked as yours. Regeneration now asks first." : "Unlocked");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Switching section keeps the author's edits: they are saved as a version before the editor moves on. */
  const selectSection = async (id: string) => {
    if (id === selected) return;
    if (dirty) {
      try {
        await save.mutateAsync(undefined);
        toast.success(`Saved your edits to “${section?.title ?? "the section"}”`);
      } catch {
        return; // the save's own error toast explains; stay on the section
      }
    }
    setSelected(id);
  };

  const requestDraft = (instr = "") => {
    if (!section) return;
    if (dirty) {
      toast.error("Save or discard your edits before drafting");
      return;
    }
    if (section.status === "mine" || (section.status === "edited" && !instr)) {
      setConfirmForce({ instructions: instr });
      return;
    }
    draft.mutate({ id: section.id, instructions: instr, force: false });
  };

  const onChange = useCallback(
    (value: string) => {
      setText(value);
      if (lintTimer.current) window.clearTimeout(lintTimer.current);
      lintTimer.current = window.setTimeout(() => {
        void api.post<LintFinding[]>(`/api/projects/${slug}/lint`, { text: value }).then(setFindings).catch(() => undefined);
      }, 900);
    },
    [slug],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  const insertCitation = (key: string) => {
    const view = viewRef.current;
    if (!view) return;
    let { from, to } = view.state.selection.main;
    if (from === to && from === 0 && view.state.doc.length > 0) {
      // Nobody cites at the very start of a section: with no caret placed, cite the first sentence.
      const firstLine = view.state.doc.line(1).text;
      const end = firstLine.search(/[.!?](\s|$)/);
      from = to = end >= 0 ? end : firstLine.length;
    }
    const before = view.state.doc.sliceString(Math.max(0, from - 1), from);
    const after = view.state.doc.sliceString(to, to + 1);
    const text = `${before && !/\s/.test(before) ? " " : ""}[@${key}]${after && !/[\s.,;:!?)]/.test(after) ? " " : ""}`;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
    onChange(view.state.doc.toString());
  };

  const insertTable = async (t: ResultTable) => {
    const view = viewRef.current;
    if (!view) return;
    const r = await api.get<{ markdown: string }>(`/api/projects/${slug}/results/${t.name}/snippet`);
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: r.markdown }, selection: { anchor: from + r.markdown.length } });
    view.focus();
    onChange(view.state.doc.toString());
  };

  const insertFigure = (f: Figure) => {
    const view = viewRef.current;
    if (!view) return;
    const ext = f.kind === "mermaid" ? "svg" : (f.file ?? "x.png").split(".").pop();
    const { from, to } = view.state.selection.main;
    const text = `\n\n![${f.caption || f.name}](figures/${f.name}.${ext}){#fig:${f.name}}\n\n`;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
    onChange(view.state.doc.toString());
  };

  /** The selection, or the sentence around the caret, with document offsets. */
  const getSentence = () => {
    const view = viewRef.current;
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    if (to > from) return { text: view.state.doc.sliceString(from, to).trim(), from, to };
    const line = view.state.doc.lineAt(from);
    const rel = from - line.from;
    const re = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text))) {
      const s = m.index;
      const e = m.index + m[0].length;
      if (rel >= s && rel <= e) {
        const lead = m[0].length - m[0].trimStart().length;
        return { text: m[0].trim(), from: line.from + s + lead, to: line.from + e };
      }
    }
    return { text: line.text.trim(), from: line.from, to: line.to };
  };
  const citeAt = (key: string, at: number) => {
    const view = viewRef.current;
    if (!view) return;
    // put the key before the sentence's closing punctuation
    const prev = view.state.doc.sliceString(Math.max(0, at - 1), at);
    const pos = /[.!?]/.test(prev) ? at - 1 : at;
    const before = view.state.doc.sliceString(Math.max(0, pos - 1), pos);
    const insert = `${before && !/\s/.test(before) ? " " : ""}[@${key}]`;
    view.dispatch({ changes: { from: pos, to: pos, insert }, selection: { anchor: pos + insert.length } });
    view.focus();
    onChange(view.state.doc.toString());
  };
  const replaceRange = (from: number, to: number, replacement: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from, to, insert: replacement }, selection: { anchor: from + replacement.length } });
    view.focus();
    onChange(view.state.doc.toString());
  };

  const jumpTo = (line: number) => {
    const view = viewRef.current;
    if (!view || line < 1 || line > view.state.doc.lines) return;
    const pos = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  };

  const citeCount = useMemo(() => citationRows(text).length, [text]);
  const badKeys = useMemo(() => new Set(findings.filter((f) => f.kind === "citation" && f.severity === "error").flatMap((f) => (f.excerpt.match(/@([^\]\s;]+)/g) ?? []).map((k) => k.slice(1)))), [findings]);
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping, lintGutter()], []);

  if (project.isLoading || studio.isLoading) return <Skeleton className="h-64" />;
  if (!project.data || !studio.data) return <ProjectLoadError query={project.data ? studio : project} />;
  const p = project.data;
  const approved = ["outline", "drafting", "review", "export"].includes(p.stage);
  const nextEmpty = sections.find((s) => s.status === "empty");
  const missing = studio.data.missing ?? [];
  const drafted = sections.filter((s) => s.status !== "empty").length;
  const openForSection = (checklist.data ?? []).filter((i) => i.status === "open" && section && (i.section === section.title || i.section === "Whole paper")).length;
  const reviewCount = openForSection + findings.length;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={
          sections.length ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge variant="primary">
                {drafted} of {sections.length} sections drafted
              </Badge>
              {missing.length ? <Badge variant="warning">{missing.length} the type expects {missing.length === 1 ? "is" : "are"} missing</Badge> : null}
            </span>
          ) : (
            <Badge>Not started</Badge>
          )
        }
        title={stepTitle("studio", p)}
        description="One section at a time, from the approved outline. Drafts use only your spec, answers and facts; gaps are marked [NEEDS]. Once you edit a section it is yours, and regeneration asks first."
        actions={
          sections.length ? (
            <Button onClick={() => nextEmpty && draft.mutate({ id: nextEmpty.id })} disabled={!nextEmpty || active} loading={draft.isPending}>
              <Sparkles className="h-4 w-4" /> {nextEmpty ? `Draft next: ${nextEmpty.title}` : "All sections drafted"}
            </Button>
          ) : null
        }
      />

      <JobProgress jobs={jobs} onDismiss={dismiss} />

      {studio.data.initialized && missing.length === 0 && !p.profile_id && !voiceHintHidden && (profiles.data ?? []).some((pr) => pr.status === "ready") ? (
        <div className="mb-4 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-border bg-muted/40 px-4 py-2.5 text-[13px] sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Feather className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="font-medium">Draft in a learned voice?</span>{" "}
              <span className="text-muted-foreground">
                {(profiles.data ?? []).filter((pr) => pr.status === "ready").map((pr) => pr.name).join(", ")} {(profiles.data ?? []).filter((pr) => pr.status === "ready").length === 1 ? "is" : "are"} ready. Drafts currently follow the house style only.
              </span>
            </span>
          </div>
          <div className="flex shrink-0 gap-3 pl-6 sm:pl-0">
            <Link to={`/projects/${slug}?settings=1`} className="text-[12.5px] font-medium text-primary hover:underline">
              Choose in Project settings
            </Link>
            <button onClick={hideVoiceHint} className="text-[12.5px] text-subtle hover:text-foreground">
              Keep house style
            </button>
          </div>
        </div>
      ) : null}

      {studio.data.initialized && missing.length ? (
        <Card className="mb-4 flex flex-wrap items-center gap-2 border-warning/40 bg-warning-soft/30 px-4 py-3">
          <div className="mr-auto min-w-0 text-[13px]">
            <span className="font-medium">{/^[aeiou]/i.test(p.kind) ? "An" : "A"} {p.kind.replace(/-/g, " ")} usually also has:</span>{" "}
            <span className="text-muted-foreground">{missing.join(", ")}.</span>
            <span className="block text-[12px] text-subtle">Add the ones your paper needs. Each starts empty, with an outline line you can edit in the Plan tab.</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {missing.map((t) => (
              <Button key={t} size="sm" variant="secondary" onClick={() => addSection.mutate(t)} disabled={addSection.isPending}>
                <Plus className="h-3.5 w-3.5" /> {t}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      {!studio.data.initialized ? (
        <div className={cn("grid gap-4", "lg:grid-cols-2")}>
          <Card className={cn("flex flex-col gap-3 p-5", p.entry === "draft" && "border-primary/40 lg:order-first")}>
            <div>
              <h3 className="text-[15px] font-semibold">Already have a draft? Paste it here</h3>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Every <code className="font-mono text-[12px]">##</code> heading becomes a section marked as yours, and its paragraphs become the outline. Nothing is rewritten; lint, references, the reviewer and export work on your text.
              </p>
            </div>
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"# Title\n\n## Introduction\nYour first paragraph...\n\n## Approach\n..."}
              className="min-h-[220px] font-mono text-[12.5px]"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-subtle">{importText.trim() ? `${importText.trim().split(/\s+/).length.toLocaleString()} words` : "Markdown or plain text with headings"}</span>
              <Button onClick={() => importDraft.mutate()} loading={importDraft.isPending} disabled={!importText.trim()}>
                <PenLine className="h-4 w-4" /> Import as my sections
              </Button>
            </div>
          </Card>
          <EmptyState
            icon={<ListChecks />}
            title={approved ? "Or create empty sections from your outline" : "Or plan first: approve an outline"}
            description={
              approved
                ? "Each ## heading in the approved outline becomes a section file. Its bullet lines become the paragraphs the draft must follow, and every [NEEDS] item lands on the checklist."
                : "The model drafts from an approved outline so the paper follows a plan you agreed to. Starting from scratch? Go through the interview and outline first."
            }
            action={
              approved ? (
                <Button variant="secondary" onClick={() => init.mutate()} loading={init.isPending}>
                  <ListChecks className="h-4 w-4" /> Create sections
                </Button>
              ) : (
                <Link to={`/projects/${slug}/outline`}>
                  <Button variant="secondary">Go to the outline</Button>
                </Link>
              )
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)_320px]">
          <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
            <SectionRail sections={sections} selected={selected} onSelect={(id) => void selectSection(id)} />
          </aside>
          <div className="lg:hidden">
            <Select value={selected ?? undefined} onValueChange={(id) => void selectSection(id)}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a section" />
              </SelectTrigger>
              <SelectContent>
                {sections.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.order}. {s.title} · {s.words ?? 0}/{s.target_words} words{s.open_items ? ` · ${s.open_items} open` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0">
            {section ? (
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-2 sm:gap-2 sm:px-3">
                  <div className="mr-auto flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-[14px] font-semibold">
                      {section.order}. {section.title}
                    </h2>
                    <Badge variant={STATUS[section.status].variant}>{STATUS[section.status].label}</Badge>
                    <span className="text-[12px] tabular-nums text-subtle">
                      {words(text)}
                      {section.target_words ? ` / ${section.target_words}` : ""} words
                    </span>
                  </div>
                  <Tooltip content={section.status === "empty" ? "Draft this section from the outline" : "Regenerate from scratch"}>
                    <Button size="sm" variant={section.status === "empty" ? "primary" : "secondary"} onClick={() => requestDraft()} disabled={draftingIds.has(section.id) || active}>
                      <Sparkles className="h-3.5 w-3.5" /> {section.status === "empty" ? "Draft" : "Redraft"}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Revise the current text with instructions">
                    <Button size="sm" variant="secondary" onClick={() => setInstructionsOpen(true)} disabled={section.status === "empty" || active}>
                      <Wand2 className="h-3.5 w-3.5" /> Revise…
                    </Button>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="secondary" disabled={!refs.data?.length} title={refs.data?.length ? "Insert a citation" : "Add references first"}>
                        <Quote className="h-3.5 w-3.5" /> Cite
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-80 w-[360px] overflow-y-auto">
                      <DropdownMenuLabel>Insert at cursor</DropdownMenuLabel>
                      {(refs.data ?? []).map((r) => (
                        <DropdownMenuItem key={r.key} onSelect={() => insertCitation(r.key)}>
                          <span className="min-w-0">
                            <span className="block truncate text-[12.5px]">{r.title}</span>
                            <span className="block font-mono text-[11px] text-subtle">@{r.key}</span>
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="secondary" disabled={!figs.data?.length && !tables.data?.length} title={figs.data?.length || tables.data?.length ? "Insert a figure or a results table" : "Add figures or results first"}>
                        <ImageIcon className="h-3.5 w-3.5" /> Figure
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-80 w-[320px] overflow-y-auto">
                      {figs.data?.length ? <DropdownMenuLabel>Figures</DropdownMenuLabel> : null}
                      {(figs.data ?? []).map((f) => (
                        <DropdownMenuItem key={f.name} onSelect={() => insertFigure(f)}>
                          <span className="min-w-0">
                            <span className="block truncate text-[12.5px]">{f.caption || f.name}</span>
                            <span className="block font-mono text-[11px] text-subtle">figures/{f.name}</span>
                          </span>
                        </DropdownMenuItem>
                      ))}
                      {tables.data?.length ? <DropdownMenuLabel>Results tables</DropdownMenuLabel> : null}
                      {(tables.data ?? []).map((t) => (
                        <DropdownMenuItem key={t.name} onSelect={() => void insertTable(t)}>
                          <span className="min-w-0">
                            <span className="block truncate text-[12.5px]">{t.caption || t.title}</span>
                            <span className="block font-mono text-[11px] text-subtle">
                              {t.rows} rows · {t.columns.slice(0, 4).join(", ")}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Tooltip content={section.status === "mine" ? "Unlock: allow regeneration without asking" : "Mark as yours: regeneration will ask first"}>
                    <Button size="sm" variant="ghost" onClick={() => lock.mutate(section.status !== "mine")} disabled={section.status === "empty"}>
                      {section.status === "mine" ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Versions">
                    <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
                      <History className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                  <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
                    Save
                  </Button>
                </div>
                {detail.isLoading ? (
                  <Skeleton className="h-[520px]" />
                ) : (
                  <CodeMirror
                    value={text}
                    onChange={onChange}
                    theme={resolved === "dark" ? "dark" : "light"}
                    extensions={extensions}
                    height={isDesktop ? "calc(100vh - 300px)" : "auto"}
                    minHeight={isDesktop ? "480px" : "260px"}
                    basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
                    onCreateEditor={(view) => {
                      viewRef.current = view;
                      view.dispatch(setDiagnostics(view.state, toDiagnostics(view, findings)));
                    }}
                    placeholder={section.status === "empty" ? "Empty. Press Draft to write this section from its outline lines, or start typing." : ""}
                    className="text-[14px] [&_.cm-editor]:bg-transparent [&_.cm-content]:px-3 [&_.cm-content]:py-3 [&_.cm-content]:font-sans [&_.cm-content]:leading-[1.7] [&_.cm-focused]:outline-none [&_.cm-gutters]:bg-transparent [&_.cm-gutters]:border-0"
                  />
                )}
                {dirty ? <div className="border-t border-border bg-warning-soft/40 px-3 py-1.5 text-[12px] text-warning">Unsaved changes. {SAVE_KEYS} or Save.</div> : null}
              </Card>
            ) : (
              <Skeleton className="h-[520px]" />
            )}
          </div>

          <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
            <Card className="p-3">
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="h-auto w-full">
                  <TabsTrigger value="preview" className="flex-1">
                    Preview
                  </TabsTrigger>
                  <TabsTrigger value="plan" className="flex-1">
                    Plan
                  </TabsTrigger>
                  <TabsTrigger value="review" className="flex-1">
                    Review{reviewCount ? <span className="ml-1 rounded-full bg-warning px-1.5 text-[10px] text-white">{reviewCount}</span> : null}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="preview" className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-320px)]">
                  {text.trim() ? (
                    <div
                      onClick={(e) => {
                        const cite = (e.target as HTMLElement).closest?.("cite");
                        if (!cite) return;
                        setCiteFocus(cite.textContent?.replace(/^@/, "") ?? null);
                        setTab("review");
                        setReviewTab("citations");
                      }}
                      title="Click a citation to see what the paper says"
                      className="[&_cite]:cursor-pointer"
                    >
                      <RichMarkdown source={`## ${section?.title ?? ""}\n\n${text}`} badKeys={badKeys} figureBase={`/api/projects/${slug}/figures`} />
                    </div>
                  ) : (
                    <p className="text-[13px] text-subtle">Nothing to preview yet.</p>
                  )}
                </TabsContent>
                <TabsContent value="plan" className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-320px)]">
                  <p className="mb-2 text-[12px] text-muted-foreground">One paragraph per line. The draft follows these in order.</p>
                  <ol className="flex flex-col gap-2 text-[13px]">
                    {(section?.lines ?? []).map((l, i) => (
                      <li key={i} className={cn("flex gap-2 rounded-md px-2 py-1.5", /\[NEEDS:/.test(l) ? "bg-warning-soft/50" : "bg-muted/50")}>
                        <span className="text-subtle tabular-nums">{i + 1}.</span>
                        <span>{l}</span>
                      </li>
                    ))}
                  </ol>
                </TabsContent>
                <TabsContent value="review" className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-320px)]">
                  <div className="mb-3 inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-[12.5px]">
                    <ReviewSubTab active={reviewTab === "checklist"} onClick={() => setReviewTab("checklist")} label="Items" count={openForSection} tone="warning" />
                    <ReviewSubTab active={reviewTab === "issues"} onClick={() => setReviewTab("issues")} label="Issues" count={findings.length} />
                    <ReviewSubTab active={reviewTab === "citations"} onClick={() => setReviewTab("citations")} label="Citations" count={citeCount} />
                  </div>
                  {reviewTab === "checklist" ? (
                    <ChecklistPanel slug={slug} items={checklist.data ?? []} sectionTitle={section?.title ?? null} />
                  ) : reviewTab === "issues" ? (
                    <IssuesPanel slug={slug} findings={findings} onJump={jumpTo} onFix={() => fix.mutate()} fixing={fix.isPending} disabled={!text.trim() || active || draftingIds.has(section?.id ?? "")} />
                  ) : (
                    <CitationsPanel slug={slug} text={text} focusKey={citeFocus} getSentence={getSentence} onCite={citeAt} onReplace={replaceRange} />
                  )}
                </TabsContent>
              </Tabs>
            </Card>
          </aside>
        </div>
      )}

      {studio.data.initialized ? <NextStepBar p={p} current="studio" /> : null}

      <Dialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <DialogContent title="Revise this section" description="The model keeps what you kept and applies your instructions. Your current text is the starting point.">
          <Textarea
            autoFocus
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. Shorten the second paragraph, make the contribution list three items, remove the claim about accuracy."
            className="min-h-[120px]"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setInstructionsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => requestDraft(instructions)} disabled={!instructions.trim()} loading={draft.isPending}>
              <Wand2 className="h-4 w-4" /> Revise
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmForce}
        onOpenChange={(o) => !o && setConfirmForce(null)}
        title={section?.status === "mine" ? "This section is marked as yours" : "Replace your edited text?"}
        description="The current text is kept as a version you can restore, but the editor will show the new draft."
        confirmLabel="Regenerate"
        onConfirm={() => {
          if (section && confirmForce) draft.mutate({ id: section.id, instructions: confirmForce.instructions, force: true });
          setConfirmForce(null);
        }}
        busy={draft.isPending}
      />

      {fixProposal ? (
        <FixDialog
          proposal={fixProposal}
          current={text}
          onAccept={acceptFix}
          onClose={() => {
            if (fixProposal.changed) track("fix_discarded", { slug, meta: { before: fixProposal.before_count, after: fixProposal.after.length } });
            setFixProposal(null);
          }}
          saving={save.isPending}
        />
      ) : null}

      {historyOpen && section ? (
        <HistoryDialog
          slug={slug}
          section={section}
          current={text}
          onRestore={(t) => {
            setText(t);
            toast("Loaded into the editor. Save to keep it.", { icon: <CircleDashed className="h-4 w-4" /> });
          }}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </div>
  );
}
