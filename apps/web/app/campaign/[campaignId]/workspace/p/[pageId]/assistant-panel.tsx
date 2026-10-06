"use client";

// Claude beside the page. Ask anything about the campaign; Claude searches it, says where things
// come from, and offers text as cards. Nothing reaches the page until the DM clicks Insert.
//
// The conversation lives in this panel for as long as the page is open. Each turn sends the
// history the previous turn returned, unchanged (Claude's reasoning blocks must come back as-is).

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Editor } from "@tiptap/react";
import type { AssistantEvent, PmNode, Placement } from "@hearth/agents";

type Proposal = Extract<AssistantEvent, { type: "proposal" }>;

interface Turn {
  role: "dm" | "claude";
  text: string;
  tools: string[];
  proposals: Proposal[];
  error?: string;
}

const SUGGESTIONS = [
  "Find 5 NPCs who'd fit this scene",
  "What does the party already know about this?",
  "Check this page against what's happened in sessions",
];

export function AssistantPanel({
  campaignId,
  pageId,
  editor,
  onClose,
}: {
  campaignId: string;
  pageId: string;
  editor: Editor | null;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [inserted, setInserted] = useState<Set<string>>(new Set());
  // The selection when the question was asked: "replace selection" means THAT text, even if the
  // cursor has moved since.
  const askedRange = useRef<{ from: number; to: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);

  const update = (fn: (t: Turn) => Turn) =>
    setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? fn(t) : t)));

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setInput("");
    const sel = editor?.state.selection;
    askedRange.current =
      sel && !sel.empty ? { from: sel.from, to: sel.to } : null;
    const selection =
      sel && !sel.empty
        ? editor!.state.doc.textBetween(sel.from, sel.to, "\n")
        : "";
    setTurns((prev) => [
      ...prev,
      { role: "dm", text, tools: [], proposals: [] },
      { role: "claude", text: "", tools: [], proposals: [] },
    ]);

    try {
      const res = await fetch(`/campaign/${campaignId}/workspace/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history, text, pageId, selection }),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        update((t) => ({
          ...t,
          error: err.error ?? "Couldn't reach Claude — try again.",
        }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AssistantEvent;
          if (e.type === "text")
            update((t) => ({ ...t, text: t.text + e.delta }));
          else if (e.type === "tool")
            update((t) => ({ ...t, tools: [...t.tools, e.label] }));
          else if (e.type === "proposal")
            update((t) => ({ ...t, proposals: [...t.proposals, e] }));
          else if (e.type === "error")
            update((t) => ({ ...t, error: e.message }));
          else if (e.type === "done") setHistory(e.messages);
        }
      }
    } catch {
      update((t) => ({
        ...t,
        error: "Lost the connection to Claude — try again.",
      }));
    } finally {
      setBusy(false);
    }
  }

  function insert(p: Proposal) {
    if (!editor) return;
    const content = (p.doc.content ?? []) as PmNode[];
    const placement: Placement = p.placement;
    const range = askedRange.current;
    const doc = editor.state.doc;

    if (
      placement === "replace_selection" &&
      range &&
      range.to <= doc.content.size
    ) {
      editor.chain().focus().insertContentAt(range, content).run();
    } else {
      // At the cursor (after any selection, never over it), or at the end of the writing — the
      // last paragraph with text in it, so "continue my sentence" continues it.
      let at = editor.state.selection.to;
      if (placement === "end") {
        at = doc.content.size;
        for (let i = doc.childCount - 1, off = doc.content.size; i >= 0; i--) {
          const child = doc.child(i);
          off -= child.nodeSize;
          if (child.textContent.trim()) {
            at =
              child.type.name === "paragraph"
                ? off + child.nodeSize - 1
                : off + child.nodeSize;
            break;
          }
        }
      }
      insertFlowing(editor, at, content);
    }
    setInserted((prev) => new Set(prev).add(p.id));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(input);
  }

  return (
    <aside className="asst" aria-label="Claude">
      <div className="asst-head">
        <strong>Claude</strong>
        <span className="muted small">reads your whole campaign</span>
        <div className="asst-head-actions">
          {turns.length > 0 && !busy && (
            <button
              type="button"
              className="ws-link"
              onClick={() => {
                setTurns([]);
                setHistory([]);
                setInserted(new Set());
              }}
            >
              New chat
            </button>
          )}
          <button
            type="button"
            className="ws-link"
            onClick={onClose}
            aria-label="Close Claude"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="asst-scroll" ref={scroller} aria-live="polite">
        {turns.length === 0 && (
          <div className="asst-empty">
            <p className="muted small" style={{ margin: 0 }}>
              Ask about anything in the campaign, or ask for text for this page.
              Select text first to work on just that part.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="asst-suggest"
                onClick={() => void ask(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "dm" ? (
            <div key={i} className="asst-dm">
              {t.text}
            </div>
          ) : (
            <div key={i} className="asst-claude">
              {t.tools.length > 0 && (
                <ul className="asst-tools">
                  {t.tools.map((label, j) => (
                    <li key={j}>{label}</li>
                  ))}
                </ul>
              )}
              {t.text && <div className="asst-text">{t.text}</div>}
              {t.proposals.map((p) => (
                <div key={p.id} className="asst-card">
                  <div className="asst-card-head">
                    <strong>{p.summary}</strong>
                    <span className="muted small">
                      {p.placement === "replace_selection"
                        ? "replaces your selection"
                        : p.placement === "end"
                          ? "adds to the end"
                          : "goes at your cursor"}
                    </span>
                  </div>
                  <pre className="asst-card-body">{p.markdown}</pre>
                  <div className="asst-card-actions">
                    {inserted.has(p.id) ? (
                      <span className="muted small">
                        Inserted — undo with ⌘Z
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => insert(p)}
                        disabled={!editor}
                      >
                        {p.placement === "replace_selection"
                          ? "Replace"
                          : "Insert"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ws-link"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(p.markdown)
                          .catch(() => {})
                      }
                    >
                      Copy
                    </button>
                  </div>
                </div>
              ))}
              {busy &&
                i === turns.length - 1 &&
                !t.text &&
                t.proposals.length === 0 && (
                  <span className="muted small">Thinking…</span>
                )}
              {t.error && <p className="notice error">{t.error}</p>}
            </div>
          ),
        )}
      </div>

      <form className="asst-form" onSubmit={onSubmit}>
        <textarea
          className="asst-input"
          value={input}
          rows={2}
          placeholder="Ask Claude about your campaign…"
          aria-label="Ask Claude"
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
        />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </aside>
  );
}

/**
 * Insert blocks at a position. If the position is in a paragraph that's mid-sentence (it has text
 * and doesn't end in closing punctuation) and the suggestion starts with a paragraph, that first
 * paragraph's words join the sentence; everything after goes below it as its own blocks.
 */
function insertFlowing(editor: Editor, at: number, nodes: PmNode[]) {
  const $at = editor.state.doc.resolve(at);
  const para = $at.parent;
  const [first, ...rest] = nodes;
  const midSentence =
    para.type.name === "paragraph" &&
    para.textContent.trim() !== "" &&
    !/[.!?…:;]["”’')\]]*\s*$/.test(para.textBetween(0, $at.parentOffset));
  if (!first || first.type !== "paragraph" || !midSentence) {
    const target =
      para.isTextblock && para.textContent.trim() ? $at.after() : at;
    editor.chain().focus().insertContentAt(target, nodes).run();
    return;
  }
  const inline = [...(first.content ?? [])];
  // Join with a space unless one is already there (or the suggestion starts with punctuation).
  const before = para.textBetween(0, $at.parentOffset);
  const lead = inline[0]?.type === "text" ? (inline[0].text ?? "") : "";
  if (
    before &&
    !/\s$/.test(before) &&
    lead &&
    !/^[\s,.;:!?…)\]”’]/.test(lead)
  ) {
    inline.unshift({ type: "text", text: " " });
  }
  editor.chain().focus().insertContentAt(at, inline).run();
  if (rest.length) {
    const after = editor.state.selection.$from.after();
    editor.chain().insertContentAt(after, rest).run();
  }
}
