# Hearth — The DM Workspace (spec)

Hearth becomes the DM's **source of truth**: where the campaign is written, organised, searched
and kept current. Other tools (OneNote, folders of files) are a one-time backfill. Claude works
_inside_ the workspace, reading and writing the DM's pages the way he uses Claude today, except
Hearth stores, manages and versions everything.

> The test case: _"I'm writing the Emperor's speech in Hearth, I search for 5 NPCs that fit the
> context, and I insert them into the document."_

Everything here sits on the existing rules in [architecture.md](architecture.md): the permission
filter wraps every read, `core` stays pure, apps stay thin.

---

## 1 · Three kinds of information

Every piece of campaign text is in exactly one state:

| State               | Meaning                                                 | Who can see it                  |
| ------------------- | ------------------------------------------------------- | ------------------------------- |
| **Working**         | Scratch, drafts, prepared story that hasn't come up yet | DM only; never treated as true  |
| **Canon · unknown** | True in the world; the party doesn't know it            | DM only                         |
| **Canon · known**   | True, and some or all of the table knows it             | Exactly the characters who know |

Two independent dimensions, so the model stays simple:

- **Canon** (new): `WORKING | CANON`.
- **Who knows** (exists today): `BaseVisibility` + `KnowledgeGrant` to characters/parties.

"Canon · unknown" = `CANON` + DM_ONLY with no grants. "Canon · known" = `CANON` + grants or EVERYONE.
Working information is **never** shown to a player, whatever its grants, and answers that draw on
it say so ("from your prep, not yet canon").

### Where information starts

| Source                                   | Starts as                                                            |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Something said at the table              | Canon · known by everyone present                                    |
| …in a private channel / told privately   | Canon · known by exactly those characters (as #66 does today)        |
| Uploaded / imported material (NPC bios…) | **Working** — the "limbo" until it happens at the table or is marked |
| A page the DM writes                     | The page's default (set per page/folder; Working unless chosen)      |

### What happens at the table wins

Order of authority: **played > DM-marked canon > working.** When a session contradicts a page (a
background changes, an NPC dies), the page is updated to match and the old text is kept in its
version history, marked _changed by Session 14_. Built on the existing `Correction` supersede
mechanism, extended from facts to page text.

---

## 2 · The workspace

### Structure — OneNote's shape, Notion's feel

- **Folders** nest freely (OneNote notebook → section → page maps directly onto folder → folder →
  page). Sidebar tree, drag to reorder/move, rename inline.
- **Pages** are rich-text documents: headings, lists, checklists, tables, quotes, callouts,
  dividers, images; `/` opens a block menu; markdown shortcuts (`#`, `-`, `**`) work as you type.
- Autosave. Every save is a **version**; history shows who/what changed it (DM, Claude, or
  "Session 14") with a diff and one-click restore.
- Editor: **TipTap (ProseMirror)**. Content stored as ProseMirror JSON (lossless, keeps highlight
  marks), with a derived markdown copy for search, Claude and ingestion.

### Character colors

The DM assigns each character a color, plus one for the party. Used **everywhere** the same way:
page highlights, transcripts, character pages, the Ask tab, Claude's answers. Set on the
workspace's **Table colors** page (`/workspace/colors`), where the DM can also add a character
before its player joins (their `/join` with the same name claims it).

### Highlights

Highlights are editor marks anchored to the text (they move with edits, not by character offset).

| State           | Looks like                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Working         | No highlight (a page's default) or a faint dotted underline                                             |
| Canon · unknown | Neutral highlight                                                                                       |
| Canon · known   | The color of who knows it: party color = everyone; one character's color = only them; several = striped |

Manual: select text → **Mark as canon** / **Known by…** (character chips in their colors) /
**Back to working**. Every highlight records who/what set it (DM, Session 14, live, voice).

### How highlights reach the memory (and the permission filter)

- Each **canon highlight is a `KnowledgeUnit`** (content = the highlighted text, `canon = CANON`,
  visibility/grants = who knows). That is the _only_ way page text reaches a player, so the filter
  is unchanged: players see units they've been granted, nothing else.
- The rest of the page is indexed **DM-only** for search and Claude (a page is a `SourceDocument`
  keyed `page:<id>` through the existing external-document path), never surfaced to players.
- Editing inside a highlight updates its unit in place, so a reveal survives rewording. Deleting
  the highlighted text retires the unit but keeps what a player was already shown (as document
  versioning does today).

---

## 3 · Session-driven updates

After every session (and, in a later phase, live during it) Hearth **reconciles** what happened with
the pages. For each new fact from the transcript:

1. **Search first.** Find where the pages already say it (semantic + exact search, verified
   against the page text the way `FactSource` verifies quotes).
2. **Already there** → highlight that passage as canon, known by whoever learned it.
3. **Contradicted** → rewrite the passage to match (played wins), old text kept in history.
4. **Missing** → add it to the right page: the entity's page via the campaign graph, else the
   session's log page. **Never duplicate**: only add what step 1 didn't find.

### Reviewing what changed

A **"Session 14 changes"** review, opened from the session and from a badge on the workspace:

- Every change in one list, grouped by page: _highlighted_, _rewrote_, _added_.
- Inline diff per change, with the transcript line that caused it (click to hear/read context).
- **Keep** / **Edit** (in place) / **Undo** for each, or **Keep all**.
- Confident changes are applied and listed here; uncertain matches are held as **suggestions**
  in the same list ("Did this come up?") until the DM decides.

### Live, and "Hearth, mark this"

- **Live:** with live transcription on, the same reconcile runs on rolling windows and pushes
  highlight changes to the open page in real time (Supabase Realtime). Same review list after.
- **Voice:** when **the DM's voice** (speaker = the DM's Discord account; players can't trigger it)
  says _"Hearth, mark this"_, Hearth takes the last ~60 seconds, works out what "this" is, and runs
  the reconcile on it immediately: highlight if present, add-then-highlight if not.

---

## 4 · Claude in the workspace

A side panel next to the open page: a conversation that knows the page and the whole campaign.
Uses **Hearth's Anthropic API key** for now (the existing `ANTHROPIC_API_KEY`).

Tools Claude gets (all DM-scoped, through the same filter):

- `search_campaign(query, filters)` — pages, transcripts, recaps, facts; canon/working aware.
- `read_page(id)`, `list_folder(id)`, `get_entity(name)` (graph: who's connected to whom).
- `propose_edit(page, at: cursor | selection | end, content)` — returns a preview; **nothing is
  written until the DM clicks Insert / Replace**.

Answers cite their sources (page, session) and label working material as prep. The Emperor's
speech flow: write → ask "5 NPCs who'd be in the crowd for this, given the Shepherds" → Claude
searches, returns 5 with reasons and sources → **Insert** at cursor.

---

## 5 · One-time imports (backfill)

An **Import** screen: choose a source → preview the folder tree it will create → choose where it
goes → import. Everything imported starts **Working**.

- **Files / a folder from the computer:** folder structure → folders; `.md .txt .docx .pdf` →
  pages (original file attached for download; layout from PDFs/DOCX is not preserved).
- **OneNote:** notebook → folder, section (and section group) → subfolder, page → page.
  Microsoft sign-in once, for the import; no ongoing sync.

Reuses from the closed #73 (branch `feat/dm-imports`): the folder uploader, Microsoft Graph
client and sign-in, token sealing, OneNote HTML → markdown.

---

## 6 · Data model (additions)

```
Folder        id, campaignId, parentId?, name, position
Page          id, campaignId, folderId?, title, content Json (ProseMirror), markdown,
              defaultState (WORKING | CANON), sourceDocumentId (page:<id> index), position
PageVersion   id, pageId, content Json, markdown, cause (DM | CLAUDE | SESSION | IMPORT),
              gameSessionId?, createdAt
Highlight     id, pageId, unitId (KnowledgeUnit), setBy (DM | SESSION | LIVE | VOICE), gameSessionId?
PageChange    id, pageId, gameSessionId, kind (HIGHLIGHT | REWRITE | ADD), status (APPLIED |
              SUGGESTED | UNDONE | EDITED), before?, after?, transcriptSegmentId?, confidence
KnowledgeUnit + canon (WORKING | CANON)
Character     + color;  Party + color
```

`core` gets the canon rule (working is never player-visible) as a pure function, tested like the
rest of the filter.

---

## 7 · Phases (each shippable on its own)

1. **Workspace** — folders, pages, editor, autosave + versions, three states, manual highlights,
   character colors, page → memory indexing. _Done when: the DM can organise and write his
   campaign in Hearth and mark what's canon and who knows it._
2. **Imports** — files/folders and OneNote, one-time, into folders. _Done when: his OneNote and
   local files are in Hearth with their structure._
3. **Claude in the workspace** — panel, tools, insert/replace. _Done when: the Emperor's speech
   flow works end to end._
4. **Session reconcile + review** — after-session updates and the review list. _Done when: after a
   session he opens one list, sees every change, and keeps/edits/undoes them._
5. **Live + voice** — real-time highlights and "Hearth, mark this".

## Open questions

- Should a page's **default state** be set per folder too (e.g. everything in "Prep" is Working,
  everything in "World" is Canon · unknown)?
- Do players get a read-only view of **pages** (only their canon-known highlights, in context), or
  only the extracted knowledge they see today?
- Images in pages: stored in Supabase Storage and shown to the DM; do revealed handouts (maps)
  belong in this phase or later?
