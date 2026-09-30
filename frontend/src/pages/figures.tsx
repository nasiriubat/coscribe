import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import mermaid from "mermaid";
import { Check, ChevronLeft, Copy, Image as ImageIcon, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import type { Figure, Project } from "@/lib/types";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader, SectionTitle, Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/dialogs";
import { NextStepBar } from "@/components/flow";
import { ResultsTables } from "@/components/results-tables";
import { ProjectLoadError } from "@/components/load-error";

function ensureMermaid(dark: boolean) {
  // htmlLabels off: plain SVG text rasterises to PNG; foreignObject labels taint the canvas.
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "neutral",
    securityLevel: "strict",
    fontFamily: "Inter Variable, sans-serif",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });
}

async function renderMermaid(id: string, source: string): Promise<string> {
  const { svg } = await mermaid.render(id, source);
  return svg;
}

async function svgToPng(svg: string, scale = 4): Promise<Blob> {
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Could not rasterise the SVG"));
      img.src = blobUrl;
    });
    const w = Math.max(1, Math.round((img.naturalWidth || 1200) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 400) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function MermaidPreview({ source, onSvg }: { source: string; onSvg?: (svg: string | null, error: string | null) => void }) {
  const { resolved } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`m${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!source.trim()) {
        setSvg(null);
        setError(null);
        onSvg?.(null, null);
        return;
      }
      try {
        ensureMermaid(resolved === "dark");
        const out = await renderMermaid(idRef.current + Date.now().toString(36), source);
        if (cancelled) return;
        setSvg(out);
        setError(null);
        onSvg?.(out, null);
      } catch (e) {
        if (cancelled) return;
        const msg = (e as Error).message?.split("\n")[0] ?? "Render error";
        setSvg(null);
        setError(msg);
        onSvg?.(null, msg);
      }
    };
    const t = window.setTimeout(run, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, resolved]);

  if (error) return <div className="rounded-[var(--radius-sm)] border border-destructive/30 bg-destructive-soft/40 p-3 font-mono text-[12px] text-destructive">{error}</div>;
  if (!svg) return <div className="flex h-40 items-center justify-center text-[13px] text-subtle">Diagram preview</div>;
  return <div className="overflow-auto rounded-[var(--radius-sm)] bg-white p-3 [&>svg]:mx-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function FigureEditor({ slug, fig, onClose }: { slug: string; fig: Figure; onClose: () => void }) {
  const qc = useQueryClient();
  const [caption, setCaption] = useState(fig.caption);
  const [source, setSource] = useState(fig.source ?? "");
  const [svg, setSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = caption !== fig.caption || source !== (fig.source ?? "");

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/projects/${slug}/figures/${fig.name}`, { caption, source: fig.kind === "mermaid" ? source : undefined });
      if (fig.kind === "mermaid" && svg) {
        const fd = new FormData();
        fd.append("svg", new Blob([svg], { type: "image/svg+xml" }), `${fig.name}.svg`);
        let pngFailed: string | null = null;
        try {
          fd.append("png", await svgToPng(svg), `${fig.name}.png`);
        } catch (e) {
          pngFailed = (e as Error).message;
        }
        const t = document.cookie.match(/(?:^|;\s*)pw_csrf=([^;]+)/)?.[1] ?? "";
        const res = await fetch(`/api/projects/${slug}/figures/${fig.name}/render`, { method: "POST", body: fd, headers: { "x-csrf-token": decodeURIComponent(t) } });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "Could not store the rendered figure");
        if (pngFailed) toast.warning(`SVG saved, but the PNG for LaTeX failed: ${pngFailed}`);
      }
      await qc.invalidateQueries({ queryKey: ["figures", slug] });
      toast.success("Figure saved and rendered");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onSvg = useCallback((s: string | null, err: string | null) => {
    setSvg(s);
    setRenderError(err);
  }, []);

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold">{fig.name}</h3>
        <Badge variant="outline">{fig.kind === "mermaid" ? "Mermaid" : "Image"}</Badge>
        {fig.png_file ? <Badge variant="success">Rendered</Badge> : <Badge variant="warning">Not rendered</Badge>}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={(fig.kind === "mermaid" && (!!renderError || !svg)) || (!dirty && !!fig.png_file)}>
            <Check className="h-3.5 w-3.5" /> Save and render
          </Button>
        </div>
      </div>
      <Field label="Caption" hint="Shown under the figure. Say what the reader should see, not what the figure is." className="mb-3">
        <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
      </Field>
      {fig.kind === "mermaid" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Textarea value={source} onChange={(e) => setSource(e.target.value)} className="min-h-[320px] font-mono text-[12.5px]" spellCheck={false} />
          <MermaidPreview source={source} onSvg={onSvg} />
        </div>
      ) : (
        <img src={`/api/projects/${slug}/figures/${fig.name}/file`} alt={fig.caption} className="max-h-[420px] rounded-[var(--radius-sm)] border border-border bg-white object-contain" />
      )}
      <p className="mt-3 text-[12.5px] text-muted-foreground">
        Refer to it in the text as <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{`Figure @fig:${fig.name}`}</code>. Export turns that into the figure number.
      </p>
      <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
        Insert in a section as
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{`![${caption || "Caption"}](figures/${fig.name}.${fig.kind === "mermaid" ? "svg" : (fig.file ?? "x.png").split(".").pop()}){#fig:${fig.name}}`}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(`![${caption || "Caption"}](figures/${fig.name}.${fig.kind === "mermaid" ? "svg" : (fig.file ?? "x.png").split(".").pop()}){#fig:${fig.name}}`);
            toast.success("Copied");
          }}
          className="rounded p-1 hover:bg-muted"
          aria-label="Copy"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </Card>
  );
}

function NewMermaidDialog({ slug, open, onOpenChange, onCreated }: { slug: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (f: Figure) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("architecture");
  const [caption, setCaption] = useState("");
  const [diagram, setDiagram] = useState("architecture");
  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState("flowchart LR\n  A[Input] --> B[Process] --> C[Output]");
  const gen = useMutation({
    mutationFn: () => api.post<{ source: string }>(`/api/projects/${slug}/figures/generate`, { prompt, diagram }),
    onSuccess: (r) => setSource(r.source),
    onError: (e: Error) => toast.error(e.message),
  });
  const create = useMutation({
    mutationFn: () => api.post<Figure>(`/api/projects/${slug}/figures/mermaid`, { name, caption, source }),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ["figures", slug] });
      onOpenChange(false);
      onCreated(f);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New diagram" description="Architecture, flow or sequence diagrams from Mermaid. The model can draft one from your spec; you edit the text." className="max-w-3xl">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Type">
                <Select value={diagram} onValueChange={setDiagram}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="architecture">Architecture</SelectItem>
                    <SelectItem value="flow">Workflow</SelectItem>
                    <SelectItem value="sequence">Sequence</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Caption">
              <Input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Overview of the system components and data flow." />
            </Field>
            <Field label="Ask the model (optional)" hint="Uses only your spec and facts.">
              <div className="flex gap-2">
                <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. focus on the ranking pipeline" />
                <Button type="button" variant="secondary" onClick={() => gen.mutate()} loading={gen.isPending}>
                  <Sparkles className="h-4 w-4" /> Draft
                </Button>
              </div>
            </Field>
            <Textarea value={source} onChange={(e) => setSource(e.target.value)} className="min-h-[200px] font-mono text-[12.5px]" spellCheck={false} />
          </div>
          <MermaidPreview source={source} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !source.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FiguresPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${slug}`) });
  const figures = useQuery({ queryKey: ["figures", slug], queryFn: () => api.get<Figure[]>(`/api/projects/${slug}/figures`) });
  const [editing, setEditing] = useState<string | null>(null);
  const [newDiagram, setNewDiagram] = useState(false);
  const [del, setDel] = useState<Figure | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f, f.name);
      fd.append("name", f.name.replace(/\.[^.]+$/, ""));
      fd.append("caption", "");
      const t = document.cookie.match(/(?:^|;\s*)pw_csrf=([^;]+)/)?.[1] ?? "";
      const res = await fetch(`/api/projects/${slug}/figures/upload`, { method: "POST", body: fd, headers: { "x-csrf-token": decodeURIComponent(t) } });
      if (!res.ok) throw new Error((await res.json()).detail ?? "Upload failed");
      return (await res.json()) as Figure;
    },
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ["figures", slug] });
      setEditing(f.name);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/api/projects/${slug}/figures/${name}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["figures", slug] });
      setDel(null);
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (project.isLoading) return <Skeleton className="h-64" />;
  if (!project.data) return <ProjectLoadError query={project} />;
  const p = project.data;
  const list = figures.data ?? [];
  const current = list.find((f) => f.name === editing) ?? null;

  return (
    <div className="animate-in">
      <Link to={`/projects/${slug}`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" /> {p.title}
      </Link>
      <PageHeader
        eyebrow={list.length ? <Badge variant="success">{list.length} figure{list.length === 1 ? "" : "s"}</Badge> : <Badge>None yet</Badge>}
        title="Figures"
        description="Diagrams from Mermaid text, rendered here and stored as SVG and PNG for export. Result charts, screenshots and diagrams drawn elsewhere are uploaded, never generated. Measurements go in below as tables."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                Array.from(e.target.files ?? []).forEach((f) => upload.mutate(f));
                e.target.value = "";
              }}
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={upload.isPending} title="PNG, JPEG, SVG, WebP or PDF, up to 20 MB each">
              <Upload className="h-4 w-4" /> Upload images
            </Button>
            <Button onClick={() => setNewDiagram(true)}>
              <Plus className="h-4 w-4" /> New diagram
            </Button>
          </>
        }
      />

      {current ? (
        <div className="mb-6">
          <FigureEditor key={current.name + (current.updated_at ?? "")} slug={slug} fig={current} onClose={() => setEditing(null)} />
        </div>
      ) : null}

      <SectionTitle>All figures</SectionTitle>
      {figures.isLoading ? (
        <Skeleton className="h-32" />
      ) : list.length === 0 ? (
        <EmptyState icon={<ImageIcon />} title="No figures yet" description="Most tool papers need an architecture diagram and at least one results figure." action={<Button onClick={() => setNewDiagram(true)}>New diagram</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((f) => (
            <Card key={f.name} interactive onClick={() => setEditing(f.name)} className={cn("overflow-hidden", editing === f.name && "border-primary/50")}>
              <div className="flex h-36 items-center justify-center bg-white p-2">
                {f.file || f.png_file ? (
                  <img src={`/api/projects/${slug}/figures/${f.name}/file`} alt={f.caption} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-[12.5px] text-subtle">Not rendered yet</span>
                )}
              </div>
              <div className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] font-semibold">{f.name}</span>
                    <Badge variant="outline">{f.kind === "mermaid" ? "Mermaid" : "Image"}</Badge>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">{f.caption || "No caption yet"}</div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDel(f);
                  }}
                  className="rounded p-1.5 text-subtle hover:bg-destructive-soft hover:text-destructive"
                  aria-label="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ResultsTables slug={slug} />
      <NextStepBar p={p} current="figures" />
      <NewMermaidDialog slug={slug} open={newDiagram} onOpenChange={setNewDiagram} onCreated={(f) => setEditing(f.name)} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete figure “${del?.name}”?`}
        description="Sections that reference it will show a broken image until you remove the reference."
        onConfirm={() => del && remove.mutate(del.name)}
        busy={remove.isPending}
      />
    </div>
  );
}
