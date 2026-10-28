"use client";

// The page editor. Rich text the way Notion does it: type, use markdown shortcuts (# , - , [] ,
// > , ```), or press / for a menu of blocks; select text for a formatting bar. Saves itself a
// moment after you stop typing.
//
// Saves carry the revision this editor last saw. If the page changed elsewhere in the meantime
// (another tab, a restore), the save is refused and the DM is told instead of either copy
// silently winning.
//
// Links: a click on a link to another Hearth page goes there; ⌘/Ctrl-click opens any link in a new
// tab. A plain click on a web link just places the cursor (it's text being edited); the formatting
// bar offers Open. Page links ([[ or @) are in page-link.ts; clicking a dashed one (no such page
// yet) creates the page and opens it.

import { useRouter } from "next/navigation";
import { EditorState } from "@tiptap/pm/state";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import type { PmNode } from "@hearth/agents";
import {
  createLinkedPageAction,
  savePageAction,
  setPageIconAction,
} from "../../actions";
import {
  fetchDocs,
  getDoc,
  savedDoc,
  setIcon,
  setTitle as showTitle,
  type PageDoc,
} from "../../page-store";
import { SlashCommand } from "./slash";
import { headingsOf, PageLink, setLinkTarget, type PageRef } from "./page-link";
import { LinkPreview } from "./link-preview";
import {
  Callout,
  IconButton,
  isEmptyDoc,
  TemplateChips,
  type Template,
} from "./page-extras";
import { scrollToHeading } from "../../workspace-context";
import { AssistantPanel } from "./assistant-panel";
import {
  canonMark,
  clearCanon,
  currentCanon,
  setCanon,
  type HighlightColors,
} from "./canon-mark";

export interface TableCharacter {
  id: string;
  name: string;
  color: string;
}

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

const SAVE_DELAY_MS = 800;

/** What a save sends: one page's title and content, as they were when it was taken. */
interface Snapshot {
  pageId: string;
  title: string;
  content: PmNode;
}

/** A link's address as a path within Hearth, or null when it leads elsewhere. */
function hearthPath(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin
      ? url.pathname + url.search + url.hash
      : null;
  } catch {
    return null;
  }
}

/**
 * One editor for the whole workspace: opening another page swaps its document in (the editor
 * isn't rebuilt), so moving between pages is instant. Unsaved typing on the page being left is
 * saved first, and each page keeps the revision its copy was based on.
 */
export function PageEditor({
  campaignId,
  doc,
  tableColor,
  characters,
  pages,
  openPage,
}: {
  campaignId: string;
  /** The page to show. When it changes, the editor switches to it. */
  doc: PageDoc;
  tableColor: string;
  characters: TableCharacter[];
  /** Every page in the campaign, for page links. */
  pages: PageRef[];
  openPage: (id: string, heading?: string | null) => void;
}) {
  const router = useRouter();
  const base = `/campaign/${campaignId}/workspace`;
  const [pageId, setPageId] = useState(doc.id);
  const [title, setTitle] = useState(doc.title);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const readOnly = !!doc.archivedAt;
  // Refs, because the editor is made once and its handlers outlive any one render.
  const current = useRef(doc.id);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly && doc.id === current.current;
  const folderRef = useRef(doc.folderId);
  if (doc.id === current.current) folderRef.current = doc.folderId;
  /** Per page: the revision this tab's copy is based on (what a save says it replaces). */
  const revisions = useRef(new Map<string, number>([[doc.id, doc.revision]]));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(new Set<string>());
  const queued = useRef(new Map<string, Snapshot>());
  const titleRef = useRef(title);
  titleRef.current = title;
  const scheduleRef = useRef<() => void>(() => {});
  const openLinkRef = useRef<(href: string, newTab: boolean) => void>(() => {});
  // Page links read the page list through refs: pages created from a link count before the
  // server's list catches up.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const createdRef = useRef<PageRef[]>([]);
  const createPageRef = useRef<(title: string) => Promise<string | null>>(
    async () => null,
  );
  createPageRef.current = async (title) => {
    const result = await createLinkedPageAction(
      campaignId,
      folderRef.current,
      title,
    ).catch(() => null);
    if (!result?.ok) return null;
    createdRef.current = [...createdRef.current, { id: result.id, title }];
    return result.id;
  };
  openLinkRef.current = (href, newTab) => {
    const path = hearthPath(href);
    const page = path?.match(new RegExp(`^${base}/p/([^/?#]+)(?:#(.*))?$`));
    if (page && !newTab)
      openPage(
        decodeURIComponent(page[1]!),
        page[2] ? decodeURIComponent(page[2]) : null,
      );
    else if (path && !newTab) router.push(path);
    else window.open(path ?? href, "_blank", "noopener,noreferrer");
  };

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? "Heading"
            : "Write, or press / for blocks, [[ to link a page…",
      }),
      SlashCommand,
      Callout,
      PageLink.configure({
        base,
        currentPageId: () => current.current,
        pages: () => [...pagesRef.current, ...createdRef.current],
        createPage: (title) => createPageRef.current(title),
        headings: (id) => {
          const d = getDoc(id);
          return d ? headingsOf(d.content) : [];
        },
      }),
      canonMark({
        table: tableColor,
        characters: Object.fromEntries(characters.map((c) => [c.id, c.color])),
      } satisfies HighlightColors),
    ],
    content: doc.content,
    onUpdate: () => scheduleRef.current(),
    editorProps: {
      attributes: { class: "ws-prose", "aria-label": "Page content" },
      handleClick: (_view, _pos, event) => {
        if (event.button !== 0) return false;
        const target = event.target as HTMLElement | null;
        const unresolved = target?.closest?.("a[data-page-link='']");
        if (unresolved) {
          event.preventDefault();
          const label =
            unresolved.getAttribute("data-label") ??
            unresolved.textContent ??
            "";
          void createPageRef.current(label).then((id) => {
            if (!id || !editorRef.current) return;
            setLinkTarget(editorRef.current, label, id);
            openPage(id);
          });
          return true;
        }
        const a = target?.closest?.("a[href]");
        const href = a?.getAttribute("href");
        if (!href) return false;
        const newTab = event.metaKey || event.ctrlKey;
        if (!newTab && !hearthPath(href)) return false;
        event.preventDefault();
        openLinkRef.current(href, newTab);
        return true;
      },
    },
  });

  const editorRef = useRef(editor);
  editorRef.current = editor;

  /** Save one page's snapshot. A save for a page already saving waits for it, then goes. */
  const send = useCallback(
    async (snap: Snapshot): Promise<void> => {
      const id = snap.pageId;
      if (inFlight.current.has(id)) {
        queued.current.set(id, snap);
        return;
      }
      inFlight.current.add(id);
      const mine = () => current.current === id;
      if (mine()) setState("saving");
      const result = await savePageAction(campaignId, id, {
        title: snap.title,
        // As a string: the editor's JSON can hold objects React won't pass to a server action
        // as plain data.
        content: JSON.stringify(snap.content),
        baseRevision: revisions.current.get(id) ?? 0,
      }).catch(() => ({
        ok: false as const,
        error: "Couldn't save — check your connection.",
      }));
      inFlight.current.delete(id);

      if (result.ok) {
        revisions.current.set(id, result.revision);
        savedDoc(id, {
          revision: result.revision,
          title: snap.title,
          content: snap.content,
        });
        if (mine()) setError(null);
      } else if ("conflict" in result) {
        queued.current.delete(id);
        if (mine()) setState("conflict");
        return;
      } else if (mine()) {
        setState("error");
        setError(result.error);
      }
      const next = queued.current.get(id);
      if (next) {
        queued.current.delete(id);
        void send(next);
      } else if (mine() && result.ok && !timer.current) {
        setState("saved");
      }
    },
    [campaignId],
  );

  const snapshot = useCallback(
    (): Snapshot | null =>
      editor
        ? {
            pageId: current.current,
            title: titleRef.current,
            content: editor.getJSON() as PmNode,
          }
        : null,
    [editor],
  );

  /** Save now whatever is waiting to be saved. */
  const flush = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    const snap = snapshot();
    if (snap && !readOnlyRef.current) void send(snap);
  }, [send, snapshot]);

  const schedule = useCallback(() => {
    if (readOnlyRef.current) return;
    setState((s) => (s === "conflict" ? s : "dirty"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const snap = snapshot();
      if (snap) void send(snap);
    }, SAVE_DELAY_MS);
  }, [send, snapshot]);
  scheduleRef.current = schedule;

  /** Show a page: its document (with its own undo history), title and state. */
  const load = useCallback(
    (d: PageDoc) => {
      if (!editor) return;
      current.current = d.id;
      readOnlyRef.current = !!d.archivedAt;
      folderRef.current = d.folderId;
      revisions.current.set(d.id, d.revision);
      try {
        editor.view.updateState(
          EditorState.create({
            doc: editor.schema.nodeFromJSON(d.content),
            plugins: editor.state.plugins,
          }),
        );
      } catch {
        editor.commands.setContent(d.content, { emitUpdate: false });
      }
      editor.setEditable(!d.archivedAt, false);
      setPageId(d.id);
      setTitle(d.title);
      titleRef.current = d.title;
      setState("saved");
      setError(null);
      // Opened at a heading ("…/p/id#History"): go to it once the page is drawn.
      const hash = decodeURIComponent(window.location.hash.slice(1));
      if (hash) requestAnimationFrame(() => scrollToHeading(hash));
    },
    [editor],
  );

  // Opened by its address at a heading.
  useEffect(() => {
    if (!editor) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) requestAnimationFrame(() => scrollToHeading(hash));
  }, [editor]);

  // Another page opened: save what's waiting on this one, then switch.
  useEffect(() => {
    if (!editor || doc.id === current.current) return;
    flush();
    load(doc);
    window.scrollTo({ top: 0 });
  }, [editor, doc, flush, load]);

  // A newer copy of this page from the server (a restore, another tab, Claude) replaces what's on
  // screen, unless the DM has typed since: then saving reports the conflict instead.
  useEffect(() => {
    if (!editor || doc.id !== current.current) return;
    if (doc.revision <= (revisions.current.get(doc.id) ?? 0)) return;
    if (timer.current || inFlight.current.has(doc.id)) return;
    load(doc);
  }, [editor, doc, load]);

  /** After a conflict: take the server's copy of this page. */
  const reloadPage = useCallback(async () => {
    const id = current.current;
    revisions.current.set(id, -1);
    await fetchDocs(base, [id]);
    const fresh = getDoc(id);
    if (fresh) load(fresh);
  }, [base, load]);

  // Don't lose the last few keystrokes when leaving the workspace.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current || inFlight.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      flush();
    };
  }, [flush]);

  return (
    <div className="ws-editor">
      {!readOnly && (
        <button
          type="button"
          className={`asst-toggle${claudeOpen ? " on" : ""}`}
          aria-expanded={claudeOpen}
          onClick={() => setClaudeOpen((o) => !o)}
        >
          ✦ Claude
        </button>
      )}
      {claudeOpen && (
        <AssistantPanel
          key={pageId}
          campaignId={campaignId}
          pageId={pageId}
          editor={editor}
          onClose={() => setClaudeOpen(false)}
        />
      )}
      <div className="ws-status" aria-live="polite">
        {state === "saving" && "Saving…"}
        {state === "dirty" && "Editing"}
        {state === "saved" && "Saved"}
        {state === "error" && <span className="ws-status-bad">{error}</span>}
        {state === "conflict" && (
          <span className="ws-status-bad">
            This page changed somewhere else.{" "}
            <button
              type="button"
              className="ws-link"
              onClick={() => void reloadPage()}
            >
              Load that version
            </button>{" "}
            (copy anything you need first).
          </span>
        )}
      </div>
      <IconButton
        icon={doc.icon}
        readOnly={readOnly}
        onChange={(icon) => {
          setIcon(pageId, icon); // shown everywhere at once
          void setPageIconAction(campaignId, pageId, icon);
        }}
      />
      <input
        className="ws-title"
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        readOnly={readOnly}
        maxLength={200}
        onChange={(e) => {
          setTitle(e.target.value);
          titleRef.current = e.target.value;
          showTitle(pageId, e.target.value); // the sidebar follows as you type
          schedule();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            editor?.commands.focus("start");
          }
        }}
      />
      <Legend tableColor={tableColor} characters={characters} />
      {!readOnly && (
        <Templates
          editor={editor}
          onPick={(t) => {
            if (!doc.icon) {
              setIcon(pageId, t.icon);
              void setPageIconAction(campaignId, pageId, t.icon);
            }
          }}
        />
      )}
      {editor && !readOnly && (
        <FormatBar
          editor={editor}
          campaignId={campaignId}
          tableColor={tableColor}
          characters={characters}
          openLink={(href) => openLinkRef.current(href, true)}
        />
      )}
      <EditorContent editor={editor} />
      <LinkPreview base={base} />
    </div>
  );
}

/** On an empty page: start from an NPC, Location, Faction or Session template. */
function Templates({
  editor,
  onPick,
}: {
  editor: Editor | null;
  onPick: (t: Template) => void;
}) {
  const empty = useEditorState({
    editor,
    selector: ({ editor: e }) => isEmptyDoc(e),
  });
  if (!editor || !empty) return null;
  return (
    <TemplateChips
      onPick={(t) => {
        editor.chain().focus().setContent(t.html).focus("start").run();
        onPick(t);
      }}
    />
  );
}

/** Which color means who, always visible above the page. */
function Legend({
  tableColor,
  characters,
}: {
  tableColor: string;
  characters: TableCharacter[];
}) {
  return (
    <div className="ws-legend" aria-label="Highlight colors">
      <span className="ws-legend-item">
        <span className="ws-swatch dotted" /> Working
      </span>
      <span className="ws-legend-item">
        <span className="ws-swatch unknown" /> Canon, nobody knows
      </span>
      <span className="ws-legend-item">
        <span className="ws-swatch" style={{ background: tableColor }} /> Whole
        table
      </span>
      {characters.map((c) => (
        <span key={c.id} className="ws-legend-item">
          <span className="ws-swatch" style={{ background: c.color }} />{" "}
          {c.name}
        </span>
      ))}
    </div>
  );
}

function FormatBar({
  editor,
  campaignId,
  tableColor,
  characters,
  openLink,
}: {
  editor: Editor;
  campaignId: string;
  tableColor: string;
  characters: TableCharacter[];
  openLink: (href: string) => void;
}) {
  const router = useRouter();
  // The editor doesn't re-render React on every keystroke; subscribe to what the bar shows.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      link: e.isActive("link"),
      href: e.isActive("link")
        ? (e.getAttributes("link").href as string | undefined)
        : undefined,
      canon: currentCanon(e),
    }),
  });
  const canon = state.canon;
  const keep = (e: React.MouseEvent) => e.preventDefault(); // don't steal the selection

  const btn = (
    label: string,
    active: boolean,
    run: () => void,
    title: string,
  ) => (
    <button
      type="button"
      className={active ? "on" : undefined}
      title={title}
      aria-pressed={active}
      onMouseDown={keep}
      onClick={run}
    >
      {label}
    </button>
  );

  const toggleCharacter = (id: string) => {
    const known = new Set(canon?.known ?? []);
    if (known.has(id)) known.delete(id);
    else known.add(id);
    setCanon(editor, { known: [...known], everyone: false });
  };

  return (
    <BubbleMenu
      editor={editor}
      className="ws-bubble"
      // Also open when the cursor sits in a highlight, so its knowers can be changed.
      // And in a link, to open or remove it.
      shouldShow={({ editor: e, from, to }) =>
        from !== to || e.isActive("canon") || e.isActive("link")
      }
    >
      <div className="ws-bubble-row">
        {btn(
          "B",
          state.bold,
          () => editor.chain().focus().toggleBold().run(),
          "Bold",
        )}
        {btn(
          "I",
          state.italic,
          () => editor.chain().focus().toggleItalic().run(),
          "Italic",
        )}
        {btn(
          "S",
          state.strike,
          () => editor.chain().focus().toggleStrike().run(),
          "Strikethrough",
        )}
        {btn(
          "H2",
          state.h2,
          () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          "Heading",
        )}
        {btn(
          "H3",
          state.h3,
          () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          "Subheading",
        )}
        {btn(
          "Link",
          state.link,
          () => {
            if (editor.isActive("link")) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            const href = window.prompt(
              "Link to — a web address, or a Hearth page's address",
            );
            if (href) editor.chain().focus().setLink({ href }).run();
          },
          state.link ? "Remove link" : "Link",
        )}
        {state.href && (
          <button
            type="button"
            title={state.href}
            onMouseDown={keep}
            onClick={() => openLink(state.href!)}
          >
            Open ↗
          </button>
        )}
      </div>
      <div
        className="ws-bubble-row ws-canon-row"
        role="group"
        aria-label="Who knows this"
      >
        <span className="ws-canon-label">
          {canon ? "Canon · known by" : "Mark as canon"}
        </span>
        <button
          type="button"
          className={`ws-chip${canon && !canon.everyone && canon.known.length === 0 ? " on" : ""}`}
          onMouseDown={keep}
          onClick={() => setCanon(editor, { known: [], everyone: false })}
          title="True in the world; nobody at the table knows it yet"
        >
          <span className="ws-swatch unknown" /> Nobody yet
        </button>
        <button
          type="button"
          className={`ws-chip${canon?.everyone ? " on" : ""}`}
          onMouseDown={keep}
          onClick={() =>
            setCanon(editor, { known: [], everyone: !canon?.everyone })
          }
          title="The whole table knows this"
        >
          <span className="ws-swatch" style={{ background: tableColor }} />{" "}
          Whole table
        </button>
        {characters.map((c) => {
          const on = !!canon && !canon.everyone && canon.known.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={`ws-chip${on ? " on" : ""}`}
              aria-pressed={on}
              onMouseDown={keep}
              onClick={() => toggleCharacter(c.id)}
              title={
                on
                  ? `${c.name} knows this — click to take it back`
                  : `${c.name} knows this`
              }
            >
              <span className="ws-swatch" style={{ background: c.color }} />{" "}
              {c.name}
            </button>
          );
        })}
        <button
          type="button"
          className="ws-chip ws-chip-quiet"
          onMouseDown={keep}
          onClick={() =>
            router.push(`/campaign/${campaignId}/workspace/colors`)
          }
          title="Add a character, or change colors"
        >
          + Add
        </button>
        {canon && (
          <button
            type="button"
            className="ws-chip ws-chip-quiet"
            onMouseDown={keep}
            onClick={() => clearCanon(editor)}
            title="Not canon: back to your working notes"
          >
            Back to working
          </button>
        )}
      </div>
    </BubbleMenu>
  );
}
