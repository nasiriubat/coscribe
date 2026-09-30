import type { Project } from "./types";
import { skippedSteps } from "./skips";

/**
 * One place that decides what a project needs next. Every screen that shows guidance
 * reads from here, so the user is never told two different things.
 */

export type StepKey = "spec" | "design" | "sources" | "playbook" | "interview" | "outline" | "studio" | "references" | "figures" | "review" | "export";
export type StepState = "done" | "current" | "todo" | "locked" | "optional" | "soon";

export interface Step {
  key: StepKey;
  title: string;
  to: (slug: string) => string;
  optional?: boolean;
  soonPhase?: number;
  state: (p: Project) => StepState;
  summary: (p: Project) => string;
}

const approvedStages = ["outline", "drafting", "review", "export"];

export const STEPS: Step[] = [
  {
    key: "spec",
    title: "Describe what you built",
    to: (s) => `/projects/${s}/spec`,
    state: (p) => (p.counts.has_spec ? "done" : "current"),
    summary: (p) =>
      p.counts.has_spec
        ? "Specification saved."
        : p.entry === "idea"
          ? "Turn the plan into a specification of what you will build or study."
          : p.entry === "draft"
            ? "Say what the paper is about in your own words. The interview and the reviewer read it."
            : "Paste or write the system specification. Everything else reads it.",
  },
  {
    key: "design",
    title: "Research design",
    to: (s) => `/projects/${s}/design`,
    optional: true,
    state: (p) => (p.counts.has_plan ? "done" : p.entry === "idea" ? "current" : "optional"),
    summary: (p) =>
      p.counts.has_plan ? "Research plan written." : p.entry === "idea" ? "Refine the idea or explore the space, then get a study plan you can edit." : "Optional. Turn an idea into a study reviewers would accept.",
  },
  {
    key: "sources",
    title: "Sources",
    to: (s) => `/projects/${s}/sources`,
    state: (p) => (p.counts.exemplars > 0 ? "done" : p.entry === "draft" ? "optional" : "todo"),
    summary: (p) =>
      p.counts.exemplars
        ? `${p.counts.exemplars} example paper${p.counts.exemplars === 1 ? "" : "s"} ingested${p.counts.readings ? `, ${p.counts.readings} paper${p.counts.readings === 1 ? "" : "s"} read in full` : ""}.`
        : p.entry === "draft"
          ? "Optional for a draft you already wrote; example papers still sharpen the reviewer pass."
          : "Paste five to ten papers of this type, or let the literature scan suggest them.",
  },
  {
    key: "playbook",
    title: "Learn the pattern",
    to: (s) => `/projects/${s}/playbook`,
    state: (p) => (p.counts.playbook_files > 0 ? "done" : p.counts.exemplars > 0 ? "todo" : "locked"),
    summary: (p) => (p.counts.playbook_files ? `${p.counts.playbook_files} of 5 pattern files learned.` : p.counts.exemplars ? "Learn how these papers are built." : "Needs example papers first."),
  },
  {
    key: "interview",
    title: "Interview",
    to: (s) => `/projects/${s}/interview`,
    state: (p) =>
      p.counts.interview_rounds.done || (p.counts.interview_rounds.rounds > 0 && p.counts.interview_rounds.open === 0)
        ? "done"
        : p.entry === "draft" && p.counts.interview_rounds.rounds === 0
          ? "optional"
          : p.counts.has_spec
            ? "todo"
            : "locked",
    summary: (p) => {
      const ir = p.counts.interview_rounds;
      if (ir.done) return `Complete: ${ir.answered} answers over ${ir.rounds} rounds.`;
      if (ir.rounds) return `${ir.answered} answered, ${ir.open} open, ${ir.rounds} round${ir.rounds === 1 ? "" : "s"}.`;
      if (p.entry === "draft") return "Optional for a draft you already wrote. Useful when the reviewer says a section lacks substance.";
      return "The model asks only what the paper still lacks.";
    },
  },
  {
    key: "outline",
    title: "Outline",
    to: (s) => `/projects/${s}/outline`,
    state: (p) =>
      approvedStages.includes(p.stage) ? "done" : !p.counts.has_spec ? "locked" : p.entry === "draft" && !p.counts.has_outline ? "optional" : "todo",
    summary: (p) =>
      approvedStages.includes(p.stage)
        ? "Approved."
        : p.counts.has_outline
          ? "Draft outline written. Approve it to unlock drafting."
          : p.entry === "draft"
            ? "Optional for a draft you already wrote. Your pasted sections become the outline."
            : "One line per paragraph. You approve it before drafting.",
  },
  {
    key: "studio",
    title: "Draft in the Studio",
    to: (s) => `/projects/${s}/studio`,
    state: (p) =>
      p.counts.sections > 0 && p.counts.sections_drafted === p.counts.sections
        ? "done"
        : approvedStages.includes(p.stage) || p.entry === "draft"
          ? "todo"
          : "locked",
    summary: (p) =>
      p.counts.sections
        ? `${p.counts.sections_drafted} of ${p.counts.sections} sections drafted${p.counts.checklist_open ? `, ${p.counts.checklist_open} open item${p.counts.checklist_open === 1 ? "" : "s"}` : ""}.`
        : approvedStages.includes(p.stage)
          ? "Section by section, from the approved outline."
          : p.entry === "draft"
            ? "Paste your draft. Every heading becomes a section marked as yours."
            : "Needs an approved outline.",
  },
  {
    key: "references",
    title: "References",
    to: (s) => `/projects/${s}/references`,
    state: (p) =>
      p.counts.references > 0 && p.counts.cite_requests === 0 ? "done" : p.counts.sections > 0 ? "todo" : p.counts.has_spec ? "optional" : "locked",
    summary: (p) =>
      p.counts.cite_requests
        ? `${p.counts.references} verified, ${p.counts.cite_requests} claim${p.counts.cite_requests === 1 ? "" : "s"} still need a source.`
        : p.counts.references
          ? `${p.counts.references} verified reference${p.counts.references === 1 ? "" : "s"}.`
          : "Search three indexes, import a .bib, or add by hand. Drafts cite only these.",
  },
  {
    key: "figures",
    title: "Figures",
    to: (s) => `/projects/${s}/figures`,
    optional: true,
    state: (p) => (p.counts.figures > 0 ? "done" : p.counts.has_spec ? "optional" : "locked"),
    summary: (p) => (p.counts.figures ? `${p.counts.figures} figure${p.counts.figures === 1 ? "" : "s"}.` : "Optional. Architecture diagrams from Mermaid; results and screenshots uploaded."),
  },
  {
    key: "review",
    title: "Review",
    to: (s) => `/projects/${s}/review`,
    state: (p) => (p.counts.reviewed ? "done" : p.counts.sections_drafted > 0 ? "todo" : "locked"),
    summary: (p) => (p.counts.reviewed ? "Reviewed. Major findings are on the checklist." : p.counts.sections_drafted ? "A reviewer pass over the draft, plus venue suggestions." : "Needs at least one drafted section."),
  },
  {
    key: "export",
    title: "Export",
    to: (s) => `/projects/${s}/export`,
    state: (p) => (p.counts.exports > 0 ? "done" : p.counts.sections_drafted > 0 ? "todo" : "locked"),
    summary: (p) => (p.counts.exports ? `${p.counts.exports} export${p.counts.exports === 1 ? "" : "s"} so far.` : p.counts.sections_drafted ? "LNCS, ACM or your own template. PDF, LaTeX zip and DOCX." : "Needs at least one drafted section."),
  },
];

/** Steps in the order this project walks them. Idea-first projects design the study before
 *  describing it; draft-first projects get the reviewer pass right after the Studio. */
export function orderedSteps(p: Project): Step[] {
  if (p.entry === "idea") {
    const design = STEPS.find((s) => s.key === "design")!;
    return [design, ...STEPS.filter((s) => s.key !== "design")];
  }
  if (p.entry === "draft") {
    const review = STEPS.find((s) => s.key === "review")!;
    const rest = STEPS.filter((s) => s.key !== "review");
    const i = rest.findIndex((s) => s.key === "studio");
    return [...rest.slice(0, i + 1), review, ...rest.slice(i + 1)];
  }
  return STEPS;
}

/** Steps the guided path recommends but a paper can do without. The author may skip them. */
const SKIPPABLE: StepKey[] = ["sources", "playbook", "interview"];

/** What skipping a step costs, in one line, shown beside the Skip button. */
const SKIP_COST: Partial<Record<StepKey, string>> = {
  sources: "Without example papers there is no learned pattern; drafts follow the paper type's defaults.",
  playbook: "Without a learned pattern, drafts follow the paper type's defaults.",
  interview: "Without the interview the outline has more [NEEDS] gaps for you to fill.",
};

export function isSkipped(step: Step, p: Project): boolean {
  return SKIPPABLE.includes(step.key) && skippedSteps(p.slug).includes(step.key);
}

/** The skip cost line when this step is still waiting and may be skipped, otherwise null. */
export function skipCost(step: Step, p: Project): string | null {
  const raw = step.state(p);
  return SKIPPABLE.includes(step.key) && (raw === "todo" || raw === "current") ? (SKIP_COST[step.key] ?? null) : null;
}

/** A step's state for this project, with the author's skips applied. */
function stateOf(step: Step, p: Project): StepState {
  const raw = step.state(p);
  return (raw === "todo" || raw === "current") && isSkipped(step, p) ? "optional" : raw;
}

/** Step title as this project should read it. */
export function titleFor(step: Step, p: Project): string {
  if (step.key === "spec" && p.entry !== "built") return "Describe the work";
  return step.title;
}

/** Title of a step by key: pages use it as their heading so a step has one name everywhere. */
export function stepTitle(key: StepKey, p: Project): string {
  return titleFor(STEPS.find((s) => s.key === key)!, p);
}

/** Whether a step is optional for this project. */
export function isOptional(step: Step, p: Project): boolean {
  if (step.key === "design") return p.entry !== "idea";
  if (step.key === "sources") return p.entry === "draft";
  return !!step.optional;
}

/** The single step the user should do next. */
export function nextStep(p: Project): Step | null {
  for (const s of orderedSteps(p)) {
    const st = stateOf(s, p);
    if (st === "current" || st === "todo") return s;
  }
  return null;
}

/** Steps for the stepper, with exactly one "current" resolved. */
export function stepStates(p: Project): Array<{ step: Step; state: StepState }> {
  const next = nextStep(p);
  return orderedSteps(p).map((step) => {
    let state = stateOf(step, p);
    if (next && step.key === next.key) state = "current";
    else if (state === "current") state = "todo";
    return { step, state };
  });
}

/** What comes after a given step, for the footer bar on stage pages. */
export function stepAfter(p: Project, key: StepKey): Step | null {
  const steps = orderedSteps(p);
  const idx = steps.findIndex((s) => s.key === key);
  const next = nextStep(p);
  if (next && next.key !== key) return next;
  for (const s of steps.slice(idx + 1)) {
    const st = stateOf(s, p);
    if (st !== "soon" && st !== "done" && st !== "locked") return s;
  }
  return null;
}

/** True when `other` comes before `key` in this project's order: the footer then says "still open earlier". */
export function isEarlier(p: Project, other: StepKey, key: StepKey): boolean {
  const keys = orderedSteps(p).map((s) => s.key);
  return keys.indexOf(other) < keys.indexOf(key);
}
