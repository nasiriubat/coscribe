import { Link } from "react-router-dom";
import { ArrowRight, Check, Circle, Lock } from "lucide-react";
import type { Project } from "@/lib/types";
import { type StepKey, isEarlier, isOptional, isSkipped, nextStep, skipCost, stepAfter, stepStates, titleFor } from "@/lib/flow";
import { setSkipped, useSkipped } from "@/lib/skips";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Hero card on the project home: exactly one thing to do next. */
export function NextUp({ p }: { p: Project }) {
  useSkipped(p.slug);
  const next = nextStep(p);
  if (!next) {
    return (
      <Card className="flex items-center gap-4 border-success/30 bg-success-soft/40 p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success text-white">
          <Check className="h-5 w-5" />
        </span>
        <div>
          <div className="text-[15px] font-semibold">Nothing is waiting on you</div>
          <div className="text-[13px] text-muted-foreground">Keep editing in the Studio. After larger changes, run Review again and export a fresh copy.</div>
        </div>
      </Card>
    );
  }
  const cost = skipCost(next, p);
  return (
    <Card className="border-primary/30 bg-primary-soft/40 p-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-primary">Next up</div>
          <div className="text-[16px] font-semibold leading-tight">{titleFor(next, p)}</div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">{next.summary(p)}</div>
        </div>
        <Link to={next.to(p.slug)}>
          <Button size="lg">
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>
      {cost ? (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 border-t border-primary/15 pt-3 text-[12.5px] text-muted-foreground">
          <button onClick={() => setSkipped(p.slug, next.key, true)} className="font-medium text-primary hover:underline">
            Skip for now
          </button>
          <span>{cost}</span>
        </div>
      ) : null}
    </Card>
  );
}

/** Ordered list of stages with one status each. */
export function Stepper({ p }: { p: Project }) {
  useSkipped(p.slug);
  const rows = stepStates(p);
  return (
    <Card className="divide-y divide-border overflow-hidden">
      {rows.map(({ step, state }, i) => {
        const clickable = state !== "soon" && state !== "locked";
        const inner = (
          <div className={cn("flex items-center gap-4 px-4 py-3.5", clickable && "transition-colors hover:bg-muted/60", state === "current" && "bg-primary-soft/30")}>
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold",
                state === "done" && "border-success bg-success text-white",
                state === "current" && "border-primary bg-primary text-primary-foreground",
                (state === "todo" || state === "optional") && "border-border-strong text-muted-foreground",
                (state === "locked" || state === "soon") && "border-border text-subtle",
              )}
            >
              {state === "done" ? <Check className="h-3.5 w-3.5" /> : state === "locked" || state === "soon" ? <Lock className="h-3 w-3" /> : state === "optional" ? <Circle className="h-3 w-3" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn("text-[14px] font-medium", (state === "locked" || state === "soon") && "text-muted-foreground")}>{titleFor(step, p)}</span>
                {isSkipped(step, p) && state === "optional" ? <Badge variant="outline">Skipped</Badge> : isOptional(step, p) ? <Badge variant="outline">Optional</Badge> : null}
                {state === "current" ? <Badge variant="primary">Next</Badge> : null}
                {state === "soon" ? <Badge variant="outline">Phase {step.soonPhase}</Badge> : null}
              </div>
              <div className="text-[12.5px] text-muted-foreground">{step.summary(p)}</div>
            </div>
            {clickable ? <ArrowRight className="h-4 w-4 text-subtle" /> : null}
          </div>
        );
        return clickable ? (
          <Link key={step.key} to={step.to(p.slug)} className="block">
            {inner}
          </Link>
        ) : (
          <div key={step.key}>{inner}</div>
        );
      })}
    </Card>
  );
}

/** Footer on every stage page: where to go when done here. */
export function NextStepBar({ p, current }: { p: Project; current: StepKey }) {
  useSkipped(p.slug);
  const after = stepAfter(p, current);
  if (!after) return null;
  const isNext = nextStep(p)?.key === after.key;
  const earlier = isEarlier(p, after.key, current);
  return (
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3">
      <div className="text-[13px]">
        <span className="text-muted-foreground">{earlier ? "Still open from earlier: " : isNext ? "When you are done here, the next step is " : "You can also continue with "}</span>
        <span className="font-semibold">{titleFor(after, p)}</span>
        <span className="text-muted-foreground">. {after.summary(p)}</span>
      </div>
      <Link to={after.to(p.slug)}>
        <Button variant={isNext ? "primary" : "secondary"} size="sm">
          {titleFor(after, p)} <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </Link>
    </div>
  );
}
