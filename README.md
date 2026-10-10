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

## Progress & goals

The ring in the toolbar opens your writing stats: words written today, this week and this month against optional goals, your streak, time spent writing, and history by day, week or month.

- Only words you type count. Pastes, undo/redo and deleting a whole file don't.
- Writing time is the time between keystrokes, ignoring pauses longer than a minute.
- A daily reminder can fire on chosen weekdays, optionally only when you're behind pace on a goal. It runs while Joyce is open (including in the background), and it's skipped if you've typed in the last 15 minutes or it's more than 2 hours late.

## Save to GitHub

The upload button in the toolbar saves the open document as a post in a GitHub repo, the same way the site's CMS does: one commit through the GitHub API. It's set up for the Bickerstaff Media site (`AlgorhythmicIndustries/bickerstaff-media-site`, `master`, `src/content/blog/*.mdx`); **Change** points it elsewhere.

- A leading `# Heading` becomes the post title. Description, tags, author, date and file name are set in the panel and remembered per document.
- Posts are saved with `draft: true` unless you untick **Draft**. Saving again updates the same file. Front matter Joyce doesn't manage (hero image, featured…) is left alone.
- If the post was edited on GitHub (e.g. in the CMS) since Joyce last saved it, Joyce asks before overwriting.
- Sign in with **Use my GitHub CLI account** (if `gh` is logged in), or **Sign in with GitHub** using the client ID of an OAuth app with *Enable Device Flow* turned on. The token is kept in the macOS Keychain and never reaches the web UI.
- Images aren't uploaded yet. Local image references won't resolve on the site.
