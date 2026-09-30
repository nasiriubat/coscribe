import { useSyncExternalStore } from "react";
import type { StepKey } from "./flow";

/**
 * Steps the author chose to skip, per project. A convenience of this browser only: a skip
 * moves "Next up" along, it never locks or deletes anything, so losing it costs one click.
 */
const cache = new Map<string, StepKey[]>();
const listeners = new Set<() => void>();
const storageKey = (slug: string) => `pw.skipped.${slug}`;

export function skippedSteps(slug: string): StepKey[] {
  const hit = cache.get(slug);
  if (hit) return hit;
  let steps: StepKey[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(slug)) ?? "[]");
    if (Array.isArray(raw)) steps = raw as StepKey[];
  } catch {
    /* no storage or a damaged entry: nothing is skipped */
  }
  cache.set(slug, steps);
  return steps;
}

export function setSkipped(slug: string, step: StepKey, skipped: boolean) {
  const next = skippedSteps(slug).filter((s) => s !== step);
  if (skipped) next.push(step);
  cache.set(slug, next);
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(next));
  } catch {
    /* fine without storage: the skip lasts until the page is reloaded */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders the caller when this project's skips change. flow.ts reads them through skippedSteps. */
export function useSkipped(slug: string): StepKey[] {
  return useSyncExternalStore(subscribe, () => skippedSteps(slug));
}
