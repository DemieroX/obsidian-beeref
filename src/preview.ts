import { BeeItem, hydrateImage, readBee } from "./beeFile";

const rad = (d: number) => (d * Math.PI) / 180;

function localRect(i: BeeItem) {
  if (i.type === "pixmap") {
    const c = i.crop || [0, 0, i.imageWidth || 0, i.imageHeight || 0];
    return { x: c[0], y: c[1], w: c[2], h: c[3] };
  }
  const lines = String(i.text ?? "").split("\n");
  const w = Math.max(40, ...lines.map(l => l.length * 7)) + 8;
  const h = Math.max(16, lines.length * 16) + 6;
  return { x: 0, y: 0, w, h };
}

function localToScene(i: BeeItem, lx: number, ly: number) {
  const sx = lx * (i.flip || 1) * i.scale;
  const sy = ly * i.scale;
  const c = Math.cos(rad(i.rotation));
  const s = Math.sin(rad(i.rotation));
  return { x: i.x + sx * c - sy * s, y: i.y + sx * s + sy * c };
}

function corners(i: BeeItem) {
  const r = localRect(i);
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => localToScene(i, x, y));
}

function bounds(items: BeeItem[]) {
  if (!items.length) return null;
  const all = items.flatMap(corners);
  return { minX: Math.min(...all.map(p => p.x)), minY: Math.min(...all.map(p => p.y)), maxX: Math.max(...all.map(p => p.x)), maxY: Math.max(...all.map(p => p.y)) };
}

export interface PreviewResult {
  canvas: HTMLCanvasElement;
  itemCount: number;
}

export interface PreviewOptions {
  maxWidth: number;
  maxHeight: number;
  background: string;
  textColor: string;
  maxImages?: number;
}

// static, non-interactive scene snapshot used for ![[board.bee]] embeds — hydrates only the
// largest N images so a heavy board still renders quickly
export async function renderBeePreview(bytes: ArrayBuffer, opts: PreviewOptions): Promise<PreviewResult> {
  const { items } = await readBee(bytes, false);
  const b = bounds(items);
  const maxImages = opts.maxImages ?? 24;
  const imageItems = items.filter(i => i.type === "pixmap" && i.imageBytes?.length);
  const bySize = [...imageItems].sort((x, y) => {
    const ax = localRect(x), ay = localRect(y);
    return ay.w * ay.h - ax.w * ax.h;
  }).slice(0, maxImages);
  await Promise.all(bySize.map(i => hydrateImage(i)));

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  if (!b) {
    canvas.width = Math.round(opts.maxWidth * dpr);
    canvas.height = Math.round(Math.min(opts.maxHeight, 120) * dpr);
    canvas.style.width = `${opts.maxWidth}px`;
    canvas.style.height = `${Math.min(opts.maxHeight, 120)}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, opts.maxWidth, Math.min(opts.maxHeight, 120));
    return { canvas, itemCount: 0 };
  }

  const pad = 16;
  const sceneW = Math.max(1, b.maxX - b.minX + pad * 2);
  const sceneH = Math.max(1, b.maxY - b.minY + pad * 2);
  const scale = Math.min(opts.maxWidth / sceneW, opts.maxHeight / sceneH, 1);
  const cw = Math.max(1, Math.round(sceneW * scale));
  const ch = Math.max(1, Math.round(sceneH * scale));
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(-((b.minX - pad) * scale), -((b.minY - pad) * scale));
  ctx.scale(scale, scale);
  for (const i of [...items].sort((a, c) => a.z - c.z || a.id - c.id)) {
    const r = localRect(i);
    ctx.save();
    ctx.translate(i.x, i.y);
    ctx.rotate(rad(i.rotation));
    ctx.scale(i.scale * (i.flip || 1), i.scale);
    if (i.type === "pixmap") {
      if (i.image) {
        ctx.globalAlpha = i.opacity ?? 1;
        ctx.drawImage(i.image as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      } else {
        ctx.fillStyle = "rgba(128,128,128,.35)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    } else {
      ctx.fillStyle = "rgba(128,128,128,.25)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = opts.textColor;
      ctx.font = "12px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(String(i.text ?? "").slice(0, 40), r.x + 4, r.y + 3);
    }
    ctx.restore();
  }
  ctx.restore();
  return { canvas, itemCount: items.length };
}
