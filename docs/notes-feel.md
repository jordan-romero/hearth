# Hearth — The workspace should feel like a notes app (spec)

[workspace.md](workspace.md) promises "OneNote's shape, Notion's feel". The DM's first weeks in the
workspace say the feel isn't there yet:

> _"Clicking between notes … is significantly slower than something like OneNote."_
> _"I select a name, hit Link, paste the link to an NPC page. It looks like it links, but when I
> click it nothing happens. … In OneNote I can put [[Ildin]] and it links to his page."_
> _"Dalakhi tag is missing, and the ability to add new player tags would be nice."_

This phase comes **before** session reconcile (workspace.md §7, phase 4): if writing and moving
around the notes is clumsy, the DM won't live in the workspace, and reconcile has nothing to keep
current. It also feeds reconcile: links between pages are how it will find "Ildin's page".

---

## 1 · What's wrong today

### Links don't open

`editor.tsx` configures StarterKit's Link with `openOnClick: false`. The workspace editor is always
editable (only trashed pages are read-only), and in an editable view a click on an `<a>` just places
the caret. So links are stored and styled correctly, and nothing ever follows them.

- Entering a link is a `window.prompt` for a URL: no page picker, no editing.
- `markdownToPage` and `htmlToMarkdown` keep only `http(s):` and `mailto:` hrefs, so an internal
  link Claude writes, or one that arrives in an import, becomes plain text.
- OneNote's own page links (`onenote:` hrefs) are dropped on import; literal `[[Title]]` text is
  left as text.

### Page switching is a full server round trip

- The tree uses `<Link>` with default prefetch, but there is no `loading.tsx` under `app/campaign/`,
  so the dynamic route prefetches next to nothing. Nothing changes on screen until the new page
  arrives.
- Each click runs ~7 queries in ~4 serial stages: `resolveMember` → an unused `campaign.findUnique`
  → `getPage` → (`getWorkspaceTree` _again_, every page row, just for breadcrumbs ‖ `getTableColors`).
- `router.refresh()` after a title change (and every 4s during an import) re-runs every layout.
- `staleTimes.dynamic` is the Next 15 default of 0, so revisiting a page refetches it.

### Characters can only come from Discord

The tag list (`getTableColors`) is every Character in the campaign, unfiltered. A character exists
only once its player runs `/join character:<name>`; a second `/join` renames it (one per player).
The web can recolor characters but not add one, and `Character.membershipId` is required. So a
missing tag means that character was never joined in this campaign's guild.

---

## 2 · What we're building

Ordered by what the DM feels most. Each numbered item is a shippable PR.

### 1. Links that work, and DM-added characters _(small)_

- **Clicks:** an `editorProps.handleClick` in the editor. A click on a page link navigates in-app
  (`router.push`, after flushing the pending save); ⌘/Ctrl-click on any link opens it; a plain click
  on an external link places the caret and the bubble menu shows **Open ↗**.
- `markdownToPage` keeps same-campaign workspace paths instead of stripping them.
- **Add a character** on the Table colors page (`/workspace/colors`): name + color, DM only, with a
  "+ Add" chip after the Known-by chips in the editor. `Character.membershipId` becomes optional; a
  later `/join` with the same name (case-insensitive) **claims** the unclaimed character instead of
  making a second one, so highlights already marked for it carry over.
- Fix workspace.md's "Settings → Table" to the real route.

### 2. Page links: `[[`, `@`, and backlinks _(medium)_

- **A `pageLink` node** `{ pageId, label }`: links by id, so renaming a page never breaks one; it
  shows the page's **current** title. A link to a trashed/deleted page shows struck through.
- **Typing `[[` or `@`** opens a fuzzy page picker (built on the existing `slash.ts` suggestion
  popup). The last entry is **Create "Ildin"**, which makes the page in the current folder without
  leaving the one you're writing.
- **Pasting `[[Ildin]]`** resolves by title; an unknown title becomes a dashed "create page" link.
- **Backlinks:** under each page, "Mentioned in" lists the pages linking to it. Stored as a
  `PageLink(fromPageId, toPageId)` table rewritten on save, so it's one indexed query.
- **Markdown** (what search and Claude read): a page link serializes as `[[Current Title]]`.
- **Imports and backfill:** OneNote `onenote:` links become `[[Title]]`; after an import batch, a
  second pass turns `[[Title]]` into page links once every page exists; a one-off backfill does the
  same for pages already imported.

### 3. Fast page switching, step one _(small)_

- `p/[pageId]/loading.tsx` skeleton: the click registers instantly.
- One parallel stage for the page route: auth, `getPage`, folders-only breadcrumbs, colors. Drop
  the unused campaign lookup from the DM path; `cache()` `requireMember` and the tree.
- Prefetch a page on hover/focus in the tree; `staleTimes.dynamic: 30` so revisits are instant.
  A stale revision can only cause a "changed elsewhere" conflict, never lost work (saves already
  compare-and-set), and saves refresh the cache.
- Update the sidebar title locally instead of `router.refresh()`.

### 4. Quick switcher _(small)_

⌘K / ⌘P opens a fuzzy finder over page and folder titles (the tree is already on the client).

### 5. Instant switching, step two _(large)_

One long-lived editor that swaps documents (`history.pushState`), backed by a client page store
filled in the background and on hover from a DM-only `page-data` route. Per-page revision,
debounce and undo history; re-checked with the server on open; a conflict loads the server's copy
in place. Titles show in the sidebar as they're typed. This is the OneNote feel.

### 6. Easy to learn _(small)_

The DM should be able to learn the workspace from the workspace. A "How the workspace works" card
on its front page (until hidden); a shortcuts & tips sheet (⌘/, `?`, or the sidebar); the empty
line's hint mentions `[[`; the `/` menu has "Link to a page".

### 7. Obsidian-depth linking _(medium)_

- **Hover previews:** rest on a page link (or a "Mentioned in" entry) to see how that page begins.
- **Unlinked mentions:** under "Mentioned in", the pages that name this one in plain text, each
  with **Link**, which turns those mentions into links (saved as an edit, so it's in history).
- **Heading links:** `[[Ildin#History]]`; in the picker, `#` after a page's name lists its
  headings. Opening one scrolls to the section.

### Next

The direction: as rich as Notion and OneNote, linked like Obsidian, learnable without a manual.

1. **Templates** for what a DM writes most: NPC, Location, Faction, Session prep, with "New page
   from template" and the `/` menu.
2. **Page icons** (an emoji per page, in the tree and on links) and **callout / toggle blocks**.
3. **Drag and drop in the tree:** move and reorder pages and folders.
4. **Page properties / tags** (NPC, Location, Faction; a page's status) and filtering by them.
5. **Graph view** of how pages link, alongside the campaign graph Hearth already builds.

---

## 3 · Open questions

- Should `@` link **pages** only, or also **characters** (and so double as a way to mark who knows
  something)?
- Should "Create page" from a link go in the current folder, or a fixed "Unsorted" folder?
- Should backlinks be visible to Claude ("pages that mention Ildin") as a tool, or only in the UI?
