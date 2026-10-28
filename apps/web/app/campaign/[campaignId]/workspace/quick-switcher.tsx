"use client";

// ⌘K (or Ctrl+K): jump to any page by typing part of its name, the way Obsidian's and Notion's
// switchers work. ↑↓ to move, Enter to open, Escape to close. The page under the highlight is
// fetched ahead, so opening it is instant. No match? Enter makes a page with that name.

import { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useEffect, useMemo, useRef, useState } from "react";
import { createLinkedPageAction } from "./actions";
import { rankPages } from "./p/[pageId]/page-link";

export interface SwitcherPage {
  id: string;
  title: string;
  /** "NPCs / Shepherds", or "" at the top level. */
  where: string;
}

const LIMIT = 12;

export function QuickSwitcher({
  campaignId,
  pages,
}: {
  campaignId: string;
  pages: SwitcherPage[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const base = `/campaign/${campaignId}/workspace`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hearth:quick-switcher", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hearth:quick-switcher", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    // After the dialog is in the DOM.
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const matches = useMemo(
    () => rankPages(pages, query, "", LIMIT),
    [pages, query],
  );
  const exact = matches.some(
    (p) => p.title.trim().toLowerCase() === query.trim().toLowerCase(),
  );
  const canCreate = query.trim().length > 0 && !exact;
  const count = matches.length + (canCreate ? 1 : 0);

  const highlighted = matches[index];
  useEffect(() => {
    if (open && highlighted)
      router.prefetch(`${base}/p/${highlighted.id}`, {
        kind: PrefetchKind.FULL,
      });
  }, [open, highlighted, router, base]);

  function go(page: SwitcherPage) {
    setOpen(false);
    router.push(`${base}/p/${page.id}`);
  }

  async function create() {
    const title = query.trim();
    if (!title || creating) return;
    setCreating(true);
    const result = await createLinkedPageAction(campaignId, null, title).catch(
      () => null,
    );
    setCreating(false);
    if (!result?.ok) return;
    setOpen(false);
    router.push(`${base}/p/${result.id}`);
  }

  if (!open) return null;

  return (
    <div
      className="qs-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="qs"
        role="dialog"
        aria-modal="true"
        aria-label="Go to a page"
      >
        <input
          ref={input}
          className="qs-input"
          value={query}
          placeholder="Go to a page…"
          aria-label="Page name"
          aria-controls="qs-list"
          aria-activedescendant={count ? `qs-${index}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === "ArrowDown" && count) {
              e.preventDefault();
              setIndex((i) => (i + 1) % count);
            } else if (e.key === "ArrowUp" && count) {
              e.preventDefault();
              setIndex((i) => (i - 1 + count) % count);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (matches[index]) go(matches[index]);
              else if (canCreate) void create();
            }
          }}
        />
        <ul id="qs-list" className="qs-list" role="listbox">
          {matches.map((p, i) => (
            <li
              key={p.id}
              id={`qs-${i}`}
              role="option"
              aria-selected={i === index}
              className={`qs-item${i === index ? " on" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                go(p);
              }}
            >
              <span>{p.title}</span>
              {p.where && <small>{p.where}</small>}
            </li>
          ))}
          {canCreate && (
            <li
              id={`qs-${matches.length}`}
              role="option"
              aria-selected={index === matches.length}
              className={`qs-item create${index === matches.length ? " on" : ""}`}
              onMouseEnter={() => setIndex(matches.length)}
              onMouseDown={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <span>{creating ? "Creating…" : `Create “${query.trim()}”`}</span>
              <small>A new page at the top level</small>
            </li>
          )}
          {count === 0 && (
            <li className="qs-empty">No pages yet. Type a name to make one.</li>
          )}
        </ul>
        <p className="qs-help">
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to
          close
        </p>
      </div>
    </div>
  );
}

/** Open the switcher from a button (it listens for this event). */
export function openQuickSwitcher() {
  window.dispatchEvent(new Event("hearth:quick-switcher"));
}
