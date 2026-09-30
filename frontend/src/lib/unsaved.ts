import { useEffect, useId } from "react";

/**
 * Which editors on screen hold text that is not saved yet. Editors register here and the one
 * UnsavedGuard in the app shell asks before the user leaves, so no page needs its own blocker.
 */
const dirty = new Set<string>();

export function hasUnsaved(): boolean {
  return dirty.size > 0;
}

/** Marks the calling editor as holding unsaved text for as long as `isDirty` is true. */
export function useUnsaved(isDirty: boolean) {
  const id = useId();
  useEffect(() => {
    if (!isDirty) return;
    dirty.add(id);
    return () => {
      dirty.delete(id);
    };
  }, [id, isDirty]);
}
