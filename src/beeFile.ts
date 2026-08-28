import initSqlJs, { Database } from "sql.js";

export const APPLICATION_ID = 2060242126;
export const USER_VERSION = 2;

export type BeeItemType = "pixmap" | "text" | "error";
export type CanvasImage = HTMLImageElement | ImageBitmap;

export interface BeeItem {
  id: number;
  type: BeeItemType;
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  flip: number;
  data: Record<string, any>;
  imageBytes?: Uint8Array;
  imageUrl?: string;
  image?: CanvasImage;
  imageWidth?: number;
  imageHeight?: number;
  filename?: string;
  crop?: [number, number, number, number];
  opacity?: number;
  grayscale?: boolean;
  text?: string;
  originalSaveId?: number;
}

export type WasmLoader = () => Promise<ArrayBuffer>;

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
let wasmLoader: WasmLoader | null = null;

// called once by the plugin with a loader for the sql.js wasm binary
export function configureSqlWasm(loader: WasmLoader) {
  wasmLoader = loader;
  sqlPromise = null;
}

async function getSQL() {
  if (!sqlPromise) {
    if (!wasmLoader) throw new Error("beeFile: configureSqlWasm() was not called before use");
    sqlPromise = initSqlJs({ wasmBinary: await wasmLoader() });
  }
  return sqlPromise;
}

function parseJSON(value: string | null | undefined): Record<string, any> {
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    return {};
  }
}

export async function readBee(bytes: ArrayBuffer, hydrate = false): Promise<{ db: Database; items: BeeItem[] }> {
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(bytes));
  const tables = (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map((r: any) => r[0]);
  if (!tables.includes("items")) throw new Error("Not a BeeRef file: items table missing");

  const version = Number(db.exec("PRAGMA user_version")[0]?.values?.[0]?.[0] ?? 0);
  if (version > USER_VERSION) throw new Error(`BeeRef file version ${version} is newer than supported version ${USER_VERSION}`);

  // pixmap rows join the blob stored in sqlar; text rows have no blob, so they're read separately
  const imageRows = db.exec(`SELECT items.id,type,x,y,z,scale,rotation,flip,items.data,sqlar.data
    FROM sqlar JOIN items ON sqlar.item_id=items.id ORDER BY z,id`)[0]?.values ?? [];
  const textRows = db.exec("SELECT id,type,x,y,z,scale,rotation,flip,data,null FROM items WHERE type='text' ORDER BY z,id")[0]?.values ?? [];
  const rows = [...imageRows, ...textRows];

  const items: BeeItem[] = [];
  for (const row of rows as any[][]) {
    const [id, type, x, y, z, scale, rotation, flip, raw, blob] = row;
    const data = parseJSON(raw);
    const item: BeeItem = {
      id: Number(id),
      type: type as BeeItemType,
      x: Number(x) || 0,
      y: Number(y) || 0,
      z: Number(z) || 0,
      scale: Number(scale) || 1,
      rotation: Number(rotation) || 0,
      flip: Number(flip) || 1,
      data,
      originalSaveId: Number(id),
    };
    if (type === "text") {
      item.text = String(data.text ?? "");
    } else if (type === "pixmap") {
      item.imageBytes = blob ? new Uint8Array(blob) : undefined;
      item.filename = String(data.filename ?? "");
      item.crop = Array.isArray(data.crop) && data.crop.length === 4 ? ([...data.crop] as [number, number, number, number]) : undefined;
      item.opacity = typeof data.opacity === "number" ? data.opacity : 1;
      item.grayscale = !!data.grayscale;
    } else {
      item.text = String(data.text ?? "BeeRef could not load this item");
    }
    items.push(item);
  }

  if (hydrate) {
    await Promise.all(items.filter(i => i.type === "pixmap" && i.imageBytes?.length).map(i => hydrateImage(i)));
  }
  return { db, items: items.sort((a, b) => a.z - b.z || a.id - b.id) };
}

export async function hydrateImage(item: BeeItem) {
  if (!item.imageBytes?.length) return;
  const blob = new Blob([item.imageBytes as BlobPart]);
  item.imageUrl = URL.createObjectURL(blob);
  try {
    if (typeof createImageBitmap === "function") {
      item.image = await createImageBitmap(blob);
    } else {
      const img = new Image();
      await new Promise<void>(resolve => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = item.imageUrl!; });
      item.image = img;
    }
  } catch {
    const img = new Image();
    await new Promise<void>(resolve => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = item.imageUrl!; });
    item.image = img;
  }
  item.imageWidth = (item.image as any)?.naturalWidth ?? (item.image as ImageBitmap).width ?? 0;
  item.imageHeight = (item.image as any)?.naturalHeight ?? (item.image as ImageBitmap).height ?? 0;
  if (!item.crop || item.crop[2] <= 0 || item.crop[3] <= 0) item.crop = [0, 0, item.imageWidth, item.imageHeight];
}

export async function addImageItem(bytes: Uint8Array, name: string): Promise<BeeItem> {
  const item: BeeItem = {
    id: 0, type: "pixmap", x: 0, y: 0, z: 0, scale: 1, rotation: 0, flip: 1,
    data: { filename: name, opacity: 1, grayscale: false }, imageBytes: bytes, filename: name, opacity: 1, grayscale: false,
  };
  await hydrateImage(item);
  item.crop = [0, 0, item.imageWidth || 0, item.imageHeight || 0];
  item.data = { filename: name, opacity: 1, grayscale: false, crop: item.crop };
  return item;
}

const SCHEMA = [
  "CREATE TABLE items (id INTEGER PRIMARY KEY,type TEXT NOT NULL,x REAL DEFAULT 0,y REAL DEFAULT 0,z REAL DEFAULT 0,scale REAL DEFAULT 1,rotation REAL DEFAULT 0,flip INTEGER DEFAULT 1,data JSON)",
  "CREATE TABLE sqlar (name TEXT PRIMARY KEY,item_id INTEGER NOT NULL UNIQUE,mode INT,mtime INT default current_timestamp,sz INT,data BLOB,FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE ON UPDATE NO ACTION)",
];

export async function writeBee(items: BeeItem[], existing?: Database): Promise<Uint8Array> {
  const SQL = await getSQL();
  const db = existing || new SQL.Database();
  if (!existing) {
    db.run(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${USER_VERSION}; PRAGMA foreign_keys=ON;`);
    SCHEMA.forEach(s => db.run(s));
  }
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM sqlar");
    db.run("DELETE FROM items");
    for (const item of [...items].sort((a, b) => a.z - b.z || a.id - b.id)) {
      const data = { ...item.data };
      if (item.type === "pixmap") {
        data.filename = data.filename ?? item.filename ?? "image.png";
        data.opacity = item.opacity ?? 1;
        data.grayscale = !!item.grayscale;
        data.crop = item.crop ?? [0, 0, item.imageWidth ?? 0, item.imageHeight ?? 0];
      } else if (item.type === "text") {
        data.text = item.text ?? "";
      }
      // OR REPLACE: a stray id collision overwrites the row instead of throwing and rolling back the whole save
      db.run("INSERT OR REPLACE INTO items(id,type,x,y,z,scale,rotation,flip,data) VALUES(?,?,?,?,?,?,?,?,?)",
        [item.id || null, item.type, item.x, item.y, item.z, item.scale, item.rotation, item.flip, JSON.stringify(data)]);
      if (item.type === "pixmap" && item.imageBytes) {
        const name = String(data.filename || `image-${item.id}.png`);
        db.run("INSERT OR REPLACE INTO sqlar(item_id,name,mode,sz,data) VALUES(?,?,?,?,?)", [item.id, name, 0o644, item.imageBytes.length, item.imageBytes]);
      }
    }
    db.run(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${USER_VERSION}; PRAGMA foreign_keys=ON;`);
    db.run("COMMIT");
    return db.export();
  } catch (err) {
    try { db.run("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

export function closeBee(db?: Database) {
  try { db?.close(); } catch { /* ignore */ }
}
