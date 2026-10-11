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

## Progress & goals

The ring in the toolbar opens your writing stats: words written today, this week and this month against optional goals, your streak, time spent writing, and history by day, week or month.

- Only words you type count. Pastes, undo/redo and deleting a whole file don't.
- Writing time is the time between keystrokes, ignoring pauses longer than a minute.
- A daily reminder can fire on chosen weekdays, optionally only when you're behind pace on a goal. It runs while Joyce is open (including in the background), and it's skipped if you've typed in the last 15 minutes or it's more than 2 hours late.

### Document goals

Click the word count in the bottom corner to give the open document its own length goal: **at least**, **about** (within 10%) or **at most** a number of words or characters. The count shows progress toward it, and going over a limit turns it orange and keeps it on screen while you type. Character counts ignore Markdown syntax and line breaks.

### Images

Paste a screenshot or copied image, or drag an image file in from Finder, and it's saved in an `assets` folder beside the document and linked with ordinary Markdown (`![](assets/…png)`). The image shows inline at the width of the text; put the cursor on its line to see or edit the Markdown. Moving a document to another folder takes its images along. `assets` folders don't appear in the sidebar.

## Save to GitHub

The upload button in the toolbar saves the open document as a post in a GitHub repo, the same way the site's CMS does: one commit through the GitHub API. It's set up for the Bickerstaff Media site (`AlgorhythmicIndustries/bickerstaff-media-site`, `master`, `src/content/blog/*.mdx`); **Change** points it elsewhere.

- A leading `# Heading` becomes the post title. Description, tags, author, date and file name are set in the panel and remembered per document.
- Posts are saved with `draft: true` unless you untick **Draft**. Saving again updates the same file. Front matter Joyce doesn't manage (hero image, featured…) is left alone.
- If the post was edited on GitHub (e.g. in the CMS) since Joyce last saved it, Joyce asks before overwriting.
- Sign in with **Use my GitHub CLI account** (if `gh` is logged in), or **Sign in with GitHub** using the client ID of an OAuth app with *Enable Device Flow* turned on. The token is kept in the macOS Keychain and never reaches the web UI.
- Images aren't uploaded yet, so a post containing pasted images can't be saved to GitHub (it would break the site's build). Images hosted online are fine.
