import { addIcon, MarkdownPostProcessorContext, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { BeeBoardView, VIEW_TYPE_BEEREF } from "./view";
import { configureSqlWasm, writeBee } from "./beeFile";
import { renderBeePreview } from "./preview";
import { BeeFileSuggestModal } from "./modals";
import { BEEREF_ICON_ID, BEEREF_ICON_SVG } from "./icon";

const WASM_ASSET_PATH = "assets/sql-wasm.wasm";
const MAX_EMBED_WIDTH = 640;
const MAX_EMBED_HEIGHT = 420;
const LIVE_EMBED_POLL_MS = 500;

export default class BeeRefPlugin extends Plugin {
  async onload() {
    configureSqlWasm(async () => {
      const path = normalizePath(`${this.manifest.dir}/${WASM_ASSET_PATH}`);
      return await this.app.vault.adapter.readBinary(path);
    });

    // addIcon must run before addRibbonIcon/registerView, or the ribbon icon renders empty —
    // the icon registry has to know what "beeref" looks like before anything asks to draw it
    addIcon(BEEREF_ICON_ID, BEEREF_ICON_SVG);

    this.registerView(VIEW_TYPE_BEEREF, leaf => new BeeBoardView(leaf, this));
    this.registerExtensions(["bee"], VIEW_TYPE_BEEREF);

    this.addRibbonIcon(BEEREF_ICON_ID, "New BeeRef board", () => this.createNewBoard());

    this.addCommand({
      id: "beeref-new-board",
      name: "Create new BeeRef board",
      icon: BEEREF_ICON_ID,
      callback: () => this.createNewBoard(),
    });

    this.addCommand({
      id: "beeref-open-board",
      name: "Open a BeeRef board",
      icon: BEEREF_ICON_ID,
      callback: () => {
        const files = this.app.vault.getFiles().filter(f => f.extension === "bee");
        if (!files.length) { new Notice("No .bee files found in this vault yet."); return; }
        new BeeFileSuggestModal(this.app, files, file => { this.app.workspace.getLeaf("tab").openFile(file); }).open();
      },
    });

    this.registerMarkdownPostProcessor((el, ctx) => this.renderEmbeds(el, ctx));
    // Live Preview doesn't run markdown post-processors on its embed widgets, so a light poll
    // catches those too — cheap enough at this interval and only touches un-rendered spans
    this.registerInterval(window.setInterval(() => this.renderLiveEmbeds(), LIVE_EMBED_POLL_MS));
  }

  // Canvas-style: no naming prompt, just create "Untitled.bee" (or "Untitled N.bee") and open it
  async createNewBoard() {
    const active = this.app.workspace.getActiveFile();
    const path = this.resolveNewFilePath("Untitled", active?.parent?.path);
    try {
      const bytes = await writeBee([]);
      const file = await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (err) {
      new Notice(`Could not create board: ${(err as Error).message}`);
    }
  }

  resolveNewFilePath(rawName: string, preferFolder?: string): string {
    let name = rawName.trim() || "Untitled";
    if (!name.toLowerCase().endsWith(".bee")) name += ".bee";
    const folder = preferFolder && this.app.vault.getAbstractFileByPath(preferFolder) ? preferFolder : "";
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    const base = path.replace(/\.bee$/i, "");
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${base} ${++n}.bee`);
    return path;
  }

  private async renderEmbeds(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    for (const span of Array.from(el.querySelectorAll<HTMLElement>("span.internal-embed"))) {
      await this.maybeRenderEmbed(span, ctx.sourcePath);
    }
  }

  private renderLiveEmbeds() {
    document.querySelectorAll<HTMLElement>(".internal-embed").forEach(span => this.maybeRenderEmbed(span));
  }

  private async maybeRenderEmbed(span: HTMLElement, sourcePath?: string) {
    if (span.dataset.beerefRendered) return;
    const src = span.getAttribute("src") || span.getAttribute("alt") || "";
    if (!src.toLowerCase().endsWith(".bee")) return;
    const path = sourcePath ?? this.app.workspace.getActiveFile()?.path;
    const dest = this.app.metadataCache.getFirstLinkpathDest(src, path ?? "");
    if (!dest || !(dest instanceof TFile)) return;
    span.dataset.beerefRendered = "1";
    await this.renderOneEmbed(span, dest);
  }

  private async renderOneEmbed(span: HTMLElement, file: TFile) {
    span.empty();
    span.addClass("beeref-embed");
    const loading = span.createDiv({ cls: "beeref-embed-loading", text: `Loading ${file.name}…` });
    try {
      const bytes = await this.app.vault.readBinary(file);
      const styles = getComputedStyle(span);
      const background = styles.getPropertyValue("--background-primary").trim() || "#3c3c3c";
      const textColor = styles.getPropertyValue("--text-normal").trim() || "#c8c8c8";
      const { canvas, itemCount } = await renderBeePreview(bytes, { maxWidth: MAX_EMBED_WIDTH, maxHeight: MAX_EMBED_HEIGHT, background, textColor });
      loading.remove();
      canvas.addClass("beeref-embed-canvas");
      span.createDiv({ cls: "beeref-embed-wrap" }).appendChild(canvas);
      const caption = span.createDiv({ cls: "beeref-embed-caption" });
      caption.createSpan({ text: file.basename });
      caption.createSpan({ cls: "beeref-embed-count", text: itemCount ? ` · ${itemCount} item${itemCount === 1 ? "" : "s"}` : " · empty board" });
      span.addEventListener("click", () => this.app.workspace.getLeaf("tab").openFile(file));
    } catch (err) {
      loading.setText(`Could not preview ${file.name}`);
      console.error("BeeRef Board: embed preview failed", err);
    }
  }
}
