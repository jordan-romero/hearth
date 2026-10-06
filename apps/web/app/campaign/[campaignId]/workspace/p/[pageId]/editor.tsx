"use client";

// The page editor. Rich text the way Notion does it: type, use markdown shortcuts (# , - , [] ,
// > , ```), or press / for a menu of blocks; select text for a formatting bar. Saves itself a
// moment after you stop typing.
//
// Saves carry the revision this editor last saw. If the page changed elsewhere in the meantime
// (another tab, a restore), the save is refused and the DM is told instead of either copy
// silently winning.

import { useRouter } from "next/navigation";
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
import { savePageAction } from "../../actions";
import { SlashCommand } from "./slash";
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

export function PageEditor({
  campaignId,
  pageId,
  initialTitle,
  initialContent,
  initialRevision,
  readOnly,
  tableColor,
  characters,
}: {
  campaignId: string;
  pageId: string;
  initialTitle: string;
  initialContent: PmNode;
  initialRevision: number;
  readOnly: boolean;
  tableColor: string;
  characters: TableCharacter[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(initialRevision);
  const savedTitle = useRef(initialTitle);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  // The editor is created once, so its change handler goes through a ref to always reach the
  // current save logic (and the editor itself, which doesn't exist on the first render).
  const scheduleRef = useRef<() => void>(() => {});

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
            : "Write, or press / for blocks…",
      }),
      SlashCommand,
      canonMark({
        table: tableColor,
        characters: Object.fromEntries(characters.map((c) => [c.id, c.color])),
      } satisfies HighlightColors),
    ],
    content: initialContent,
    onUpdate: () => scheduleRef.current(),
    editorProps: {
      attributes: { class: "ws-prose", "aria-label": "Page content" },
    },
  });

  const save = useCallback(async () => {
    if (!editor || readOnly) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    setState("saving");
    const sentTitle = titleRef.current;
    const result = await savePageAction(campaignId, pageId, {
      title: sentTitle,
      // As a string: the editor's JSON can hold objects React won't pass to a server action
      // as plain data.
      content: JSON.stringify(editor.getJSON()),
      baseRevision: revision.current,
    }).catch(() => ({
      ok: false as const,
      error: "Couldn't save — check your connection.",
    }));
    inFlight.current = false;

    if (result.ok) {
      revision.current = result.revision;
      setError(null);
      if (sentTitle !== savedTitle.current) {
        savedTitle.current = sentTitle;
        router.refresh(); // the sidebar shows the title
      }
      if (again.current) {
        again.current = false;
        void save();
      } else {
        setState("saved");
      }
    } else if ("conflict" in result) {
      setState("conflict");
    } else {
      setState("error");
      setError(result.error);
    }
  }, [editor, readOnly, campaignId, pageId, router]);

  const schedule = useCallback(() => {
    if (readOnly) return;
    setState((s) => (s === "conflict" ? s : "dirty"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [readOnly, save]);
  scheduleRef.current = schedule;

  // A newer revision from the server (a restored version) replaces what's on screen, unless the
  // DM has unsaved typing — then the conflict notice handles it.
  useEffect(() => {
    if (!editor || initialRevision <= revision.current) return;
    if (state === "saved") {
      editor.commands.setContent(initialContent, { emitUpdate: false });
      setTitle(initialTitle);
      savedTitle.current = initialTitle;
      revision.current = initialRevision;
    }
  }, [editor, initialRevision, initialContent, initialTitle, state]);

  // Don't lose the last few keystrokes when leaving the page.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current || inFlight.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (timer.current) {
        clearTimeout(timer.current);
        void save();
      }
    };
  }, [save]);

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
              onClick={() => window.location.reload()}
            >
              Reload it
            </button>{" "}
            (copy anything you need first).
          </span>
        )}
      </div>
      <input
        className="ws-title"
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        readOnly={readOnly}
        maxLength={200}
        onChange={(e) => {
          setTitle(e.target.value);
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
      {editor && !readOnly && (
        <FormatBar
          editor={editor}
          tableColor={tableColor}
          characters={characters}
        />
      )}
      <EditorContent editor={editor} />
    </div>
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
  tableColor,
  characters,
}: {
  editor: Editor;
  tableColor: string;
  characters: TableCharacter[];
}) {
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
      shouldShow={({ editor: e, from, to }) =>
        from !== to || e.isActive("canon")
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
            const href = window.prompt("Link to");
            if (href) editor.chain().focus().setLink({ href }).run();
          },
          "Link",
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
