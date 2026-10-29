// Cropping one image (components/media/detail-panel.tsx), in the browser: Carrel reads the file's own
// bytes through its media endpoint (same origin, so the canvas can be exported), draws them on a
// canvas, and cuts the chosen rectangle at full resolution. The result is saved as a new file, or, for
// the Owner on a site that replaces files, in place of this one (same id and address, so every post
// that shows it shows the crop). Drag on the picture to choose; the four fields say the same in pixels
// and are the keyboard's way in. The picture is drawn on a canvas because the policy loads images only
// from the sites, not from blob: addresses.

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Field } from "capsomer/react/field";
import { Select } from "capsomer/react/select";

type Rect = { x: number; y: number; w: number; h: number };

const ASPECTS = [
  { value: "free", label: "Free" },
  { value: "original", label: "As the original" },
  { value: "1:1", label: "Square, 1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:2", label: "3:2" },
  { value: "16:9", label: "Wide, 16:9" },
  { value: "4:5", label: "Tall, 4:5" },
];

/** The width the picture is drawn at, at most; the crop itself is cut from the full-size original. */
const VIEW_WIDTH = 640;

function ratioOf(aspect: string, width: number, height: number): number | null {
  if (aspect === "free") return null;
  if (aspect === "original") return width / height;
  const [a, b] = aspect.split(":").map(Number);
  return a! / b!;
}

/** A rectangle kept inside the picture, whole pixels, at least 1 by 1, and at the ratio when one is set. */
function fitRect(r: Rect, width: number, height: number, ratio: number | null): Rect {
  let w = Math.max(1, Math.min(width, Math.round(r.w)));
  let h = Math.max(1, Math.min(height, Math.round(r.h)));
  if (ratio) {
    if (w / h > ratio) w = Math.max(1, Math.round(h * ratio));
    else h = Math.max(1, Math.round(w / ratio));
    if (h > height) {
      h = height;
      w = Math.max(1, Math.round(h * ratio));
    }
  }
  const x = Math.min(Math.max(0, Math.round(r.x)), width - w);
  const y = Math.min(Math.max(0, Math.round(r.y)), height - h);
  return { x, y, w, h };
}

/** The largest centered rectangle at the ratio, or the whole picture. */
function centered(width: number, height: number, ratio: number | null): Rect {
  if (!ratio) return { x: 0, y: 0, w: width, h: height };
  const w = Math.min(width, height * ratio);
  const h = w / ratio;
  return fitRect({ x: (width - w) / 2, y: (height - h) / 2, w, h }, width, height, ratio);
}

function cropName(name: string, type: string): string {
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return `${name.replace(/\.[a-z0-9]+$/i, "")}-crop.${ext}`;
}

type Props = {
  id: string;
  version: string;
  name: string;
  /** Carrel's media endpoint: GET ?bytes= reads the file, POST uploads one. */
  endpoint: string;
  /** The Owner on a site that replaces files may put the crop in place of the original. */
  canReplace: boolean;
  /** A crop was saved as a new file (its id) or replaced this one (null). */
  onSaved: (newId: string | null) => void;
};

export function CropEditor({ id, version, name, endpoint, canReplace, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [image, setImage] = useState<{ bitmap: ImageBitmap; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState("free");
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const [saving, setSaving] = useState<"copy" | "replace" | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: "draw" | "move"; startX: number; startY: number; from: Rect } | null>(null);
  const replacer = useFetcher<{ ok: boolean; message?: string }>();

  const width = image?.bitmap.width ?? 1;
  const height = image?.bitmap.height ?? 1;
  const ratio = ratioOf(aspect, width, height);
  const scale = Math.min(1, VIEW_WIDTH / width);

  // Reads the file once the dialog opens.
  useEffect(() => {
    if (!open || image) return;
    let canceled = false;
    (async () => {
      const response = await fetch(`${endpoint}?bytes=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `The file did not open (${response.status}).`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      if (canceled) return;
      setImage({ bitmap, type: blob.type || "image/jpeg" });
      setRect({ x: 0, y: 0, w: bitmap.width, h: bitmap.height });
    })().catch((e: unknown) => !canceled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      canceled = true;
    };
  }, [open, image, endpoint, id]);

  // Draws the picture, dims what the crop leaves out, and outlines the crop.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !image) return;
    el.width = Math.round(width * scale);
    el.height = Math.round(height * scale);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image.bitmap, 0, 0, el.width, el.height);
    const r = { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, el.width, r.y);
    ctx.fillRect(0, r.y + r.h, el.width, el.height - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, el.width - r.x - r.w, r.h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#000000";
    ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
  }, [image, rect, scale, width, height]);

  useEffect(() => {
    if (replacer.state !== "idle" || !replacer.data || saving !== "replace") return;
    setSaving(null);
    if (replacer.data.ok) {
      close();
      onSaved(null);
    } else setError(replacer.data.message ?? "The site did not replace the file.");
  }, [replacer.state, replacer.data]);

  const close = () => {
    setOpen(false);
    image?.bitmap.close();
    setImage(null);
    setError(null);
    setAspect("free");
  };

  const at = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - box.left) / box.width) * width, y: ((event.clientY - box.top) / box.height) * height };
  };

  const cut = async (): Promise<File> => {
    if (!image) throw new Error("The picture is not open yet.");
    const out = document.createElement("canvas");
    out.width = rect.w;
    out.height = rect.h;
    out.getContext("2d")!.drawImage(image.bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, image.type, 0.92));
    if (!blob) throw new Error("The browser could not write the crop.");
    return new File([blob], cropName(name, blob.type || image.type), { type: blob.type || image.type });
  };

  const saveCopy = async () => {
    setSaving("copy");
    setError(null);
    try {
      const form = new FormData();
      form.set("file", await cut());
      const response = await fetch(endpoint, { method: "POST", body: form, headers: { accept: "application/json" } });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? `The upload failed (${response.status}).`);
      close();
      onSaved(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const replace = async () => {
    setSaving("replace");
    setError(null);
    try {
      const form = new FormData();
      form.set("intent", "replace");
      form.set("id", id);
      form.set("version", version);
      form.set("file", await cut());
      await replacer.submit(form, { method: "post", encType: "multipart/form-data" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(null);
    }
  };

  const field = (label: string, key: keyof Rect, max: number) => (
    <Field label={label}>
      <input
        className="cap-input"
        type="number"
        min={key === "w" || key === "h" ? 1 : 0}
        max={max}
        value={rect[key]}
        onChange={(event) => {
          const n = Number(event.target.value);
          if (!Number.isFinite(n)) return;
          const next = { ...rect, [key]: n };
          // With a ratio, a new width sets the height and a new height the width.
          if (ratio && key === "w") next.h = n / ratio;
          if (ratio && key === "h") next.w = n * ratio;
          setRect(fitRect(next, width, height, ratio));
        }}
      />
    </Field>
  );

  return (
    <>
      <Button
        onClick={(event) => {
          setOpener(event.currentTarget);
          setOpen(true);
        }}
      >
        Crop<span className="cap-sr-only"> {name}</span>
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && close()} placement="center" size="lg" returnTo={opener} aria-labelledby="crop-title">
        <DialogHeader divider>
          <DialogTitle id="crop-title">Crop {name}</DialogTitle>
          <DialogDescription>Drag on the picture to choose what to keep, or set it in pixels below. The crop is cut from the full-size file.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="app-form">
            {error ? <Alert tone="crit">{error}</Alert> : null}
            {!image && !error ? <p className="cap-muted">Opening the picture...</p> : null}
            {image ? (
              <>
                <canvas
                  ref={canvas}
                  className="app-crop-canvas"
                  role="img"
                  aria-label={`${name}, ${width} by ${height} pixels, with the crop marked: ${rect.w} by ${rect.h} from ${rect.x} across and ${rect.y} down.`}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const p = at(event);
                    const inside = p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
                    drag.current = { mode: inside ? "move" : "draw", startX: p.x, startY: p.y, from: rect };
                  }}
                  onPointerMove={(event) => {
                    const d = drag.current;
                    if (!d) return;
                    const p = at(event);
                    if (d.mode === "move") setRect(fitRect({ ...d.from, x: d.from.x + p.x - d.startX, y: d.from.y + p.y - d.startY }, width, height, null));
                    else setRect(fitRect({ x: Math.min(d.startX, p.x), y: Math.min(d.startY, p.y), w: Math.abs(p.x - d.startX), h: Math.abs(p.y - d.startY) }, width, height, ratio));
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                />
                <div className="app-crop-fields">
                  <Field label="Shape">
                    <Select
                      value={aspect}
                      onChange={(event) => {
                        const next = event.target.value;
                        setAspect(next);
                        setRect(centered(width, height, ratioOf(next, width, height)));
                      }}
                      options={ASPECTS}
                    />
                  </Field>
                  {field("Left (px)", "x", width - 1)}
                  {field("Top (px)", "y", height - 1)}
                  {field("Width (px)", "w", width)}
                  {field("Height (px)", "h", height)}
                </div>
                {canReplace ? (
                  <p className="cap-muted app-note">Replace this file keeps its address, so every post that shows it shows the crop, and the original is gone from the site.</p>
                ) : null}
              </>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter align="between">
          <DialogClose part="cancel">Cancel</DialogClose>
          <span className="app-actions app-dialog-actions">
            {canReplace ? (
              <Button variant="danger" pending={saving === "replace"} disabledReason={!image ? "The picture is not open yet." : undefined} onClick={() => void replace()}>
                Replace this file
              </Button>
            ) : null}
            <Button variant="primary" pending={saving === "copy"} disabledReason={!image ? "The picture is not open yet." : undefined} onClick={() => void saveCopy()}>
              Save as a new file
            </Button>
          </span>
        </DialogFooter>
      </Dialog>
    </>
  );
}
