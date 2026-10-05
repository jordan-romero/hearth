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
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import type { PmNode } from "@hearth/agents";
import { savePageAction } from "../../actions";
import { SlashCommand } from "./slash";

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

const SAVE_DELAY_MS = 800;

export function PageEditor({
  campaignId,
  pageId,
  initialTitle,
  initialContent,
  initialRevision,
  readOnly,
}: {
  campaignId: string;
  pageId: string;
  initialTitle: string;
  initialContent: PmNode;
  initialRevision: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
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
      {editor && !readOnly && <FormatBar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

function FormatBar({ editor }: { editor: Editor }) {
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
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  return (
    <BubbleMenu editor={editor} className="ws-bubble">
      {btn(
        "B",
        editor.isActive("bold"),
        () => editor.chain().focus().toggleBold().run(),
        "Bold",
      )}
      {btn(
        "I",
        editor.isActive("italic"),
        () => editor.chain().focus().toggleItalic().run(),
        "Italic",
      )}
      {btn(
        "S",
        editor.isActive("strike"),
        () => editor.chain().focus().toggleStrike().run(),
        "Strikethrough",
      )}
      {btn(
        "H2",
        editor.isActive("heading", { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        "Heading",
      )}
      {btn(
        "H3",
        editor.isActive("heading", { level: 3 }),
        () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        "Subheading",
      )}
      {btn(
        "Link",
        editor.isActive("link"),
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
    </BubbleMenu>
  );
}
