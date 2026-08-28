<img width="1280" height="670" alt="obsidian-beeref-banner" src="https://github.com/user-attachments/assets/83d75682-1e6d-4801-bd7d-afb8afbc61c8" />

# BeeRef Integration for Obsidian

Open, edit and save [BeeRef](https://github.com/rbreu/beeref) (`.bee`) reference boards directly inside Obsidian.

## Features

- Open `.bee` files in a dedicated view: pan/zoom, move, scale, rotate, flip, crop, text notes, grayscale, opacity, undo/redo.
- Autosave to the vault (~1s) after each change.
- Paste or drag in images from outside Obsidian (files, browser images, or a copied URL).
- `![[board.bee]]` embeds render as a static preview thumbnail.

## Install

Copy the `beeref-board/` folder into `<vault>/.obsidian/plugins/`, then enable **BeeRef Integration** in Settings → Community plugins.

## Build from Source

```bash
npm install
npm run build
```

This writes `main.js`. Copy it alongside `manifest.json`, `styles.css`, `versions.json` and `assets/` into your vault's plugin folder.

## Usage

- Ribbon icon or **Create new BeeRef board** command creates an empty board.
- **Open a BeeRef board** command opens a fuzzy picker over every `.bee` file in the vault.
- Right-click the canvas for the context menu (cut/copy/paste, insert image, add text, ordering, flip, grayscale, opacity, crop).

## Source Overview

- `src/beeFile.ts` — SQLite (.bee) read/write via sql.js.
- `src/board.ts` — the canvas engine (input handling, drawing, undo/redo, clipboard).
- `src/view.ts` — the Obsidian `FileView` that hosts a board and handles autosave.
- `src/main.ts` — plugin entry point: icon, ribbon, commands, embed rendering.
- `src/preview.ts` — static thumbnail renderer used for `![[...]]` embeds.
- `src/modals.ts` — filename prompt and `.bee` file picker modals.
- `src/icon.ts` — the custom ribbon/tab icon.

---

## Credits & License

<img align="left" width="100" height="100" src="https://github.com/user-attachments/assets/571ff94c-c732-46c6-b5be-959e8186d541"/>

This Obsidian plugin includes a web port of **[BeeRef](https://github.com/rbreu/beeref)**, originally created by its contributors.

This project is open-source and released under the **GNU General Public License v3.0 (GPLv3)** in accordance with the original software's license. See the [LICENSE](./LICENSE) file for details.
