import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ListTree, MessageSquareText, Pin, Send, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ChatMessage, InterviewQuestion, InterviewState, JobInfo, Project } from "@/lib/types";
import { useJobs } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { EmptyState, PageHeader, ProgressRing, SectionTitle, Skeleton } from "@/components/ui/misc";
import { JobProgress } from "@/components/papers";
import { Markdown } from "@/components/markdown";
import { NextStepBar } from "@/components/flow";
import { ProjectLoadError } from "@/components/load-error";

function QuestionCard({ q, slug, onSaved }: { q: InterviewQuestion; slug: string; onSaved: (s: InterviewState) => void }) {
  const [answer, setAnswer] = useState(q.answer);
  const [saving, setSaving] = useState(false);
  const dirty = answer !== q.answer;

  useEffect(() => setAnswer(q.answer), [q.answer]);

  const save = async (body: { answer?: string; status?: InterviewQuestion["status"] }) => {
    setSaving(true);
    try {
      const s = await api.put<InterviewState>(`/api/projects/${slug}/interview/answers`, { answers: [{ id: q.id, ...body }] });
      onSaved(s);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const na = q.status === "na";
  return (
    <Card className={cn("p-4", q.status === "answered" && "border-success/30", na && "opacity-70")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-[14px] font-semibold leading-snug">{q.question}</h4>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{q.why}</p>
        </div>
        {q.status === "answered" ? (
          <Badge variant="success" className="gap-1 shrink-0">
            <Check className="h-3 w-3" /> Answered
          </Badge>
        ) : na ? (
          <Badge className="shrink-0">Not applicable</Badge>
        ) : (
          <Badge variant="warning" className="shrink-0">Open</Badge>
        )}
      </div>

      {!na ? (
        <>
          {q.suggested && !/^no basis/i.test(q.suggested) ? (
            <div className="mt-3 rounded-[var(--radius-sm)] border border-dashed border-border-strong bg-muted/40 p-3">
              <div className="mb-1 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-subtle">
                Suggested from your spec
                <Badge variant={q.confidence === "high" ? "success" : q.confidence === "medium" ? "warning" : "outline"}>{q.confidence} confidence</Badge>
                <span className="normal-case tracking-normal text-subtle">· a guess, confirm before using</span>
              </div>
              <p className="text-[13px] leading-relaxed">{q.suggested}</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAnswer(q.suggested)} disabled={answer === q.suggested}>
                Use as starting point
              </Button>
            </div>
          ) : null}
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onBlur={() => dirty && void save({ answer })}
            placeholder="Your answer. A few sentences is enough. Numbers and names matter most."
            className="mt-3 min-h-[88px] text-[13.5px]"
          />
          <div className="mt-2 flex items-center justify-between">
            <button onClick={() => void save({ status: "na" })} className="text-[12.5px] text-subtle hover:text-foreground">
              Not applicable to this paper
            </button>
            <Button size="sm" onClick={() => void save({ answer })} disabled={!dirty} loading={saving}>
              Save answer
            </Button>
          </div>
        </>
      ) : (
        <button onClick={() => void save({ status: q.answer.trim() ? "answered" : "open" })} className="mt-2 text-[12.5px] text-primary hover:underline">
          Reopen
        </button>
      )}
    </Card>
  );
}

function ChatPanel({ slug, onPinned }: { slug: string; onPinned: () => void }) {
  const qc = useQueryClient();
  const chat = useQuery({ queryKey: ["chat", slug], queryFn: () => api.get<ChatMessage[]>(`/api/projects/${slug}/chat`) });
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (message: string) => api.post<{ message: ChatMessage; reply: ChatMessage }>(`/api/projects/${slug}/chat`, { message }),
    onMutate: (message) => {
      setText("");
      qc.setQueryData<ChatMessage[]>(["chat", slug], (old) => [...(old ?? []), { id: "tmp", role: "user", content: message, at: new Date().toISOString() }]);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["chat", slug] }),
    onError: (e: Error) => {
      toast.error(e.message);
      void qc.invalidateQueries({ queryKey: ["chat", slug] });
    },
  });
  const pin = useMutation({
    mutationFn: (t: string) => api.post(`/api/projects/${slug}/interview/pin`, { text: t }),
    onSuccess: () => {
      toast.success("Pinned to interview notes");
      onPinned();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const clear = useMutation({
    mutationFn: () => api.delete(`/api/projects/${slug}/chat`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["chat", slug] }),
    onError: (e: Error) => toast.error(e.message),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.data?.length, send.isPending]);

  return (
    <Card className="flex h-[70vh] min-h-[420px] flex-col overflow-hidden lg:sticky lg:top-8 lg:h-[calc(100vh-220px)]">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <MessageSquareText className="h-4 w-4 text-primary" /> Think out loud
        </div>
        {chat.data?.length ? (
          <button onClick={() => clear.mutate()} className="rounded p-1 text-subtle hover:bg-muted hover:text-foreground" aria-label="Clear chat">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {!chat.data?.length ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Unsure how to answer something, or wondering whether a claim holds? Ask here. When the reply contains something the paper needs, pin it and it lands in the interview notes.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {chat.data.map((m) => (
              <div key={m.id} className={cn("max-w-[92%] rounded-[var(--radius)] px-3.5 py-2.5 text-[13.5px] leading-relaxed", m.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted")}>
                {m.role === "assistant" ? <Markdown source={m.content} className="text-[13.5px]" /> : m.content}
                {m.pin ? (
                  <button
                    onClick={() => pin.mutate(m.pin!)}
                    className="mt-2 flex w-full items-start gap-2 rounded-md border border-primary/30 bg-primary-soft/60 px-2.5 py-2 text-left text-[12.5px] text-foreground hover:bg-primary-soft"
                  >
                    <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span>
                      <span className="font-medium text-primary">Pin to notes: </span>
                      {m.pin}
                    </span>
                  </button>
                ) : null}
              </div>
            ))}
            {send.isPending ? <div className="self-start rounded-[var(--radius)] bg-muted px-3.5 py-2.5 text-[13px] text-subtle">Thinking…</div> : null}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate(text.trim());
        }}
        className="flex items-end gap-2 border-t border-border p-3"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim()) send.mutate(text.trim());
            }
          }}
          placeholder="Ask or think aloud. Enter to send, Shift+Enter for a new line."
          className="min-h-[44px] max-h-40 text-[13.5px]"
          rows={1}
        />
        <Button type="submit" size="icon" disabled={!text.trim()} loading={send.isPending} aria-label="Send">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </Card>
  );
}

export function InterviewPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const interview = useQuery({ queryKey: ["interview", slug], queryFn: () => api.get<InterviewState>(`/api/projects/${slug}/interview`) });
  const { jobs, active, watch, dismiss } = useJobs({ project_id: project.data?.id }, (j) => {
    if (j.type === "interview_round") void qc.invalidateQueries({ queryKey: ["interview", slug] });
  });
  const next = useMutation({
    mutationFn: () => api.post<JobInfo>(`/api/projects/${slug}/interview/next`),
    onSuccess: (job) => watch(job),
    onError: (e: Error) => toast.error(e.message),
  });
  const onSaved = (s: InterviewState) => {
    qc.setQueryData(["interview", slug], s);
    void qc.invalidateQueries({ queryKey: ["project", slug] });
  };

  if (project.isLoading || interview.isLoading) return <Skeleton className="h-64" />;
  if (!project.data || !interview.data) return <ProjectLoadError query={project.data ? interview : project} />;
  const p = project.data;
  const st = interview.data;
  const all = st.rounds.flatMap((r) => r.questions);
  const answered = all.filter((q) => q.status !== "open").length;
  const pct = all.length ? Math.round((100 * answered) / all.length) : 0;
  const openCount = all.length - answered;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={
          st.done ? <Badge variant="success">Interview complete</Badge> : st.rounds.length ? <Badge variant="primary">Round {st.rounds.length}</Badge> : <Badge>Not started</Badge>
        }
        title="Interview"
        description="The model reads your spec and the pattern, then asks only what the paper still lacks. Answers become the facts the draft may use. Nothing else does."
        actions={
          <>
            {all.length ? (
              <div className="mr-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <ProgressRing value={pct} size={28} /> {answered} of {all.length} answered
              </div>
            ) : null}
            {!st.done ? (
              <Button onClick={() => next.mutate()} loading={next.isPending} disabled={active || !p.counts.has_spec}>
                <Sparkles className="h-4 w-4" /> {st.rounds.length ? "Next round" : "Start interview"}
              </Button>
            ) : (
              <Link to={`/projects/${slug}/outline`}><Button>
                <ListTree className="h-4 w-4" /> Go to outline
              </Button></Link>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <JobProgress jobs={jobs} onDismiss={dismiss} />
          {!p.counts.has_spec ? (
            <EmptyState
              icon={<Sparkles />}
              title="Describe the work first"
              description="The interview reads your description so it can skip what you already said."
              action={
                <Link to={`/projects/${slug}/spec`} className="text-[13px] font-medium text-primary hover:underline">
                  Go to that step
                </Link>
              }
            />
          ) : st.rounds.length === 0 ? (
            <EmptyState
              icon={<MessageSquareText />}
              title="No questions yet"
              description="Start the interview. The first round covers users and the problem for a tool paper, or scope and questions for a review."
              action={
                <Button onClick={() => next.mutate()} loading={next.isPending} disabled={active}>
                  <Sparkles className="h-4 w-4" /> Start interview
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-8">
              {[...st.rounds].reverse().map((r) => (
                <section key={r.index}>
                  <SectionTitle right={<span className="text-[12px] text-subtle">{r.questions.filter((q) => q.status !== "open").length} of {r.questions.length}</span>}>
                    Round {r.index}: {r.title}
                  </SectionTitle>
                  {r.rationale ? <p className="mb-3 -mt-1 text-[12.5px] text-muted-foreground">{r.rationale}</p> : null}
                  <div className="flex flex-col gap-3">
                    {r.questions.map((q) => (
                      <QuestionCard key={q.id} q={q} slug={slug} onSaved={onSaved} />
                    ))}
                  </div>
                </section>
              ))}
              {openCount === 0 && !st.done ? (
                <Card className="flex items-center justify-between gap-4 p-4">
                  <div className="text-[13px]">
                    <div className="font-semibold">All questions in this round are answered.</div>
                    <div className="text-muted-foreground">Ask for the next round, or go straight to the outline if you think the paper has what it needs.</div>
                  </div>
                  <div className="flex gap-2">
                    <Link to={`/projects/${slug}/outline`}>
                      <Button variant="secondary">
                        <ListTree className="h-4 w-4" /> Outline
                      </Button>
                    </Link>
                    <Button onClick={() => next.mutate()} loading={next.isPending} disabled={active}>
                      <Sparkles className="h-4 w-4" /> Next round
                    </Button>
                  </div>
                </Card>
              ) : null}
              {st.notes.length ? (
                <section>
                  <SectionTitle>Notes pinned from chat</SectionTitle>
                  <Card className="divide-y divide-border">
                    {st.notes.map((n) => (
                      <div key={n.id} className="flex items-start gap-2 px-4 py-2.5 text-[13px]">
                        <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">{n.text}</span>
                        <Badge variant="warning" className="shrink-0">
                          Unverified
                        </Badge>
                      </div>
                    ))}
                  </Card>
                  <p className="mt-2 text-[12px] text-muted-foreground">Your thinking, not evidence. The outline turns claims that rest on a note into [CITE] or [NEEDS] placeholders.</p>
                </section>
              ) : null}
            </div>
          )}
        </div>
        <div>
          <ChatPanel slug={slug} onPinned={() => void qc.invalidateQueries({ queryKey: ["interview", slug] })} />
        </div>
      </div>
      <NextStepBar p={p} current="interview" />
    </div>
  );
}
