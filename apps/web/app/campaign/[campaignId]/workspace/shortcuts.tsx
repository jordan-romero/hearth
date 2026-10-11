"use client";

// Help that's there when you want it: a sheet of every shortcut and trick in the workspace (⌘/,
// or ? when not typing), and a getting-started card on the workspace's front page until the DM
// dismisses it. Hearth should be learnable without reading anything else.

import { useEffect, useState } from "react";
import { openQuickSwitcher } from "./quick-switcher";

const isMac = () =>
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

function useMod() {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => setMod(isMac() ? "⌘" : "Ctrl"), []);
  return mod;
}

const OPEN_EVENT = "hearth:shortcuts";

export function openShortcuts() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));

export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  const mod = useMod();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "?" && !typing(e.target)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;

  const groups: [string, [string, string][]][] = [
    [
      "Find and link",
      [
        [`${mod} K`, "Go to any page by name"],
        ["[[  or  @", "Link a page — pick it, or create it"],
        ["[[Ildin]]", "Typed or pasted, becomes a link to Ildin"],
        [`${mod} click`, "Open a link in a new tab"],
      ],
    ],
    [
      "Write",
      [
        ["/", "Insert a block: heading, list, checklist, table, quote…"],
        ["#  ##  ###", "Headings, typed at the start of a line"],
        ["-  or  1.", "Bulleted or numbered list"],
        ["[]", "Checklist"],
        [">", "Quote — read-aloud text, a letter"],
        ["```", "Code block"],
        ["---", "A line across the page"],
        [`${mod} B  /  ${mod} I`, "Bold / italic"],
        [`${mod} Z  /  ${mod} ⇧ Z`, "Undo / redo"],
      ],
    ],
    [
      "Canon",
      [
        ["Select text", "Mark it canon, and choose who knows it"],
        ["✦ Claude", "Ask about the campaign, or have it draft for you"],
      ],
    ],
    [
      "This sheet",
      [
        [`${mod} /  or  ?`, "Show these shortcuts"],
        ["Esc", "Close"],
      ],
    ],
  ];

  return (
    <div
      className="qs-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="qs sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Shortcuts and tips"
      >
        <div className="sheet-head">
          <h2>Shortcuts &amp; tips</h2>
          <button
            type="button"
            className="ws-link"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <div className="sheet-body">
          {groups.map(([name, rows]) => (
            <section key={name}>
              <h3>{name}</h3>
              <dl>
                {rows.map(([keys, what]) => (
                  <div key={keys} className="sheet-row">
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const DISMISSED = "hearth.workspace.welcome-dismissed";

/** The first thing a DM sees in the workspace: how it works, in four lines. */
export function GettingStarted() {
  const [show, setShow] = useState(false);
  const mod = useMod();
  useEffect(() => {
    try {
      setShow(localStorage.getItem(DISMISSED) !== "1");
    } catch {
      setShow(true);
    }
  }, []);
  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      /* it'll show again next time; that's all */
    }
  };

  return (
    <section className="ws-welcome" aria-label="Getting started">
      <h3>How the workspace works</h3>
      <ol>
        <li>
          <strong>Write like a notes app.</strong> Folders on the left, pages
          inside them. Press <kbd>/</kbd> for headings, lists, tables and more.
        </li>
        <li>
          <strong>Link your world together.</strong> Type <kbd>[[</kbd> or{" "}
          <kbd>@</kbd> and a name to link a page (or create it). Every page
          shows what links to it.
        </li>
        <li>
          <strong>Jump anywhere.</strong> <kbd>{mod} K</kbd> finds any page by
          name.
        </li>
        <li>
          <strong>Mark what&rsquo;s canon.</strong> Select text to mark it as
          true in your world and choose which players know it. Everything else
          stays your private prep.
        </li>
      </ol>
      <div className="ws-welcome-actions">
        <button type="button" className="btn" onClick={openQuickSwitcher}>
          Try {mod} K
        </button>
        <button type="button" className="btn ghost" onClick={openShortcuts}>
          All shortcuts
        </button>
        <button type="button" className="ws-link" onClick={dismiss}>
          Got it, hide this
        </button>
      </div>
    </section>
  );
}
