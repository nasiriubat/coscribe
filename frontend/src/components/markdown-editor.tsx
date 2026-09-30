import { useEffect, useRef, useState } from "react";
import { Check, Eye, Loader2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { useUnsaved } from "@/lib/unsaved";

interface Props {
  value: string;
  onSave: (value: string) => Promise<void>;
  placeholder?: string;
  minHeight?: number;
  readOnly?: boolean;
  className?: string;
  emptyHint?: string;
}

/**
 * Plain textarea editor with explicit save, Cmd/Ctrl+S, dirty tracking and a preview
 * toggle. CodeMirror replaces the textarea in the Studio (phase 4); the surrounding
 * behaviour stays the same.
 */
export function MarkdownEditor({ value, onSave, placeholder, minHeight = 320, readOnly, className, emptyHint }: Props) {
  const [draft, setDraft] = useState(value);
  const [mode, setMode] = useState<"edit" | "preview">(value.trim() ? "preview" : "edit");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft((prev) => {
      // Content arriving from a background job (plan, outline) lands in preview, not raw Markdown.
      if (!prev.trim() && value.trim()) setMode("preview");
      return value;
    });
  }, [value]);

  const dirty = draft !== value;
  useUnsaved(dirty && !readOnly);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && document.activeElement === ref.current) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, value, saving]);

  return (
    <div className={cn("card-surface overflow-hidden", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant={mode === "edit" ? "secondary" : "ghost"} onClick={() => setMode("edit")} disabled={readOnly}>
            <PenLine className="h-3.5 w-3.5" /> Edit
          </Button>
          <Button size="sm" variant={mode === "preview" ? "secondary" : "ghost"} onClick={() => setMode("preview")}>
            <Eye className="h-3.5 w-3.5" /> Preview
          </Button>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {saving ? (
            <span className="inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving</span>
          ) : dirty ? (
            <span className="text-warning">Unsaved changes</span>
          ) : savedAt ? (
            <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" /> Saved</span>
          ) : null}
          {!readOnly ? (
            <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
              Save
            </Button>
          ) : null}
        </div>
      </div>
      {mode === "edit" ? (
        <textarea
          ref={ref}
          value={draft}
          readOnly={readOnly}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          spellCheck
          className="block w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-[1.7] text-foreground outline-none placeholder:text-subtle"
          style={{ minHeight }}
        />
      ) : draft.trim() ? (
        <div className="p-5" style={{ minHeight }}>
          <Markdown source={draft} />
        </div>
      ) : (
        <div className="flex items-center justify-center p-5 text-[13px] text-subtle" style={{ minHeight: Math.min(minHeight, 160) }}>
          {emptyHint ?? "Nothing here yet."}
        </div>
      )}
    </div>
  );
}
