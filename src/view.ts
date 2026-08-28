import { FileView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { mountBeeBoard, BeeBoardHandle } from "./board";
import { FilenamePromptModal } from "./modals";
import type BeeRefPlugin from "./main";

export const VIEW_TYPE_BEEREF = "beeref-board-view";
const AUTOSAVE_DELAY_MS = 900;

export class BeeBoardView extends FileView {
  private board: BeeBoardHandle | null = null;
  private autosaveTimer: number | null = null;
  private loadingToken = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: BeeRefPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_BEEREF; }
  getIcon(): string { return "beeref"; }
  getDisplayText(): string { return this.file?.basename ?? "BeeRef board"; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    this.board = mountBeeBoard(container, {
      notify: (msg, isError) => new Notice(msg, isError ? 6000 : 3000),
      onDirty: () => this.scheduleAutosave(),
      onManualSave: async bytes => { await this.flush(bytes); },
      onSaveAs: async (bytes, suggestedName) => { await this.saveAs(bytes, suggestedName); },
    });
    this.registerEvent(this.app.workspace.on("css-change", () => this.board?.refreshTheme()));
  }

  async onClose() {
    await this.flushPending();
    this.board?.destroy();
    this.board = null;
  }

  async onLoadFile(file: TFile) {
    if (!this.board) return;
    const token = ++this.loadingToken;
    const bytes = await this.app.vault.readBinary(file);
    if (token !== this.loadingToken) return; // a newer file load started while we were reading
    await this.board.loadFromBytes(bytes, file.name);
    this.board.focus();
  }

  async onUnloadFile() {
    await this.flushPending();
  }

  private scheduleAutosave() {
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => { this.autosaveTimer = null; this.autosaveNow(); }, AUTOSAVE_DELAY_MS);
  }

  private async autosaveNow() {
    if (!this.board || !this.file) return;
    try {
      const bytes = await this.board.getBytes();
      await this.app.vault.modifyBinary(this.file, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch (err) {
      console.error("BeeRef Board: autosave failed", err);
      new Notice(`BeeRef Board: autosave failed (${(err as Error)?.message || err}). Your last change may not be saved — try Ctrl/Cmd+S.`, 8000);
    }
  }

  // immediate write for Ctrl+S / manual save, bypassing the autosave debounce
  private async flush(bytes: Uint8Array) {
    if (this.autosaveTimer) { window.clearTimeout(this.autosaveTimer); this.autosaveTimer = null; }
    if (!this.file) return;
    await this.app.vault.modifyBinary(this.file, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  private async flushPending() {
    if (this.autosaveTimer) { window.clearTimeout(this.autosaveTimer); this.autosaveTimer = null; await this.autosaveNow(); }
  }

  private async saveAs(bytes: Uint8Array, suggestedName: string) {
    new FilenamePromptModal(this.app, "Save board as", suggestedName.replace(/\.bee$/i, ""), async name => {
      const path = this.plugin.resolveNewFilePath(name, this.file?.parent?.path);
      try {
        const created = await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        new Notice(`Saved as ${created.path}`);
        await this.app.workspace.getLeaf("tab").openFile(created);
      } catch (err) {
        new Notice(`Could not save as ${path}: ${(err as Error).message}`);
      }
    }).open();
  }
}
