import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { BookOpen, Check, ChevronDown, ChevronRight, Quote, Search, ShieldCheck, Wand2 } from "lucide-react";
import { api } from "@/lib/api";
import { diffWords } from "@/lib/diff";
import type { RefCandidate, RefRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * The Citations tab of the Studio. Two jobs, each a short sequence of steps:
 *  - for every [@key] in the section: what the paper says, the passage that matches, a verdict on demand;
 *  - for a sentence the author selects: their own references first, then the indexes, then a rewrite.
 * Called from studio.tsx, which owns the editor and hands over selection and insertion helpers.
 */

export interface CitationRow {
  key: string;
  sentence: string;
  line: number;
}

interface Evidence {
  key: string;
  record: { title: string; authors: string[]; year: number | null; venue: string | null; url: string | null; source: string };
  what_it_says: string;
  has_card: boolean;
  full_text: boolean;
  passages: Array<{ section: string; text: string; matched: string[]; coverage: number }>;
  source: "full_text" | "card" | "abstract";
  hint: string | null;
}

interface Verdict {
  verdict: "supported" | "partly_supported" | "not_supported";
  reason: string;
}

interface FindResult {
  own: Array<{ key: string; title: string; year: number | null; has_card: boolean; what_it_says: string; matched: string[]; score: number }>;
  query: string;
  claim: string;
  candidates: RefCandidate[];
  errors: string[];
}

interface Rewrite {
  sentence: string;
  used_keys: string[];
  note: string;
}

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z\[“"(])/;

/** Every [@key] in the text with the sentence that carries it. */
export function citationRows(text: string): CitationRow[] {
  const rows: CitationRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    for (const sentence of line.split(SENTENCE_END)) {
      const keys = new Set((sentence.match(/@([^\]\s;]+)/g) ?? []).map((k) => k.slice(1)));
      for (const key of keys) rows.push({ key, sentence: sentence.trim(), line: i + 1 });
    }
  });
  return rows;
}

const VERDICT: Record<Verdict["verdict"], { label: string; variant: "success" | "warning" | "destructive" }> = {
  supported: { label: "Supported", variant: "success" },
  partly_supported: { label: "Partly supported", variant: "warning" },
  not_supported: { label: "Not supported", variant: "destructive" },
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{title}</div>
        <div className="mt-1 text-[13px] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function EvidenceCard({ slug, row }: { slug: string; row: CitationRow }) {
  const ev = useQuery({
    queryKey: ["evidence", slug, row.key, row.sentence],
    queryFn: () => api.post<Evidence>(`/api/projects/${slug}/references/${row.key}/evidence`, { sentence: row.sentence }),
  });
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const check = useMutation({
    mutationFn: () => api.post<Verdict>(`/api/projects/${slug}/references/${row.key}/check`, { sentence: row.sentence, passage: ev.data?.passages[0]?.text ?? "" }),
    onSuccess: setVerdict,
    onError: (e: Error) => toast.error(e.message),
  });
  if (ev.isLoading) return <p className="px-2 py-3 text-[12.5px] text-subtle">Looking up the reference…</p>;
  if (ev.isError || !ev.data) return <p className="px-2 py-3 text-[12.5px] text-destructive">{(ev.error as Error)?.message ?? "Reference not found"}</p>;
  const d = ev.data;
  const r = d.record;
  return (
    <div className="flex flex-col gap-4 border-t border-border px-2 py-3">
      <div className="text-[13px]">
        <div className="font-medium leading-snug">{r.title}</div>
        <div className="text-[12px] text-muted-foreground">
          {r.authors?.slice(0, 3).join(", ")}
          {r.authors?.length > 3 ? " et al." : ""}
          {r.year ? ` · ${r.year}` : ""}
          {r.url ? (
            <>
              {" · "}
              <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                open
              </a>
            </>
          ) : null}
        </div>
      </div>
      <Step n={1} title={d.has_card ? "What the paper says (reading card)" : "What the paper says (abstract)"}>
        {d.what_it_says ? <p className="whitespace-pre-line text-muted-foreground">{d.what_it_says}</p> : <p className="text-subtle">Nothing on record beyond the title.</p>}
      </Step>
      <Step n={2} title="Passage in the paper">
        {d.passages.length ? (
          <div className="flex flex-col gap-2">
            {d.passages.map((p, i) => (
              <blockquote key={i} className={cn("rounded-[var(--radius-sm)] border-l-2 bg-muted/40 px-3 py-2", i === 0 ? "border-primary" : "border-border")}>
                {p.section ? <div className="mb-1 text-[11.5px] font-medium text-subtle">{p.section}</div> : null}
                <p className="text-[12.5px] leading-relaxed">{p.text}</p>
                <div className="mt-1 text-[11px] text-subtle">shares: {p.matched.join(", ")}</div>
              </blockquote>
            ))}
          </div>
        ) : d.full_text ? (
          <p className="text-warning">The full text is on disk, but no paragraph shares words with this sentence. Read the paper before keeping the citation.</p>
        ) : (
          <p className="text-muted-foreground">
            {d.hint}{" "}
            <Link to={`/projects/${slug}/sources`} className="text-primary hover:underline">
              Open Sources
            </Link>
          </p>
        )}
      </Step>
      <Step n={3} title="Does it support the sentence?">
        {verdict ? (
          <div>
            <Badge variant={VERDICT[verdict.verdict].variant}>{VERDICT[verdict.verdict].label}</Badge>
            <p className="mt-1 text-muted-foreground">{verdict.reason}</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => check.mutate()} loading={check.isPending}>
              <ShieldCheck className="h-3.5 w-3.5" /> Check
            </Button>
            <span className="text-[12px] text-subtle">A quick check by the model.</span>
          </div>
        )}
      </Step>
    </div>
  );
}

function FindSource({
  slug,
  sentence,
  onCite,
  onReplace,
  onClose,
}: {
  slug: string;
  sentence: string;
  onCite: (key: string) => void;
  onReplace: (newSentence: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const find = useQuery({
    queryKey: ["find-source", slug, sentence],
    queryFn: () => api.post<FindResult>(`/api/projects/${slug}/references/find`, { sentence }),
  });
  const accept = useMutation({
    mutationFn: (c: RefCandidate) => api.post<RefRecord>(`/api/projects/${slug}/references`, { candidate: c }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["references", slug] });
      onCite(r.key);
      toast.success(`Added and cited as [@${r.key}]`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [proposal, setProposal] = useState<Rewrite | null>(null);
  const rewrite = useMutation({
    mutationFn: () => api.post<Rewrite>(`/api/projects/${slug}/references/rewrite`, { sentence }),
    onSuccess: setProposal,
    onError: (e: Error) => toast.error(e.message),
  });
  const diff = useMemo(() => (proposal ? diffWords(sentence, proposal.sentence) : []), [proposal, sentence]);
  const d = find.data;

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-sm)] border border-primary/40 bg-primary-soft/20 p-3">
      <div>
        <div className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Finding a source for</div>
        <p className="mt-1 text-[13px] italic leading-relaxed">“{sentence}”</p>
      </div>
      {find.isLoading ? <p className="text-[12.5px] text-subtle">Reading your references and writing a search query…</p> : null}
      {find.isError ? <p className="text-[12.5px] text-destructive">{(find.error as Error).message}</p> : null}
      {d ? (
        <>
          <Step n={1} title="In your references">
            {d.own.length ? (
              <div className="flex flex-col gap-1.5">
                {d.own.map((o) => (
                  <div key={o.key} className="flex items-start gap-2 rounded-md bg-card px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium leading-snug">{o.title}</div>
                      <div className="text-[12px] text-muted-foreground">
                        @{o.key}
                        {o.year ? ` · ${o.year}` : ""}
                        {o.has_card ? " · read in full" : ""} · shares {o.matched.slice(0, 5).join(", ")}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => onCite(o.key)}>
                      <Quote className="h-3.5 w-3.5" /> Cite
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">None of your references talks about this.</p>
            )}
          </Step>
          <Step n={2} title="From the indexes">
            <p className="mb-1.5 text-[12px] text-subtle">
              Searched for <span className="font-mono text-foreground">{d.query}</span>
              {d.errors.length ? ` · ${d.errors.length} index unavailable` : ""}
            </p>
            {d.candidates.length ? (
              <div className="flex flex-col gap-1.5">
                {d.candidates.slice(0, 5).map((c) => (
                  <div key={c.title} className="flex items-start gap-2 rounded-md bg-card px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium leading-snug">{c.title}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {c.authors.slice(0, 2).join(", ")}
                        {c.year ? ` · ${c.year}` : ""}
                        {c.citation_count != null ? ` · ${c.citation_count} citations` : ""}
                      </div>
                      {c.abstract ? <p className="mt-1 line-clamp-3 text-[12px] text-muted-foreground">{c.abstract}</p> : null}
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => accept.mutate(c)} loading={accept.isPending && accept.variables?.title === c.title}>
                      <Quote className="h-3.5 w-3.5" /> Add and cite
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">Nothing found. Try the References page with a different query, or continue below.</p>
            )}
          </Step>
          <Step n={3} title="Nothing fits?">
            {proposal ? (
              <div className="flex flex-col gap-2">
                <div className="rounded-[var(--radius-sm)] bg-card px-3 py-2 text-[13px] leading-relaxed">
                  {diff.map((x, i) => (
                    <span key={i} className={cn(x.type === "add" && "rounded-sm bg-success-soft text-success", x.type === "del" && "rounded-sm bg-destructive-soft text-destructive line-through")}>
                      {x.text}
                    </span>
                  ))}
                </div>
                {proposal.note ? <p className="text-[12px] text-muted-foreground">{proposal.note}</p> : null}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => onReplace(proposal.sentence)}>
                    <Check className="h-3.5 w-3.5" /> Use this
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
                    Discard
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => rewrite.mutate()} loading={rewrite.isPending}>
                  <Wand2 className="h-3.5 w-3.5" /> Rewrite to what my sources support
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onReplace(`${sentence.replace(/[.!?]\s*$/, "")} [CITE: ${(d.claim || sentence).slice(0, 90).replace(/[.!?]\s*$/, "")}].`)}>
                  Mark as needing a source
                </Button>
              </div>
            )}
          </Step>
        </>
      ) : null}
      <button onClick={onClose} className="self-start text-[12px] text-subtle hover:text-foreground">
        Close
      </button>
    </div>
  );
}

export function CitationsPanel({
  slug,
  text,
  focusKey,
  getSentence,
  onCite,
  onReplace,
}: {
  slug: string;
  text: string;
  /** A key clicked in the preview: the panel opens that row. */
  focusKey: string | null;
  /** The selected text, or the sentence at the caret, with its position in the document. */
  getSentence: () => { text: string; from: number; to: number } | null;
  onCite: (key: string, at: number) => void;
  onReplace: (from: number, to: number, text: string) => void;
}) {
  const rows = useMemo(() => citationRows(text), [text]);
  const [open, setOpen] = useState<string | null>(null);
  const [finding, setFinding] = useState<{ text: string; from: number; to: number } | null>(null);
  useEffect(() => {
    if (focusKey) {
      const row = rows.find((r) => r.key === focusKey);
      if (row) setOpen(`${row.key}:${row.line}`);
    }
  }, [focusKey, rows]);

  const startFind = () => {
    const sel = getSentence();
    if (!sel || sel.text.trim().length < 8) {
      toast("Place the cursor in a sentence, or select one, then press Find a source.");
      return;
    }
    setFinding(sel);
  };

  return (
    <div className="flex flex-col gap-3">
      {finding ? (
        <FindSource
          slug={slug}
          sentence={finding.text}
          onCite={(key) => {
            onCite(key, finding.to);
            setFinding(null);
          }}
          onReplace={(s) => {
            onReplace(finding.from, finding.to, s);
            setFinding(null);
          }}
          onClose={() => setFinding(null)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border bg-muted/40 p-2.5">
          <div className="text-[12.5px] text-muted-foreground">
            A sentence needs a source? Put the cursor in it.
            <span className="block text-[11.5px] text-subtle">Your references are searched first, then the indexes.</span>
          </div>
          <Button size="sm" onClick={startFind}>
            <Search className="h-3.5 w-3.5" /> Find a source
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-[13px] text-subtle">No citations in this section yet. Every [@key] will be listed here with the sentence it supports, so you can check it against the paper.</p>
      ) : (
        <div className="flex flex-col">
          <div className="mb-1 text-[12px] text-muted-foreground">
            {rows.length} citation{rows.length === 1 ? "" : "s"}. Open one to see what the paper says and where.
          </div>
          {rows.map((r) => {
            const id = `${r.key}:${r.line}`;
            const isOpen = open === id;
            return (
              <div key={id} className={cn("rounded-md", isOpen && "bg-muted/30")}>
                <button onClick={() => setOpen(isOpen ? null : id)} className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-muted/50">
                  {isOpen ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />}
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-[11.5px] text-success">@{r.key}</span>
                    <span className="ml-1.5 text-[11px] text-subtle">line {r.line}</span>
                    <span className="block truncate text-[12.5px] text-foreground">{r.sentence}</span>
                  </span>
                </button>
                {isOpen ? <EvidenceCard slug={slug} row={r} /> : null}
              </div>
            );
          })}
        </div>
      )}
      <p className="flex items-start gap-1.5 text-[11.5px] text-subtle">
        <BookOpen className="mt-0.5 h-3 w-3 shrink-0" /> Passages come from papers you added under Background reading or as example papers. Abstract-only references show the abstract.
      </p>
    </div>
  );
}
