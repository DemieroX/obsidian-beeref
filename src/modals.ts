import { App, FuzzySuggestModal, Modal, Setting, TFile } from "obsidian";

export class FilenamePromptModal extends Modal {
  private value: string;
  private resolved = false;

  constructor(app: App, private title: string, private initialValue: string, private onSubmit: (name: string) => void) {
    super(app);
    this.value = initialValue;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    new Setting(contentEl).setName("File name").addText(text => {
      text.setValue(this.initialValue);
      text.onChange(v => (this.value = v));
      window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 0);
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); this.submit(); }
      });
    });
    new Setting(contentEl)
      .addButton(btn => btn.setButtonText("Create").setCta().onClick(() => this.submit()))
      .addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()));
  }

  private submit() {
    if (this.resolved) return;
    const name = this.value.trim();
    if (!name) return;
    this.resolved = true;
    this.close();
    this.onSubmit(name);
  }

  onClose() { this.contentEl.empty(); }
}

export class BeeFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private files: TFile[], private onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("Open a .bee reference board…");
  }
  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}
