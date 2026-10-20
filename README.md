<img src="assets/icon.svg" width="64" height="64" alt="">

# Joyce

A quiet, distraction-free Markdown writing app. Your documents are plain `.md` files in a folder you choose — no library, no lock-in, no subscription.

## Running

```sh
npm install
npm run app        # native app with hot reload (Tauri)
npm run app:build  # builds src-tauri/target/release/bundle/macos/Joyce.app
npm run app:install  # builds, then replaces /Applications/Joyce.app and relaunches it
npm run dev        # UI only, in a browser, backed by a fake localStorage folder
```

## Shortcuts

| | |
|---|---|
| ⌘B / ⌘I / ⇧⌘X | Bold / italic / strikethrough |
| ⌘1 ⌘2 ⌘3 / ⌘0 | Heading level / plain paragraph |
| ⇧⌘8 / ⇧⌘7 / ⇧⌘9 | Bullets / numbered list / quote |
| ⌘K / ⌘E | Link / inline code |
| ⌘N / ⇧⌘N | New document / new folder |
| ⌘\ | Toggle sidebar |

## Projects

For longer pieces, a **project** keeps chapters or sections as separate documents in an order you choose, and stitches them back into one continuous piece of writing.

- **New project** in the sidebar header (or right-click → New Project) creates one with a first section. Any folder can become one with right-click → **Make Into Project**.
- Drag sections to reorder them; a line shows where they'll land. Drag documents in and out of a project like any folder. ⌘N adds a section after the one you're editing.
- Folders inside a project are **parts** (e.g. Part One → chapters), ordered and compiled in place.
- Sections can have **sub-sections**, nested as deep as you like: drag a section onto the middle of another (its top or bottom edge places it before or after instead), or right-click → New Sub-section. Moving a section takes its sub-sections along; trashing one moves its sub-sections up into its place.
- Give any section or part an **icon**: click the dot beside its name (or right-click → Icon…) and pick a symbol and a color. Icons show in the sidebar and the continuous view.
- Click a project's name to read it as one continuous document, with a marker at each section. Click a marker to edit that section.
- The outline (order, nesting, icons) lives in a hidden `.joyce.json` in the project folder. Sections stay ordinary Markdown files side by side, and losing that file only loses the outline.

## Themes

**Aa** offers Auto (follows macOS light/dark), Light, Cream (the app icon's paper and ink), Sepia and Dark.

## Idea canvas

The connected-card button in the toolbar (⇧⌘M / Ctrl+Shift+M) opens an infinite canvas in a right-hand sidebar beside your writing. The expand button fills the workspace with the canvas; click the dock button to return it to the sidebar. It starts closed each time Joyce launches and opens in the sidebar, remembering your position when you reopen it. Your document keeps its cursor, scroll position, and undo history while you think on the canvas, and the sidebar stays open as you switch documents. Keyboard shortcuts apply to the writing panel or canvas you’re using.

- Double-click empty space or choose **Add card** to jot down an idea. Double-click a card or press Enter to edit it; Escape finishes editing.
- Choose the globe button (**Add website**) to add a bookmark in a standard-sized card. Joyce requests the mobile site and shows a static preview. Drag it like any card; double-click it or press Enter to open it in your default browser. Hover for **Edit website URL** (also edits the title), appearance, preview refresh, duplicate, connect, and delete. Sites that require JavaScript, block requests, or are offline can still be opened when their preview is unavailable.
- Drag the divider along the canvas’s left edge to resize the sidebar; its width is remembered. Double-click the divider to reset it, or focus it and use the arrow keys (Shift for larger steps). Maximizing and restoring keeps your sidebar width.
- Drag cards to arrange them. Shift-click selects several; arrow keys move the selection. Drag the three diagonal dots at a card’s lower-right corner to resize it, or focus the handle and use the arrow keys.
- Hover or focus a card for its edit menu: move, edit, icon/color, three text sizes, duplicate, connect, and delete. **Fit to content** is in the appearance menu.
- Drag a card’s side dot onto another card to connect them, or choose **Connect** and click a destination. Keyboard users can press C, focus another card, and press Enter. Select a connection to toggle an arrow or delete it.
- Pan by dragging the background, Space-dragging, or scrolling in either direction. Pinch or hold ⌘/Ctrl while scrolling to zoom. **Fit** (F) brings the cards into view; the percentage button resets zoom to 100%.
- The minimap shows the cards and current viewport. Click to jump or drag the viewport to navigate. The **?** button lists shortcuts.
- ⌘/Ctrl+Z undoes board actions; Shift+⌘/Ctrl+Z redoes them. An active text field keeps its own text undo. Canvas ideas do not count toward document writing goals.

Each project has its own canvas, which switches as you move between projects; documents outside any project share the writing folder’s canvas. Cards and connections are saved as readable, versioned JSON in the project’s `.joyce/canvas.json` (or the writing folder’s), so a board moves and syncs with its project. Camera position stays on each computer. Sync preserves conflicting canvas versions; **Recovered versions** lets you preview and restore them, backing up the current board first. Save failures keep your ideas in memory and show a Retry action. Reduced-motion preferences disable the grid’s simulated indentation.

Run `npm test` (Node 22.18+ or 24+) for the canvas geometry, undo, saving, validation, and recovery tests. `npm run build` checks TypeScript and builds the UI; `cd src-tauri` followed by `cargo test --lib` checks the native storage and sync behavior.

## Progress & goals

The ring in the toolbar opens your writing stats: words written today, this week and this month against optional goals, your streak, time spent writing, and history by day, week or month.

- Only words you type count. Pastes, undo/redo and deleting a whole file don't.
- Writing time is the time between keystrokes, ignoring pauses longer than a minute.
- A daily reminder can fire on chosen weekdays, optionally only when you're behind pace on a goal. It runs while Joyce is open (including in the background), and it's skipped if you've typed in the last 15 minutes or it's more than 2 hours late.

### Document goals

Click the word count in the bottom corner to give the open document its own length goal: **at least**, **about** (within 10%) or **at most** a number of words or characters. The count shows progress toward it, and going over a limit turns it orange and keeps it on screen while you type. Character counts ignore Markdown syntax and line breaks.

### Images

Paste a screenshot or copied image, or drag an image file in from Finder, and it's saved in an `assets` folder beside the document and linked with ordinary Markdown (`![](assets/…png)`). The image shows inline at the width of the text; put the cursor on its line to see or edit the Markdown. Moving a document to another folder takes its images along. `assets` folders don't appear in the sidebar.

## Sync

Keeps a writing folder the same on all your computers, through a small server you deploy to your own Cloudflare account (Workers Free plan). Everything is **end-to-end encrypted**: Joyce encrypts contents and file names before upload, so the server only stores ciphertext and opaque ids.

- **Cloud button → Sync.** On the first computer: *Start syncing this folder*. Then *Show a pairing code*, and on the next computer (with a folder open): *Join with a code*.
- Changes go up a couple of seconds after you stop typing and arrive on other computers within seconds. Offline edits sync when you're back.
- If two computers change the same document before syncing, nothing is lost: the other version is saved beside it as `Name (conflict from Computer).md`.
- Goals, stats, document goals and GitHub links live in a hidden `.joyce/` folder in the writing folder, so they travel too. Each computer keeps its own stats file; totals add them up.
- Remove a lost computer from the Sync panel, and it can't sync any more.

### Deploying the server

```sh
cd sync-server
npm install
# .env (git-ignored) with an API token from the Cloudflare account to deploy to:
#   CLOUDFLARE_API_TOKEN=…   (template: "Edit Cloudflare Workers")
#   CLOUDFLARE_ACCOUNT_ID=…
npm run deploy
```

Joyce defaults to `https://joyce-sync.7vwvwnd56t.workers.dev` (set in `src/sync.ts`). The first computer to start syncing claims the server; after that, new computers can only join with a pairing code. To point a build elsewhere, set `VITE_JOYCE_SYNC_SERVER` when building.

## Publish to a site

The upload button publishes the open document as an entry on sites managed with **[Pages CMS](https://pagescms.org)**, **[Sveltia CMS](https://sveltiacms.app)**, or Decap/Netlify CMS. Those sites keep content in GitHub and describe it in `.pages.yml` (Pages) or `admin/config.yml` (Sveltia/Decap); Joyce reads the config to build the publishing form.

- **Add a site** by its GitHub repository (`owner/name` or URL). Joyce finds Sveltia/Decap configs under admin or cms folders, or Pages's root `.pages.yml`. Choose a CMS explicitly when the repo has both; automatic detection checks Sveltia/Decap first. Pages publishes to that repo's default branch; Sveltia/Decap can name a different content repo and branch in their config.
- Pick a **content type** (the CMS's folder collections, e.g. Blog or Podcast). The form is built from its fields: text, dates, toggles, numbers, choices, simple lists and single images (like a hero or cover), with the CMS's own labels and hints. Fields Joyce can't edit (galleries, relations, nested objects) are kept exactly as they are.
- File names follow the collection's template (`{{slug}}`, `ep-{{fields.episodeNumber}}`, `{{year}}-{{month}}-{{slug}}` for Sveltia/Decap; `{primary}`, `{fields.title}`, `{year}-{month}-{day}-{primary}.md` for Pages), and front matter is written in the CMS's field order.
- Pages supports Markdown folder collections with YAML front matter, including grouped collections and reusable field components. `view.primary` selects the title field, and date fields use Pages's date-fns formats. Fixed files, other serialization formats, custom front matter delimiters, and collections without a Markdown body are shown as unsupported.
- A leading `# Heading` becomes the title. Saving again updates the same entry, starting from any edits made in the CMS since. If the entry changed on GitHub since Joyce last saved it, Joyce asks before overwriting.
- Collections with a `draft` toggle save drafts by default; Joyce warns before publishing.
- Joyce won't create entries that would lack a required field it can't fill (like a podcast's audio upload), since that can break the site's build; create those in the CMS, and Joyce can update their text.
- Sign in with **Use my GitHub CLI account** (if `gh` is logged in), or **Sign in with GitHub** using the client ID of an OAuth app with *Enable Device Flow* on. The token stays in the system's secure storage.
- Pasted images, and images chosen for image fields, are uploaded in the same commit as the entry, to the folder the CMS would use: `media_folder`/`public_folder` for Sveltia/Decap, or the `media` source (and an image field's `options.media` and `options.path`) for Pages. Images already on the site aren't uploaded again. If the config doesn't say where images go, remove them or use images hosted online.
