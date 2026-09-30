import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { hasUnsaved } from "@/lib/unsaved";
import { ConfirmDialog } from "@/components/dialogs";

/** Asks before unsaved text is lost: on in-app navigation with a dialog, on reload or tab close with the browser's prompt. */
export function UnsavedGuard() {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsaved() && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsaved()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(o) => {
        if (!o) blocker.reset?.();
      }}
      title="Leave without saving?"
      description="This page has changes you have not saved. If you leave now they are lost."
      cancelLabel="Stay"
      confirmLabel="Discard and leave"
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
