import { Menu, requestUrl } from "obsidian";
import { BeeItem, readBee, writeBee, addImageItem, closeBee, hydrateImage } from "./beeFile";

export interface BeeBoardOptions {
  notify: (msg: string, isError?: boolean) => void;
  // called after any scene-mutating action so the view can debounce an autosave
  onDirty: () => void;
  // Ctrl+S / File menu Save: board hands over fresh bytes, the view writes them to the bound TFile
  onManualSave: (bytes: Uint8Array) => Promise<void>;
  // Save As: board hands over fresh bytes plus a suggested filename
  onSaveAs: (bytes: Uint8Array, suggestedName: string) => Promise<void>;
}

export interface BeeBoardHandle {
  loadFromBytes(bytes: ArrayBuffer, filename: string): Promise<void>;
  getBytes(): Promise<Uint8Array>;
  focus(): void;
  refreshTheme(): void;
  destroy(): void;
}

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function themeColor(root: HTMLElement, varName: string, fallback: string): string {
  const v = getComputedStyle(root).getPropertyValue(varName).trim();
  return v || fallback;
}

const CLIPBOARD_MIME = "application/x-beeref-items";
const CLIPBOARD_MARKER = "BEEREF_CLIPBOARD_7F2C1D";

export function mountBeeBoard(root: HTMLElement, opts: BeeBoardOptions): BeeBoardHandle {
  root.addClass ? root.addClass("beeref-root") : root.classList.add("beeref-root");

  const viewport = root.createDiv ? root.createDiv({ cls: "beeref-viewport" }) : document.createElement("div");
  if (!root.createDiv) { viewport.className = "beeref-viewport"; root.appendChild(viewport); }
  viewport.tabIndex = 0;

  const canvas = document.createElement("canvas");
  const hint = document.createElement("div");
  hint.className = "beeref-hint";
  hint.textContent = "Open a .bee file, drop images, or press T to add a text note.";
  viewport.appendChild(canvas);
  viewport.appendChild(hint);

  const imageInput = document.createElement("input");
  imageInput.type = "file";
  imageInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
  imageInput.multiple = true;
  imageInput.hidden = true;
  viewport.appendChild(imageInput);

  const ctx = canvas.getContext("2d", { alpha: false })!;

  // theme-aware palette, re-resolved on refreshTheme()
  let SCENE_BG = "#3c3c3c";
  let TEXT_COLOR = "#c8c8c8";
  const TEXT_BG = "rgba(0,0,0,0.16)";
  let SELECT_COLOR = "#22d3ee";
  function resolveTheme() {
    SCENE_BG = themeColor(root, "--background-primary", "#3c3c3c");
    TEXT_COLOR = themeColor(root, "--text-normal", "#c8c8c8");
    SELECT_COLOR = themeColor(root, "--interactive-accent", "#22d3ee");
  }
  resolveTheme();

  // qGray() grayscale weights reproduced as an SVG filter, scoped to this board instance
  const filterId = `beerefQGray-${Math.random().toString(36).slice(2)}`;
  const graySvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  graySvg.setAttribute("aria-hidden", "true");
  graySvg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  graySvg.innerHTML = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.34375 0.5 0.15625 0 0 0.34375 0.5 0.15625 0 0 0.34375 0.5 0.15625 0 0 0 0 0 1 0"/></filter>`;
  root.appendChild(graySvg);

  function toast(msg: string, isError = false) { opts.notify(msg, isError); }

  let items: BeeItem[] = [];
  let selected = new Set<number>();
  let beeDb: any = null;
  let currentFileName = "Untitled.bee";
  let nextId = 1;
  let camera = { x: 0, y: 0, zoom: 1 };
  let dpr = 1;
  let framePending = false;
  let sceneDirty = true;
  let overlayDirty = true;
  let sceneCache: HTMLCanvasElement | null = null;
  let sceneCacheKey = "";
  let editingText: BeeItem | null = null;
  let editor: HTMLDivElement | null = null;
  let editingOriginal = "";
  let hoverHandle: Hit = { kind: "none" };
  let hoverPointer: Point = { x: 0, y: 0 };
  let hoverIcon: HTMLDivElement | null = null;
  let cropItem: BeeItem | null = null;
  let cropTemp: [number, number, number, number] | null = null;
  let lastFit: { camera: { x: number; y: number; zoom: number }; itemId?: number } | null = null;
  let destroyed = false;
  let clipboardData: any[] | null = null;
  let lastPointerScene: Point | null = null;

  const SELECT_HANDLE_SIZE = 15;
  const SELECT_RESIZE_SIZE = 28;
  const SELECT_ROTATE_SIZE = 20;
  const SELECT_FREE_CENTER = 32;
  const SELECT_LINE_WIDTH = 4;
  const CROP_HANDLE_SIZE = 28;
  const MAX_UNDO = 80;
  const undoStack: BeeItem[][] = [];
  const redoStack: BeeItem[][] = [];
  const arrangeSettings = { arrangeGap: 10 };

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const cloneItems = () => items.map(i => ({ ...i }));

  function snapshot() {
    undoStack.push(cloneItems());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    opts.onDirty();
  }
  function restore(state: BeeItem[]) {
    items = state.map(i => ({ ...i }));
    selected.clear();
    editingText = null;
    editingOriginal = "";
    requestDraw(true, true);
  }
  function undo() { const s = undoStack.pop(); if (!s) return; redoStack.push(cloneItems()); restore(s); opts.onDirty(); }
  function redo() { const s = redoStack.pop(); if (!s) return; undoStack.push(cloneItems()); restore(s); opts.onDirty(); }

  function requestDraw(scene = true, overlay = true) {
    sceneDirty ||= scene;
    overlayDirty ||= overlay;
    if (framePending || destroyed) return;
    framePending = true;
    requestAnimationFrame(() => { framePending = false; if (!destroyed && (sceneDirty || overlayDirty)) draw(); });
  }
  function resizeCanvas() {
    const r = viewport.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    sceneCache = null;
    sceneCacheKey = "";
    requestDraw(true, true);
  }
  const resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(viewport);

  function screenPoint(e: PointerEvent | MouseEvent): Point { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function screenToScene(sx: number, sy: number): Point { const r = viewport.getBoundingClientRect(); return { x: camera.x + (sx - r.width / 2) / camera.zoom, y: camera.y + (sy - r.height / 2) / camera.zoom }; }
  function sceneToScreen(x: number, y: number): Point { const r = viewport.getBoundingClientRect(); return { x: r.width / 2 + (x - camera.x) * camera.zoom, y: r.height / 2 + (y - camera.y) * camera.zoom }; }

  const TEXT_PAD_X = 4, TEXT_PAD_Y = 3, TEXT_LINE_H = 15, TEXT_FONT = "12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  function textMetrics(i: BeeItem) {
    const lines = String(i.text ?? "").split("\n");
    ctx.save();
    ctx.font = TEXT_FONT;
    const measured = lines.map(l => ctx.measureText(l));
    const w = Math.max(40, ...measured.map(m => m.width)) + TEXT_PAD_X * 2;
    const ascent = Math.max(...measured.map(m => m.actualBoundingBoxAscent || 0), 10);
    const descent = Math.max(...measured.map(m => m.actualBoundingBoxDescent || 0), 3);
    ctx.restore();
    return { w, h: Math.max(TEXT_LINE_H, lines.length * TEXT_LINE_H, ascent + descent) + TEXT_PAD_Y * 2, ascent, descent };
  }
  function localRect(i: BeeItem) {
    if (i.type === "pixmap") { const c = i.crop || [0, 0, i.imageWidth || 0, i.imageHeight || 0]; return { x: c[0], y: c[1], w: c[2], h: c[3] }; }
    const m = textMetrics(i);
    return { x: 0, y: 0, w: m.w, h: m.h };
  }
  function localToScene(i: BeeItem, lx: number, ly: number, scale = i.scale, rotation = i.rotation, x = i.x, y = i.y): Point {
    const sx = lx * (i.flip || 1) * scale, sy = ly * scale, c = Math.cos(rad(rotation)), s = Math.sin(rad(rotation));
    return { x: x + sx * c - sy * s, y: y + sx * s + sy * c };
  }
  function sceneToLocal(i: BeeItem, p: Point): Point {
    const dx = p.x - i.x, dy = p.y - i.y, c = Math.cos(rad(i.rotation)), s = Math.sin(rad(i.rotation));
    return { x: (dx * c + dy * s) / i.scale / (i.flip || 1), y: (-dx * s + dy * c) / i.scale };
  }
  function corners(i: BeeItem): Point[] { const r = localRect(i); return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => localToScene(i, x, y)); }
  function centerLocal(i: BeeItem): Point { const r = localRect(i); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
  function centerScene(i: BeeItem): Point { const c = centerLocal(i); return localToScene(i, c.x, c.y); }
  function itemSceneBounds(i: BeeItem): Bounds { const cs = corners(i); return { minX: Math.min(...cs.map(p => p.x)), minY: Math.min(...cs.map(p => p.y)), maxX: Math.max(...cs.map(p => p.x)), maxY: Math.max(...cs.map(p => p.y)) }; }
  function allBounds(): Bounds | null { if (!items.length) return null; const b = items.map(itemSceneBounds); return { minX: Math.min(...b.map(x => x.minX)), minY: Math.min(...b.map(x => x.minY)), maxX: Math.max(...b.map(x => x.maxX)), maxY: Math.max(...b.map(x => x.maxY)) }; }
  function selectedBounds(): Bounds | null { const a = items.filter(i => selected.has(i.id)); if (!a.length) return null; const b = a.map(itemSceneBounds); return { minX: Math.min(...b.map(x => x.minX)), minY: Math.min(...b.map(x => x.minY)), maxX: Math.max(...b.map(x => x.maxX)), maxY: Math.max(...b.map(x => x.maxY)) }; }

  function fit(bounds: Bounds | null = selectedBounds() || allBounds(), toggleItem?: BeeItem) {
    if (!bounds) { camera = { x: 0, y: 0, zoom: 1 }; requestDraw(true, true); return; }
    if (toggleItem && lastFit?.itemId === toggleItem.id) { camera = lastFit.camera; lastFit = null; requestDraw(true, true); return; }
    if (toggleItem) lastFit = { camera: { ...camera }, itemId: toggleItem.id };
    const r = viewport.getBoundingClientRect(), w = Math.max(1, bounds.maxX - bounds.minX), h = Math.max(1, bounds.maxY - bounds.minY);
    camera = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom: Math.min((r.width - 80) / w, (r.height - 80) / h, 4) };
    requestDraw(true, true);
  }

  function sceneKey() {
    return `${canvas.width}x${canvas.height}|${camera.x.toFixed(3)}|${camera.y.toFixed(3)}|${camera.zoom.toFixed(4)}|edit:${editingText?.id ?? ""}|${items.map(i => `${i.id}:${i.z}:${i.x}:${i.y}:${i.scale}:${i.rotation}:${i.flip}:${i.opacity}:${i.grayscale}:${i.crop?.join(",")}:${i.text ?? ""}`).join(";")}`;
  }
  function buildSceneCache() {
    const key = sceneKey();
    if (sceneCache && sceneCacheKey === key) return;
    const r = viewport.getBoundingClientRect();
    sceneCache = document.createElement("canvas");
    sceneCache.width = canvas.width;
    sceneCache.height = canvas.height;
    const c = sceneCache.getContext("2d", { alpha: false })!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = SCENE_BG;
    c.fillRect(0, 0, r.width, r.height);
    c.save();
    c.translate(r.width / 2, r.height / 2);
    c.scale(camera.zoom, camera.zoom);
    c.translate(-camera.x, -camera.y);
    for (const i of [...items].sort((a, b) => a.z - b.z || a.id - b.id)) drawItem(c, i);
    c.restore();
    sceneCacheKey = key;
  }
  function draw() {
    if (sceneDirty) {
      buildSceneCache();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sceneCache!, 0, 0);
      sceneDirty = false;
    } else if (sceneCache) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sceneCache, 0, 0);
    }
    drawOverlay();
    overlayDirty = false;
    hint.style.display = items.length > 0 ? "none" : "flex";
  }
  function drawItem(c: CanvasRenderingContext2D, i: BeeItem) {
    if (i.type === "text" && editingText === i) return;
    if (i.type === "pixmap") {
      if (!i.image) return;
      const r = localRect(i);
      c.save();
      c.translate(i.x, i.y);
      c.rotate(rad(i.rotation));
      c.scale(i.scale * (i.flip || 1), i.scale);
      c.globalAlpha = i.opacity ?? 1;
      c.imageSmoothingEnabled = camera.zoom < 2;
      if (i.grayscale) c.filter = `url(#${filterId})`;
      c.drawImage(i.image, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      c.restore();
      return;
    }
    c.save();
    c.translate(i.x, i.y);
    c.rotate(rad(i.rotation));
    c.scale(i.scale * (i.flip || 1), i.scale);
    const m = textMetrics(i);
    const lines = String(i.text ?? "").split("\n");
    c.font = TEXT_FONT;
    c.fillStyle = TEXT_BG;
    c.fillRect(0, 0, m.w, m.h);
    c.fillStyle = TEXT_COLOR;
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    const blockH = lines.length * TEXT_LINE_H;
    const firstBaseline = (m.h - blockH) / 2 + (m.ascent - m.descent + TEXT_LINE_H) / 2;
    lines.forEach((line, n) => c.fillText(line, m.w / 2, firstBaseline + n * TEXT_LINE_H));
    c.restore();
  }

  function drawOverlay() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cropItem && cropTemp) drawCropOverlay(cropItem, cropTemp);
    else if (selected.size === 1) drawSingleSelection(items.find(i => selected.has(i.id)));
    else if (selected.size > 1) drawMultiSelection();
    if (action === "rubber" && active?.currentScene) {
      const a = sceneToScreen(active.start.x, active.start.y), b = sceneToScreen(active.currentScene.x, active.currentScene.y);
      const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rw = Math.abs(a.x - b.x), rh = Math.abs(a.y - b.y);
      ctx.fillStyle = "rgba(85,199,247,.18)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    }
    ctx.restore();
  }
  function drawSingleSelection(i?: BeeItem) {
    if (!i) return;
    const cs = corners(i).map(p => sceneToScreen(p.x, p.y));
    ctx.save();
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = SELECT_LINE_WIDTH;
    ctx.beginPath();
    cs.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = SELECT_COLOR;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = SELECT_HANDLE_SIZE;
    ctx.lineCap = "round";
    for (const p of cs) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    ctx.restore();
  }
  function drawMultiSelection() {
    const b = selectedBounds();
    if (!b) return;
    const p1 = sceneToScreen(b.minX, b.minY), p2 = sceneToScreen(b.maxX, b.maxY);
    ctx.save();
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = SELECT_LINE_WIDTH;
    ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    ctx.fillStyle = SELECT_COLOR;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = SELECT_HANDLE_SIZE;
    ctx.lineCap = "round";
    for (const p of [{ x: p1.x, y: p1.y }, { x: p2.x, y: p1.y }, { x: p2.x, y: p2.y }, { x: p1.x, y: p2.y }]) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    ctx.restore();
  }
  function drawCropOverlay(i: BeeItem, crop: [number, number, number, number]) {
    const full = localRect({ ...i, crop: [0, 0, i.imageWidth || 0, i.imageHeight || 0] });
    const r = { x: crop[0], y: crop[1], w: crop[2], h: crop[3] };
    const fullcs = [[full.x, full.y], [full.x + full.w, full.y], [full.x + full.w, full.y + full.h], [full.x, full.y + full.h]].map(([x, y]) => sceneToScreen(...(Object.values(localToScene(i, x, y)) as [number, number])));
    const cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => sceneToScreen(...(Object.values(localToScene(i, x, y)) as [number, number])));
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.42)";
    ctx.beginPath();
    fullcs.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    cs.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill("evenodd");
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    cs.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "#000";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    cs.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of cs) { ctx.fillStyle = "#3c3c3c"; ctx.strokeStyle = "#fff"; ctx.fillRect(p.x - 7.5, p.y - 7.5, 15, 15); ctx.strokeRect(p.x - 7.5, p.y - 7.5, 15, 15); }
    ctx.restore();
  }

  function fixedLength(v: number, i: BeeItem) { return v / camera.zoom / i.scale; }
  function freeCenterContains(i: BeeItem, p: Point) { const q = sceneToLocal(i, p), c = centerLocal(i), s = fixedLength(SELECT_FREE_CENTER, i); return q.x >= c.x - s / 2 && q.x <= c.x + s / 2 && q.y >= c.y - s / 2 && q.y <= c.y + s / 2; }
  function scaleRectContains(i: BeeItem, n: number, p: Point) { const q = sceneToLocal(i, p), r = localRect(i), cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], c = cs[n], s = fixedLength(SELECT_RESIZE_SIZE, i) / 2; return Math.abs(q.x - c[0]) <= s && Math.abs(q.y - c[1]) <= s; }
  function rotateRectContains(i: BeeItem, n: number, p: Point) {
    const q = sceneToLocal(i, p), r = localRect(i), cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], corner = cs[n];
    const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 }, dir = { x: corner[0] > center.x ? 1 : -1, y: corner[1] > center.y ? 1 : -1 };
    const rs = fixedLength(SELECT_RESIZE_SIZE, i), ro = fixedLength(SELECT_ROTATE_SIZE, i);
    const p1 = { x: corner[0] - dir.x * rs / 2, y: corner[1] - dir.y * rs / 2 }, p2 = { x: p1.x + dir.x * (rs + ro), y: p1.y + dir.y * (rs + ro) };
    const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x), minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
    if (q.x < minX || q.x > maxX || q.y < minY || q.y > maxY) return false;
    return !scaleRectContains(i, n, p);
  }
  function flipEdgeContains(i: BeeItem, p: Point) {
    const q = sceneToLocal(i, p), r = localRect(i), m = fixedLength(SELECT_RESIZE_SIZE, i) / 2;
    const edges = [
      { x: r.x + m, y: r.y - m, w: Math.max(0, r.w - 2 * m), h: 2 * m, v: true },
      { x: r.x + m, y: r.y + r.h - m, w: Math.max(0, r.w - 2 * m), h: 2 * m, v: true },
      { x: r.x - m, y: r.y + m, w: 2 * m, h: Math.max(0, r.h - 2 * m), v: false },
      { x: r.x + r.w - m, y: r.y + m, w: 2 * m, h: Math.max(0, r.h - 2 * m), v: false },
    ];
    const rot = ((i.rotation % 360) + 360) % 360, sideways = (45 < rot && rot < 135) || (225 < rot && rot < 315);
    for (const e of edges) if (q.x >= e.x && q.x <= e.x + e.w && q.y >= e.y && q.y <= e.y + e.h) return { flipV: sideways ? !e.v : e.v };
    return null;
  }

  type Hit = { kind: "none" } | { kind: "scale"; item: BeeItem; corner: number } | { kind: "rotate"; item: BeeItem; corner: number } | { kind: "flip"; item: BeeItem; vertical: boolean } | { kind: "rotategroup"; corner: number } | { kind: "scalegroup"; corner: number };

  function groupSceneCorners(b: Bounds): Point[] { return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]; }
  function groupScaleZoneContains(b: Bounds, n: number, p: Point) { const cs = groupSceneCorners(b), c = cs[n], s = SELECT_RESIZE_SIZE / camera.zoom / 2; return Math.abs(p.x - c.x) <= s && Math.abs(p.y - c.y) <= s; }
  function groupRotateZoneContains(b: Bounds, n: number, p: Point) {
    const cs = groupSceneCorners(b), corner = cs[n], center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const dir = { x: corner.x > center.x ? 1 : -1, y: corner.y > center.y ? 1 : -1 };
    const rs = SELECT_RESIZE_SIZE / camera.zoom, ro = SELECT_ROTATE_SIZE / camera.zoom;
    const p1 = { x: corner.x - dir.x * rs / 2, y: corner.y - dir.y * rs / 2 }, p2 = { x: p1.x + dir.x * (rs + ro), y: p1.y + dir.y * (rs + ro) };
    const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x), minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
    return !(Math.abs(p.x - corner.x) <= rs / 2 && Math.abs(p.y - corner.y) <= rs / 2);
  }
  function hitHandle(p: Point): Hit {
    if (cropItem) return { kind: "none" };
    if (selected.size > 1) {
      const b = selectedBounds();
      if (!b) return { kind: "none" };
      for (let n = 0; n < 4; n++) {
        if (groupScaleZoneContains(b, n, p)) return { kind: "scalegroup", corner: n };
        if (groupRotateZoneContains(b, n, p)) return { kind: "rotategroup", corner: n };
      }
      return { kind: "none" };
    }
    if (selected.size !== 1) return { kind: "none" };
    const i = items.find(x => selected.has(x.id));
    if (!i) return { kind: "none" };
    if (freeCenterContains(i, p)) return { kind: "none" };
    for (let n = 0; n < 4; n++) {
      if (scaleRectContains(i, n, p)) return { kind: "scale", item: i, corner: n };
      if (rotateRectContains(i, n, p)) return { kind: "rotate", item: i, corner: n };
    }
    const f = flipEdgeContains(i, p);
    return f ? { kind: "flip", item: i, vertical: f.flipV } : { kind: "none" };
  }
  function pointInItem(i: BeeItem, p: Point) { const q = sceneToLocal(i, p), r = localRect(i); return q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h; }
  function topHit(p: Point) { return [...items].sort((a, b) => b.z - a.z || b.id - a.id).find(i => pointInItem(i, p)); }
  function selectionActionItems() { return items.filter(i => selected.has(i.id)); }
  function selectedImages() { return selectionActionItems().filter(i => i.type === "pixmap"); }

  function setCursor(h: Hit) {
    if (h.kind === "rotate" || h.kind === "rotategroup") viewport.style.cursor = "crosshair";
    else if (h.kind === "scale" || h.kind === "scalegroup") viewport.style.cursor = "nwse-resize";
    else if (h.kind === "flip") viewport.style.cursor = h.vertical ? "ns-resize" : "ew-resize";
    else if (action === "pan") viewport.style.cursor = "grabbing";
    else if (selected.size > 1) viewport.style.cursor = "move";
    else viewport.style.cursor = "default";
    updateHoverIcon(h);
  }
  function ensureHoverIcon() {
    if (!hoverIcon) {
      hoverIcon = document.createElement("div");
      hoverIcon.className = "beeref-hover-icon";
      hoverIcon.setAttribute("aria-hidden", "true");
      viewport.appendChild(hoverIcon);
    }
  }
  function updateHoverIcon(h: Hit) {
    if (!hoverIcon) ensureHoverIcon();
    if (!hoverIcon) return;
    let svg = "";
    if (h.kind === "rotate" || h.kind === "rotategroup") svg = '<svg viewBox="0 0 24 24"><path d="M6 8a7 7 0 1 1-1 7"/><path d="M6 4v4h4"/></svg>';
    else if (h.kind === "flip") svg = h.vertical ? '<svg viewBox="0 0 24 24"><path d="M3 12h18M8 6l4-4 4 4M8 18l4 4 4-4"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 3v18M6 8l-4 4 4 4M18 8l4 4-4 4"/></svg>';
    else if (h.kind === "scale" || h.kind === "scalegroup") svg = '<svg viewBox="0 0 24 24"><path d="M5 19 19 5M8 5h-3v3M16 19h3v-3"/></svg>';
    if (!svg) { hoverIcon.style.display = "none"; return; }
    hoverIcon.innerHTML = svg;
    hoverIcon.style.display = "block";
    hoverIcon.style.left = `${hoverPointer.x + 10}px`;
    hoverIcon.style.top = `${hoverPointer.y + 10}px`;
  }

  function anchorTransform(i: BeeItem, anchorScene: Point, mutate: () => void) {
    const anchorLocal = sceneToLocal(i, anchorScene);
    mutate();
    const now = localToScene(i, anchorLocal.x, anchorLocal.y);
    i.x += anchorScene.x - now.x;
    i.y += anchorScene.y - now.y;
  }
  function getRotateAngle(p: Point, anchor: Point) { const d = { x: p.x - anchor.x, y: p.y - anchor.y }; return -deg(Math.atan2(d.x, d.y)); }
  function rotateDelta(p: Point, a: any, e: PointerEvent) {
    let d = getRotateAngle(p, a.anchor) - a.startAngle;
    if (e.ctrlKey || e.shiftKey) d = Math.round((a.origRotation + d) / 15) * 15 - a.origRotation;
    return d;
  }
  function rotatePointAround(p: Point, c: Point, angleDeg: number): Point {
    const dx = p.x - c.x, dy = p.y - c.y, cs = Math.cos(rad(angleDeg)), sn = Math.sin(rad(angleDeg));
    return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
  }

  let action: "none" | "pan" | "move" | "scale" | "rotate" | "rotategroup" | "scalegroup" | "rubber" | "crop" = "none";
  let active: any = null;

  function beginTextEdit(i: BeeItem) {
    if (i.type !== "text") return;
    finishTextEdit(false);
    editingText = i;
    editingOriginal = String(i.text ?? "");
    editor = document.createElement("div");
    editor.className = "beeref-text-editor";
    editor.contentEditable = "true";
    (editor as any).spellcheck = false;
    editor.textContent = editingOriginal;
    viewport.appendChild(editor);
    syncEditor();
    editor.focus();
    placeCaretAtEnd(editor);
    editor.addEventListener("input", () => {
      if (editingText) {
        editingText.text = editor!.innerText.replace(/\r/g, "");
        editingText.data = { ...editingText.data, text: editingText.text };
        syncEditor();
      }
    });
    requestDraw(true, true);
  }
  function placeCaretAtEnd(el: HTMLElement) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }
  function syncEditor() {
    if (!editor || !editingText) return;
    const i = editingText, r = localRect(i), p = sceneToScreen(i.x, i.y);
    const lines = Math.max(1, editor.innerText.split("\n").length);
    const w = Math.max(40, r.w), h = Math.max(TEXT_LINE_H + TEXT_PAD_Y * 2, r.h);
    const topPad = Math.max(TEXT_PAD_Y, (h - lines * TEXT_LINE_H) / 2);
    editor.style.left = `${p.x}px`;
    editor.style.top = `${p.y}px`;
    editor.style.width = `${w}px`;
    editor.style.minHeight = `${h}px`;
    editor.style.height = "auto";
    editor.style.padding = `${topPad}px ${TEXT_PAD_X}px`;
    const s = camera.zoom * i.scale;
    editor.style.transform = `rotate(${i.rotation}deg) scale(${s},${s})`;
    editor.style.transformOrigin = "0 0";
  }
  function finishTextEdit(commit = true) {
    if (!editingText || !editor) return;
    const i = editingText;
    const fresh = freshTextDefaults.get(i.id);
    const finalText = commit ? editor.innerText.replace(/\r/g, "") : editingOriginal;
    const pristine = !!fresh && finalText === fresh.text && i.scale === fresh.scale && i.rotation === fresh.rotation && i.flip === fresh.flip;
    const shouldDelete = pristine || (commit && !finalText.trim());
    if (commit || shouldDelete) {
      snapshot();
      if (shouldDelete) { items = items.filter(x => x !== i); selected.delete(i.id); }
      else { i.text = finalText; i.data = { ...i.data, text: finalText }; }
    } else {
      i.text = editingOriginal;
      i.data = { ...i.data, text: editingOriginal };
    }
    freshTextDefaults.delete(i.id);
    editor.remove();
    editor = null;
    editingText = null;
    requestDraw(true, true);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button === 2) return;
    if (editingText && e.target !== editor) finishTextEdit(true);
    const sp = screenPoint(e), p = screenToScene(sp.x, sp.y);
    if (e.button === 1 && e.altKey) { action = "pan"; active = { start: sp, cam: { ...camera } }; viewport.setPointerCapture(e.pointerId); return; }
    if (e.button === 1 && e.ctrlKey && e.altKey) { action = "pan"; active = { start: sp, cam: { ...camera } }; viewport.setPointerCapture(e.pointerId); return; }
    if (cropItem) { handleCropPointer(p, e); return; }
    const h = hitHandle(p);
    hoverHandle = h;
    setCursor(h);
    if (h.kind === "rotategroup") {
      const sel = selectionActionItems();
      if (!sel.length) return;
      snapshot();
      const b = selectedBounds()!, anchor = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      active = { items: sel.map(i => ({ id: i.id, x: i.x, y: i.y, rotation: i.rotation, flip: i.flip })), anchor, start: p, startAngle: getRotateAngle(p, anchor) };
      action = "rotategroup";
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (h.kind === "scalegroup") {
      const sel = selectionActionItems();
      if (!sel.length) return;
      snapshot();
      const b = selectedBounds()!, anchor = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const startDist = Math.hypot(p.x - anchor.x, p.y - anchor.y) || 1;
      active = { items: sel.map(i => ({ id: i.id, x: i.x, y: i.y, scale: i.scale })), anchor, start: p, startDist };
      action = "scalegroup";
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (h.kind === "scale") {
      snapshot();
      const i = h.item, anchor = centerScene(i);
      const diff = { x: p.x - anchor.x, y: p.y - anchor.y }, len = Math.hypot(diff.x, diff.y) || 1;
      active = { item: i, start: p, anchor, orig: { scale: i.scale, x: i.x, y: i.y, rotation: i.rotation, flip: i.flip }, direction: { x: diff.x / len, y: diff.y / len }, startScale: i.scale };
      action = "scale";
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (h.kind === "rotate") {
      snapshot();
      const i = h.item;
      active = { item: i, anchor: centerScene(i), start: p, startAngle: getRotateAngle(p, centerScene(i)), origRotation: i.rotation, origFlip: i.flip };
      action = "rotate";
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (h.kind === "flip") {
      snapshot();
      const i = h.item, anchor = centerScene(i);
      anchorTransform(i, anchor, () => { i.flip *= -1; if (h.vertical) i.rotation = (i.rotation + 180) % 360; });
      action = "none";
      requestDraw(true, true);
      return;
    }
    const hit = topHit(p);
    if (hit) {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !selected.has(hit.id)) selected.clear();
      if (e.ctrlKey || e.metaKey || e.shiftKey) { if (selected.has(hit.id)) selected.delete(hit.id); else selected.add(hit.id); }
      else selected.add(hit.id);
      requestDraw(true, true);
      if (hit.type === "text" && e.detail >= 2) { beginTextEdit(hit); return; }
      snapshot();
      action = "move";
      active = { start: p, orig: selectionActionItems().map(i => ({ id: i.id, x: i.x, y: i.y })), promoted: false };
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (items.length) { selected.clear(); action = "rubber"; active = { start: p, currentScene: p }; viewport.setPointerCapture(e.pointerId); }
    else selected.clear();
    requestDraw(false, true);
  }
  function onPointerMove(e: PointerEvent) {
    const sp = screenPoint(e);
    hoverPointer = sp;
    const p = screenToScene(sp.x, sp.y);
    if (action === "none") { hoverHandle = hitHandle(p); setCursor(hoverHandle); if (editingText) syncEditor(); return; }
    if (action === "pan") { camera.x = active.cam.x - (sp.x - active.start.x) / camera.zoom; camera.y = active.cam.y - (sp.y - active.start.y) / camera.zoom; requestDraw(true, true); return; }
    if (action === "move") {
      const dx = p.x - active.start.x, dy = p.y - active.start.y;
      // only bump z-order once the drag actually moves — a plain click/select no longer reorders items
      if (!active.promoted && (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001)) {
        const sorted = selectionActionItems().sort((a, b) => a.z - b.z || a.id - b.id);
        let maxZ = Math.max(-1, ...items.map(i => i.z));
        for (const i of sorted) i.z = ++maxZ;
        active.promoted = true;
      }
      for (const o of active.orig) { const i = items.find(x => x.id === o.id); if (i) { i.x = o.x + dx; i.y = o.y + dy; } }
      requestDraw(true, true);
      return;
    }
    if (action === "rotate") { const i = active.item, d = rotateDelta(p, active, e); anchorTransform(i, active.anchor, () => (i.rotation = (active.origRotation + d * i.flip) % 360)); requestDraw(true, true); return; }
    if (action === "rotategroup") {
      let d = getRotateAngle(p, active.anchor) - active.startAngle;
      if (e.ctrlKey || e.shiftKey) d = Math.round(d / 15) * 15;
      for (const o of active.items) {
        const it = items.find(x => x.id === o.id);
        if (!it) continue;
        it.rotation = (o.rotation + d * o.flip) % 360;
        const np = rotatePointAround({ x: o.x, y: o.y }, active.anchor, d);
        it.x = np.x;
        it.y = np.y;
      }
      requestDraw(true, true);
      return;
    }
    if (action === "scalegroup") {
      const dist = Math.hypot(p.x - active.anchor.x, p.y - active.anchor.y) || 0.0001, ratio = clamp(dist / active.startDist, 0.0001, 50000);
      for (const o of active.items) {
        const it = items.find(x => x.id === o.id);
        if (!it) continue;
        it.scale = clamp(o.scale * ratio, 0.02, 1000);
        it.x = active.anchor.x + (o.x - active.anchor.x) * ratio;
        it.y = active.anchor.y + (o.y - active.anchor.y) * ratio;
      }
      requestDraw(true, true);
      return;
    }
    if (action === "scale") {
      const i = active.item, r = localRect(i), delta = { x: p.x - active.start.x, y: p.y - active.start.y }, imgsize = Math.hypot(r.w, r.h) || 1;
      const amount = (active.direction.x * delta.x + active.direction.y * delta.y) / imgsize, newScale = clamp(active.startScale * (1 + amount / active.startScale), 0.02, 1000);
      anchorTransform(i, active.anchor, () => (i.scale = newScale));
      requestDraw(true, true);
      return;
    }
    if (action === "rubber") {
      active.currentScene = p;
      selected.clear();
      const a = active.start, b = p, minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      for (const i of items) { const ib = itemSceneBounds(i); if (ib.minX <= maxX && ib.maxX >= minX && ib.minY <= maxY && ib.maxY >= minY) selected.add(i.id); }
      requestDraw(false, true);
      return;
    }
    if (action === "crop") moveCrop(p);
  }
  function onPointerUp() {
    action = "none";
    active = null;
    hoverHandle = hitHandle(lastPointerScene || { x: 0, y: 0 });
    setCursor(hoverHandle);
    requestDraw(false, true);
  }

  function enterCrop() {
    if (selected.size !== 1) return;
    const i = items.find(x => selected.has(x.id));
    if (!i || i.type !== "pixmap") return;
    cropItem = i;
    cropTemp = [...(i.crop || [0, 0, i.imageWidth || 0, i.imageHeight || 0])] as [number, number, number, number];
    selected.add(i.id);
    requestDraw(false, true);
  }
  function cropHandleRects(i: BeeItem, c: [number, number, number, number]) { const [x, y, w, h] = c, s = fixedLength(CROP_HANDLE_SIZE, i); return [{ x, y, w: s, h: s, k: 0 }, { x, y: y + h - s, w: s, h: s, k: 1 }, { x: x + w - s, y: y + h - s, w: s, h: s, k: 2 }, { x: x + w - s, y, w: s, h: s, k: 3 }]; }
  function cropEdges(i: BeeItem, c: [number, number, number, number]) { const [x, y, w, h] = c, s = fixedLength(CROP_HANDLE_SIZE, i); return [{ x: x + s, y, w: Math.max(0, w - 2 * s), h: s, k: 4 }, { x, y: y + s, w: s, h: Math.max(0, h - 2 * s), k: 5 }, { x: x + s, y: y + h - s, w: Math.max(0, w - 2 * s), h: s, k: 6 }, { x: x + w - s, y: y + s, w: s, h: Math.max(0, h - 2 * s), k: 7 }]; }
  function inRect(p: Point, r: any) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
  function handleCropPointer(p: Point, e: PointerEvent) {
    if (!cropItem || !cropTemp) return;
    const q = sceneToLocal(cropItem, p), handles = cropHandleRects(cropItem, cropTemp), edges = cropEdges(cropItem, cropTemp);
    const h = handles.find(x => inRect(q, x)), ed = edges.find(x => inRect(q, x));
    if (h || ed) { snapshot(); action = "crop"; active = { kind: (h || ed)!.k, start: q, last: q }; viewport.setPointerCapture(e.pointerId); return; }
    commitCrop(inRect(q, { x: cropTemp[0], y: cropTemp[1], w: cropTemp[2], h: cropTemp[3] }));
  }
  function moveCrop(p: Point) {
    if (!cropItem || !cropTemp || !active) return;
    const q = sceneToLocal(cropItem, p), dx = q.x - active.last.x, dy = q.y - active.last.y;
    let [x, y, w, h] = cropTemp;
    const maxX = cropItem.imageWidth || w, maxY = cropItem.imageHeight || h;
    switch (active.kind) {
      case 0: x = clamp(x + dx, 0, x + w - 1); y = clamp(y + dy, 0, y + h - 1); w -= x - cropTemp[0]; h -= y - cropTemp[1]; break;
      case 1: x = clamp(x + dx, 0, x + w - 1); w -= x - cropTemp[0]; h = Math.max(1, h + dy); break;
      case 2: w = clamp(w + dx, 1, maxX - x); h = clamp(h + dy, 1, maxY - y); break;
      case 3: w = clamp(w + dx, 1, maxX - x); y = clamp(y + dy, 0, y + h - 1); h -= y - cropTemp[1]; break;
      case 4: y = clamp(y + dy, 0, y + h - 1); h -= y - cropTemp[1]; break;
      case 5: x = clamp(x + dx, 0, x + w - 1); w -= x - cropTemp[0]; break;
      case 6: h = clamp(h + dy, 1, maxY - y); break;
      case 7: w = clamp(w + dx, 1, maxX - x); break;
    }
    cropTemp = [x, y, w, h];
    active.last = q;
    requestDraw(false, true);
  }
  function commitCrop(confirm = true) {
    if (!cropItem || !cropTemp) return;
    const i = cropItem;
    if (confirm) { i.crop = [...cropTemp]; opts.onDirty(); }
    cropItem = null;
    cropTemp = null;
    active = null;
    action = "none";
    requestDraw(true, true);
  }

  let lastTextScale: number | null = null;
  const freshTextDefaults = new Map<number, { text: string; scale: number; rotation: number; flip: number }>();
  function addText() {
    snapshot();
    const c = screenToScene(hoverPointer.x, hoverPointer.y);
    const scale = lastTextScale ?? clamp(1 / camera.zoom, 0.02, 1000);
    const i: BeeItem = { id: nextId++, type: "text", x: c.x, y: c.y, z: Math.max(-1, ...items.map(x => x.z)) + 1, scale, rotation: 0, flip: 1, data: { text: "Text" }, text: "Text" };
    items.push(i);
    lastTextScale = scale;
    freshTextDefaults.set(i.id, { text: "Text", scale, rotation: 0, flip: 1 });
    selected.clear();
    selected.add(i.id);
    beginTextEdit(i);
  }

  // fetches the images out of a paste/drop DataTransfer, preferring raw file data over any
  // url-ish clipboard format so the same image is never added twice from two representations
  async function imagesFromDataTransfer(dt: DataTransfer | null): Promise<File[]> {
    if (!dt) return [];
    const fromFiles = Array.from(dt.files || []).filter(f => f?.type?.startsWith("image/"));
    if (fromFiles.length) return fromFiles;
    const fromItems: File[] = [];
    for (const item of Array.from(dt.items || [])) {
      if (item.kind === "file" && item.type?.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) fromItems.push(f);
      }
    }
    if (fromItems.length) return fromItems;
    const seenUrls = new Set<string>();
    const candidates: string[] = [];
    try { candidates.push(...String(dt.getData?.("text/uri-list") || "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"))); } catch { /* ignore */ }
    try { candidates.push(...String(dt.getData?.("text/plain") || "").split(/\r?\n/).map(l => l.trim()).filter(l => /^https?:\/\//i.test(l))); } catch { /* ignore */ }
    try {
      const html = String(dt.getData?.("text/html") || "");
      if (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const img of Array.from(doc.images || [])) { const src = img.getAttribute("src"); if (src) candidates.push(src); }
      }
    } catch { /* ignore */ }
    const out: File[] = [];
    for (const url of candidates) {
      if (out.length) break;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      try {
        let blob: Blob | undefined;
        try { const res = await fetch(url); if (res.ok) blob = await res.blob(); } catch { /* fall through to requestUrl */ }
        if (!blob) {
          const res = await requestUrl({ url });
          const type = (res.headers?.["content-type"] || res.headers?.["Content-Type"] || "application/octet-stream") as string;
          blob = new Blob([res.arrayBuffer], { type });
        }
        if (!blob.type.startsWith("image/")) continue;
        const base = url.split("?")[0].split("#")[0].split("/").pop() || "pasted-image";
        const name = base.includes(".") ? base : `${base}.${blob.type.split("/")[1] || "png"}`;
        out.push(new File([blob], name, { type: blob.type }));
      } catch (err) { console.warn("BeeRef Board: could not fetch external image", url, err); }
    }
    return out;
  }

  // routes external images (drop, paste, Insert image…) through the same clipboard-paste
  // machinery used for internal item copies, so both share one positioning/undo code path
  async function addExternalImages(files: File[], targetScreenPoint?: Point): Promise<boolean> {
    const images = files.filter(f => f?.type?.startsWith("image/"));
    if (!images.length) return false;
    const entries: any[] = [];
    for (const file of images) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entry: any = { type: "pixmap", text: undefined, bytes, filename: file.name || "pasted-image.png", x: 0, y: 0, scale: 1, rotation: 0, flip: 1, opacity: 1, grayscale: false, crop: undefined, data: { filename: file.name || "pasted-image.png", opacity: 1, grayscale: false } };
      await hydrateImage(entry);
      const w = entry.imageWidth || 0, h = entry.imageHeight || 0;
      entry.x = -w / 2;
      entry.y = -h / 2;
      entry.data.crop = [0, 0, w, h];
      entry.crop = [0, 0, w, h];
      entries.push(entry);
    }
    if (!entries.length) return false;
    clipboardData = entries;
    if (targetScreenPoint) hoverPointer = targetScreenPoint;
    await pasteClipboard();
    return true;
  }

  async function copySelected() {
    const sel = selectionActionItems();
    if (!sel.length) return;
    clipboardData = sel.map(i => ({ type: i.type, text: i.text, bytes: i.imageBytes ? i.imageBytes.slice() : null, filename: i.filename, x: i.x, y: i.y, scale: i.scale, rotation: i.rotation, flip: i.flip, opacity: i.opacity, grayscale: i.grayscale, crop: i.crop, data: i.data }));
    const text = clipboardData.filter(e => e.type === "text").map(e => e.text).join("\n");
    // the system clipboard only needs to carry a marker (for cross-app paste + disambiguation);
    // the real payload lives in clipboardData, which is far richer than what the OS clipboard can hold
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const payload: Record<string, Blob> = {};
        payload[CLIPBOARD_MIME] = new Blob(["1"], { type: CLIPBOARD_MIME });
        payload["text/plain"] = new Blob([text || ""], { type: "text/plain" });
        await navigator.clipboard.write([new ClipboardItem(payload)]);
      } else {
        await navigator.clipboard?.writeText?.(`${text}${text ? "\n" : ""}${CLIPBOARD_MARKER}`);
      }
    } catch {
      try { await navigator.clipboard?.writeText?.(`${text}${text ? "\n" : ""}${CLIPBOARD_MARKER}`); } catch { /* ignore */ }
    }
  }
  async function pasteClipboard() {
    if (!clipboardData || !clipboardData.length) { toast("Clipboard is empty or unusable", true); return; }
    try {
      const data = clipboardData;
      snapshot();
      const dest = screenToScene(hoverPointer.x, hoverPointer.y);
      const centers = data.map((s: any) => centerScene(s));
      const gcx = centers.reduce((s: number, c: any) => s + c.x, 0) / centers.length, gcy = centers.reduce((s: number, c: any) => s + c.y, 0) / centers.length;
      for (const s of data) {
        const i: BeeItem = { id: nextId++, type: s.type, x: dest.x + (s.x - gcx), y: dest.y + (s.y - gcy), z: items.length, scale: s.scale || 1, rotation: s.rotation || 0, flip: s.flip || 1, data: { ...s.data }, text: s.text, filename: s.filename, opacity: s.opacity, grayscale: s.grayscale, crop: s.crop };
        if (s.bytes) { i.imageBytes = (s.bytes as Uint8Array).slice(); await hydrateImage(i); }
        items.push(i);
      }
      const maxZ = Math.max(-1, ...items.map(i => i.z));
      items.slice(-data.length).forEach((i, n) => (i.z = maxZ + n + 1));
      selected = new Set(items.slice(-data.length).map(i => i.id));
      requestDraw(true, true);
    } catch {
      toast("Clipboard is empty or unusable", true);
    }
  }
  function deleteSelected() {
    if (!selected.size) return;
    snapshot();
    items = items.filter(i => !selected.has(i.id));
    selected.clear();
    requestDraw(true, true);
  }
  function bringFront() {
    const sorted = selectionActionItems().sort((a, b) => a.z - b.z || a.id - b.id);
    if (!sorted.length) return;
    snapshot();
    let maxZ = Math.max(-1, ...items.map(i => i.z));
    sorted.forEach(i => (i.z = ++maxZ));
    requestDraw(true, true);
  }
  function sendBack() {
    const sorted = selectionActionItems().sort((a, b) => a.z - b.z || a.id - b.id);
    if (!sorted.length) return;
    snapshot();
    const minZ = Math.min(0, ...items.map(i => i.z));
    sorted.forEach((i, n) => (i.z = minZ - sorted.length + n));
    requestDraw(true, true);
  }
  function flipSelected(vertical = false) {
    const sel = selectionActionItems();
    if (!sel.length) return;
    snapshot();
    const b = selectedBounds();
    const anchor = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : centerScene(sel[0]);
    for (const i of sel) anchorTransform(i, anchor, () => { i.flip *= -1; if (vertical) i.rotation = (i.rotation + 180) % 360; });
    requestDraw(true, true);
  }
  function toggleGrayscale() {
    const imgs = selectedImages();
    if (!imgs.length) return;
    snapshot();
    const target = !imgs.every(i => i.grayscale);
    imgs.forEach(i => (i.grayscale = target));
    requestDraw(true, true);
  }
  function normalizeImages(mode: "width" | "height" | "size") {
    const imgs = selectedImages();
    if (imgs.length < 2) return;
    snapshot();
    const vals = imgs.map(i => { const r = localRect(i); return mode === "size" ? r.w * r.h : (r as any)[mode]; });
    const avg = vals.reduce((x, y) => x + y, 0) / vals.length;
    for (const i of imgs) {
      const r = localRect(i);
      const factor = mode === "size" ? Math.sqrt(avg / (r.w * r.h)) : avg / (r as any)[mode];
      anchorTransform(i, centerScene(i), () => (i.scale *= factor));
    }
    requestDraw(true, true);
  }
  function arrangeImages(mode: "optimal" | "horizontal" | "vertical" | "square") {
    const imgs = selectedImages().sort((a, b) => String(a.filename || "").localeCompare(String(b.filename || "")));
    if (imgs.length < 2) return;
    snapshot();
    const gap = arrangeSettings.arrangeGap;
    const b = selectedBounds();
    if (!b) return;
    const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    if (mode === "horizontal") {
      const widths = imgs.map(i => { const q = itemSceneBounds(i); return q.maxX - q.minX; });
      const total = widths.reduce((x, y) => x + y, 0) + gap * (imgs.length - 1);
      let x = center.x - total / 2;
      imgs.forEach((i, n) => { const ib = itemSceneBounds(i), w = widths[n]; i.x += x + w / 2 - (ib.minX + ib.maxX) / 2; i.y += center.y - (ib.minY + ib.maxY) / 2; x += w + gap; });
    } else if (mode === "vertical") {
      const heights = imgs.map(i => { const q = itemSceneBounds(i); return q.maxY - q.minY; });
      const total = heights.reduce((x, y) => x + y, 0) + gap * (imgs.length - 1);
      let y = center.y - total / 2;
      imgs.forEach((i, n) => { const ib = itemSceneBounds(i), h = heights[n]; i.x += center.x - (ib.minX + ib.maxX) / 2; i.y += y + h / 2 - (ib.minY + ib.maxY) / 2; y += h + gap; });
    } else if (mode === "square") {
      const cols = Math.ceil(Math.sqrt(imgs.length));
      const cellW = Math.max(...imgs.map(i => itemSceneBounds(i).maxX - itemSceneBounds(i).minX)) + gap;
      const cellH = Math.max(...imgs.map(i => itemSceneBounds(i).maxY - itemSceneBounds(i).minY)) + gap;
      const rows = Math.ceil(imgs.length / cols);
      imgs.forEach((i, n) => {
        const ib = itemSceneBounds(i);
        const cx = center.x - (cols * cellW) / 2 + (n % cols) * cellW + cellW / 2, cy = center.y - (rows * cellH) / 2 + Math.floor(n / cols) * cellH + cellH / 2;
        i.x += cx - (ib.minX + ib.maxX) / 2;
        i.y += cy - (ib.minY + ib.maxY) / 2;
      });
    } else {
      const rects = imgs.map(i => { const q = itemSceneBounds(i); return { item: i, w: q.maxX - q.minX + gap, h: q.maxY - q.minY + gap }; }).sort((u, v) => v.h - u.h || v.w - u.w);
      const area = rects.reduce((sum, r) => sum + r.w * r.h, 0);
      let width = Math.max(1, Math.ceil(Math.sqrt(area)));
      let placements: any[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        placements = [];
        let x = 0, y = 0, rowH = 0;
        for (const r of rects) {
          if (x > 0 && x + r.w > width) { x = 0; y += rowH; rowH = 0; }
          placements.push({ r, x, y });
          x += r.w;
          rowH = Math.max(rowH, r.h);
        }
        const usedH = y + rowH;
        if (usedH <= width) break;
        width = Math.ceil(width * 1.15);
      }
      const usedW = Math.max(...placements.map(p => p.x + p.r.w), 0), usedH = Math.max(...placements.map(p => p.y + p.r.h), 0);
      const ox = center.x - usedW / 2, oy = center.y - usedH / 2;
      for (const p of placements) {
        const ib = itemSceneBounds(p.r.item);
        const cx = ox + p.x + p.r.w / 2, cy = oy + p.y + p.r.h / 2;
        p.r.item.x += cx - (ib.minX + ib.maxX) / 2;
        p.r.item.y += cy - (ib.minY + ib.maxY) / 2;
      }
    }
    requestDraw(true, true);
  }

  function changeOpacity() {
    const imgs = selectedImages();
    if (!imgs.length) return;
    root.querySelector(".beeref-opacity-dialog")?.remove();
    const startPct = Math.round((imgs[0].opacity ?? 1) * 100);
    const backdrop = document.createElement("div");
    backdrop.className = "beeref-opacity-dialog";
    const panel = document.createElement("div");
    panel.className = "beeref-opacity-panel";
    const title = document.createElement("div");
    title.className = "beeref-opacity-title";
    title.textContent = "Image opacity";
    const row = document.createElement("div");
    row.className = "beeref-opacity-row";
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "1"; slider.value = String(startPct);
    const number = document.createElement("input");
    number.type = "number"; number.min = "0"; number.max = "100"; number.step = "1"; number.value = String(startPct);
    const suffix = document.createElement("span");
    suffix.className = "beeref-opacity-suffix";
    suffix.textContent = "%";
    const actions = document.createElement("div");
    actions.className = "beeref-opacity-actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const apply = document.createElement("button");
    apply.textContent = "Apply";
    apply.className = "mod-cta";
    const sync = (v: string) => { const clamped = clamp(Math.round(Number(v) || 0), 0, 100); slider.value = String(clamped); number.value = String(clamped); };
    slider.addEventListener("input", () => sync(slider.value));
    number.addEventListener("input", () => sync(number.value));
    cancel.addEventListener("click", () => backdrop.remove());
    apply.addEventListener("click", () => {
      const value = clamp(Number(number.value) / 100, 0, 1);
      if (!Number.isFinite(value)) return;
      snapshot();
      imgs.forEach(i => (i.opacity = value));
      backdrop.remove();
      requestDraw(true, true);
    });
    backdrop.addEventListener("pointerdown", e => { if (e.target === backdrop) backdrop.remove(); });
    row.append(slider, number, suffix);
    actions.append(cancel, apply);
    panel.append(title, row, actions);
    backdrop.append(panel);
    root.appendChild(backdrop);
    number.select();
    number.focus();
  }

  function showContextMenu(e: MouseEvent) {
    const hasSelection = selected.size > 0;
    const images = selectedImages();
    const hasImage = images.length > 0;
    const singleImage = images.length === 1;
    const menu = new Menu();
    menu.addItem(mi => mi.setTitle("Undo").setDisabled(!undoStack.length).onClick(() => undo()));
    menu.addItem(mi => mi.setTitle("Redo").setDisabled(!redoStack.length).onClick(() => redo()));
    menu.addSeparator();
    menu.addItem(mi => mi.setTitle("Cut").setDisabled(!hasSelection).onClick(() => { copySelected(); deleteSelected(); }));
    menu.addItem(mi => mi.setTitle("Copy").setDisabled(!hasSelection).onClick(() => copySelected()));
    menu.addItem(mi => mi.setTitle("Paste").onClick(() => pasteClipboard()));
    menu.addItem(mi => mi.setTitle("Delete").setDisabled(!hasSelection).onClick(() => deleteSelected()));
    menu.addSeparator();
    menu.addItem(mi => mi.setTitle("Insert image…").onClick(() => imageInput.click()));
    menu.addItem(mi => mi.setTitle("Add text").onClick(() => addText()));
    if (hasSelection) {
      menu.addSeparator();
      menu.addItem(mi => mi.setTitle("Bring to front").onClick(() => bringFront()));
      menu.addItem(mi => mi.setTitle("Send to back").onClick(() => sendBack()));
      menu.addItem(mi => mi.setTitle("Flip horizontal").onClick(() => flipSelected(false)));
      menu.addItem(mi => mi.setTitle("Flip vertical").onClick(() => flipSelected(true)));
    }
    if (hasImage) {
      menu.addSeparator();
      menu.addItem(mi => mi.setTitle("Grayscale").setChecked(images.every(i => i.grayscale)).onClick(() => toggleGrayscale()));
      menu.addItem(mi => mi.setTitle("Change opacity…").onClick(() => changeOpacity()));
    }
    if (singleImage) {
      menu.addSeparator();
      menu.addItem(mi => mi.setTitle("Crop").onClick(() => enterCrop()));
    }
    menu.showAtMouseEvent(e);
  }

  function withinBoard(target: EventTarget | null) { return target instanceof Node && root.contains(target); }

  async function loadFromBytes(bytes: ArrayBuffer, filename: string) {
    try {
      if (beeDb) closeBee(beeDb);
      finishTextEdit(false);
      cropItem = null;
      cropTemp = null;
      const parsed = await readBee(bytes, false);
      beeDb = parsed.db;
      items = parsed.items;
      currentFileName = filename;
      nextId = Math.max(0, ...items.map(i => i.id)) + 1;
      selected.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      sceneCache = null;
      sceneCacheKey = "";
      lastTextScale = null;
      camera = { x: 0, y: 0, zoom: 1 };
      requestDraw(true, true);
      const imageItems = items.filter(i => i.type === "pixmap" && i.imageBytes?.length);
      await Promise.all(imageItems.map(async i => { await hydrateImage(i); requestDraw(true, true); }));
      fit();
    } catch (err) {
      console.error(err);
      toast(`Could not open .bee: ${(err as Error).message}`, true);
      throw err;
    }
  }

  // reassigns z to a clean 0..n-1 sequence in current stacking order, and any duplicate/missing
  // id to a fresh one, so a stray collision can never make the sqlite write throw and roll back
  async function getBytes(): Promise<Uint8Array> {
    const sorted = [...items].sort((a, b) => a.z - b.z || a.id - b.id);
    const seen = new Set<number>();
    let maxId = sorted.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
    const serializable = sorted.map((item, z) => {
      let id = item.id;
      if (id == null || seen.has(id)) { console.warn("BeeRef Board: fixed a duplicate item id before saving", id); id = ++maxId; }
      seen.add(id);
      return { ...item, z, id };
    });
    return writeBee(serializable, beeDb || undefined);
  }
  async function handleSave(asCopy: boolean) {
    if (!items.length && !asCopy) return;
    try {
      const bytes = await getBytes();
      if (asCopy) await opts.onSaveAs(bytes, currentFileName);
      else await opts.onManualSave(bytes);
      toast(`Saved ${currentFileName}`);
    } catch (err) { console.error(err); toast(`Could not save: ${(err as Error).message}`, true); }
  }

  const onPointerLeave = () => { hoverHandle = { kind: "none" }; if (hoverIcon) hoverIcon.style.display = "none"; if (action === "none") viewport.style.cursor = "default"; };
  const onPointerMoveTrack = (e: PointerEvent) => { lastPointerScene = screenToScene(...(Object.values(screenPoint(e)) as [number, number])); onPointerMove(e); };
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); showContextMenu(e); };
  const onDocPointerDownCapture = (e: PointerEvent) => { if (editingText && editor && e.target !== editor && !editor.contains(e.target as Node)) finishTextEdit(true); };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const sp = screenPoint(e), before = screenToScene(sp.x, sp.y);
    if (e.shiftKey && e.ctrlKey) { camera.y += e.deltaY / camera.zoom; requestDraw(true, true); return; }
    if (e.shiftKey) { camera.x += e.deltaY / camera.zoom; requestDraw(true, true); return; }
    camera.zoom = clamp(camera.zoom * Math.exp(-e.deltaY * 0.001), 0.01, 40);
    const after = screenToScene(sp.x, sp.y);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    requestDraw(true, true);
  };
  const onDblClick = (e: MouseEvent) => {
    const sp = screenPoint(e), p = screenToScene(sp.x, sp.y), hit = topHit(p);
    if (hit?.type === "text") { if (!selected.has(hit.id)) selected.add(hit.id); beginTextEdit(hit); }
    else if (hit) fit(itemSceneBounds(hit), hit);
    else fit();
  };
  const onDragEnterOver = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = Array.from(dt.types || []);
    if (types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html")) {
      e.preventDefault();
      e.stopPropagation();
      try { dt.dropEffect = "copy"; } catch { /* ignore */ }
    }
  };
  const onDrop = async (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = Array.from(dt.types || []);
    if (!(types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html"))) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(dt.files || []);
    if (files.find(f => f.name?.toLowerCase().endsWith(".bee"))) {
      toast("Drop a .bee file onto a note link or use File → Open to load it from the vault instead — dropping OS files here only adds images.", true);
      return;
    }
    const images = await imagesFromDataTransfer(dt);
    if (images.length) await addExternalImages(images, screenPoint(e));
  };
  const onImageInputChange = () => {
    if (imageInput.files) addExternalImages(Array.from(imageInput.files), { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
    imageInput.value = "";
  };
  const onPaste = async (e: ClipboardEvent) => {
    if (!withinBoard(e.target as Node) && document.activeElement !== viewport) return;
    const dt = e.clipboardData;
    let isInternal = false;
    try { isInternal = Array.from(dt?.types || []).includes(CLIPBOARD_MIME); } catch { /* ignore */ }
    if (!isInternal) { try { isInternal = String(dt?.getData?.("text/plain") || "").includes(CLIPBOARD_MARKER); } catch { /* ignore */ } }
    if (isInternal && clipboardData?.length) { e.preventDefault(); e.stopPropagation(); await pasteClipboard(); return; }
    const files = await imagesFromDataTransfer(dt);
    if (files.length) { e.preventDefault(); e.stopPropagation(); await addExternalImages(files, hoverPointer); return; }
    if (clipboardData?.length) { e.preventDefault(); e.stopPropagation(); await pasteClipboard(); }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!withinBoard(document.activeElement) && document.activeElement !== viewport) return;
    if (editingText) {
      if (e.key === "Escape") { e.preventDefault(); finishTextEdit(false); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishTextEdit(true); return; }
      return;
    }
    if (cropItem) {
      if (e.key === "Escape") { e.preventDefault(); commitCrop(false); return; }
      if (e.key === "Enter") { e.preventDefault(); commitCrop(true); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); handleSave(false); return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selected = new Set(items.map(i => i.id)); requestDraw(false, true); return; }
    if (mod && e.key.toLowerCase() === "c") { if (!selected.size) return; e.preventDefault(); copySelected(); toast(`Copied ${selected.size} item${selected.size > 1 ? "s" : ""}`); return; }
    if (mod && e.key.toLowerCase() === "x") { if (!selected.size) return; e.preventDefault(); copySelected(); deleteSelected(); return; }
    // Ctrl/Cmd+V is deliberately not handled here — the native "paste" event carries clipboardData
    // (needed for external images), so onPaste() handles it instead.
    if (mod && e.key.toLowerCase() === "v") return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
    if (e.key.toLowerCase() === "t") { addText(); return; }
    if (e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); enterCrop(); return; }
    if (e.key === "Escape") { selected.clear(); requestDraw(false, true); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!selected.size) return;
      e.preventDefault();
      snapshot();
      const step = e.shiftKey ? 10 : 1;
      for (const i of selectionActionItems()) {
        if (e.key === "ArrowLeft") i.x -= step;
        if (e.key === "ArrowRight") i.x += step;
        if (e.key === "ArrowUp") i.y -= step;
        if (e.key === "ArrowDown") i.y += step;
      }
      requestDraw(true, true);
    }
  };

  viewport.addEventListener("pointerleave", onPointerLeave);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMoveTrack);
  window.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("pointerdown", onDocPointerDownCapture, true);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("dblclick", onDblClick);
  viewport.addEventListener("dragenter", onDragEnterOver, true);
  viewport.addEventListener("dragover", onDragEnterOver, true);
  viewport.addEventListener("drop", onDrop, true);
  imageInput.addEventListener("change", onImageInputChange);
  viewport.addEventListener("paste", onPaste);
  window.addEventListener("keydown", onKeyDown);
  resizeCanvas();

  return {
    async loadFromBytes(bytes, filename) { await loadFromBytes(bytes, filename); },
    async getBytes() { return getBytes(); },
    focus() { viewport.focus(); },
    refreshTheme() { resolveTheme(); sceneCache = null; sceneCacheKey = ""; requestDraw(true, true); },
    destroy() {
      destroyed = true;
      resizeObserver.disconnect();
      viewport.removeEventListener("pointerleave", onPointerLeave);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMoveTrack);
      window.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerdown", onDocPointerDownCapture, true);
      viewport.removeEventListener("wheel", onWheel as any);
      viewport.removeEventListener("dblclick", onDblClick);
      viewport.removeEventListener("dragenter", onDragEnterOver, true);
      viewport.removeEventListener("dragover", onDragEnterOver, true);
      viewport.removeEventListener("drop", onDrop, true);
      imageInput.removeEventListener("change", onImageInputChange);
      viewport.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown);
      if (beeDb) closeBee(beeDb);
      for (const i of items) if (i.imageUrl) URL.revokeObjectURL(i.imageUrl);
      root.empty ? root.empty() : (root.innerHTML = "");
    },
  };
}
