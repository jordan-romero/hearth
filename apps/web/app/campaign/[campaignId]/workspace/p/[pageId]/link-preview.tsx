"use client";

// Rest the pointer on a link to another page (in the page, or under "Mentioned in") and a card
// shows how that page begins, or the section a heading link points at, the way Obsidian's page
// previews work. Read from the page store, so it's instant for pages the browser already has.

import { useEffect, useRef, useState } from "react";
import { fetchDocs, getDoc, useStoreVersion } from "../../page-store";

const DELAY_MS = 350;
const MAX_CHARS = 360;
const WIDTH = 360;

interface Target {
  id: string;
  heading: string | null;
  rect: DOMRect;
}

type Node = {
  type?: string;
  text?: string;
  attrs?: { label?: string };
  content?: Node[];
};

/** A page's text as lines, from a heading on if one is given. */
function previewText(doc: Node, heading: string | null): string {
  const lines: { text: string; heading: boolean }[] = [];
  const inline = (n: Node): string =>
    n.text ??
    (n.type === "pageLink" ? (n.attrs?.label ?? "") : "") +
      (n.content ?? []).map(inline).join("");
  const walk = (n: Node) => {
    if (n.content?.some((c) => c.type === "text" || c.type === "pageLink")) {
      const text = inline(n).trim();
      if (text) lines.push({ text, heading: n.type === "heading" });
      return;
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  let from = 0;
  if (heading) {
    const want = heading.trim().toLowerCase();
    const at = lines.findIndex(
      (l) => l.heading && l.text.toLowerCase() === want,
    );
    if (at >= 0) from = at + 1;
  }
  const text = lines
    .slice(from)
    .map((l) => l.text)
    .join(" · ");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS).trim()}…` : text;
}

export function LinkPreview({ base }: { base: string }) {
  const [target, setTarget] = useState<Target | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useStoreVersion(); // redraw when the page arrives

  useEffect(() => {
    const linkOf = (el: EventTarget | null) =>
      el instanceof Element
        ? el.closest<HTMLAnchorElement>(".ws-prose a, .ws-backlinks a")
        : null;
    const pageOf = (a: HTMLAnchorElement) => {
      const id = a.getAttribute("data-page-link");
      if (id) return { id, heading: a.getAttribute("data-heading") };
      const m = a
        .getAttribute("href")
        ?.replace(/^https?:\/\/[^/]+/, "")
        .match(new RegExp(`^${base}/p/([^/?#]+)(?:#(.*))?$`));
      return m
        ? {
            id: decodeURIComponent(m[1]!),
            heading: m[2] ? decodeURIComponent(m[2]) : null,
          }
        : null;
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      setTarget(null);
    };
    const over = (e: MouseEvent) => {
      const a = linkOf(e.target);
      if (!a || linkOf(e.relatedTarget) === a) return;
      const page = pageOf(a);
      if (!page) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!getDoc(page.id)) void fetchDocs(base, [page.id]);
        setTarget({ ...page, rect: a.getBoundingClientRect() });
      }, DELAY_MS);
    };
    const out = (e: MouseEvent) => {
      const a = linkOf(e.target);
      if (a && linkOf(e.relatedTarget) !== a) hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("keydown", hide);
    window.addEventListener("mousedown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", hide);
      window.removeEventListener("mousedown", hide);
      window.clearTimeout(timer.current);
    };
  }, [base]);

  if (!target) return null;
  const doc = getDoc(target.id);
  const text = doc
    ? previewText(doc.content as Node, target.heading) || "This page is empty."
    : "Loading…";
  const { rect } = target;
  const left = Math.max(
    16,
    Math.min(rect.left, window.innerWidth - WIDTH - 16),
  );
  const below = rect.bottom + 8;
  const above = window.innerHeight - rect.top + 8;
  const room = window.innerHeight - below > 200;

  return (
    <div
      className="ws-preview"
      role="tooltip"
      style={{
        left,
        width: WIDTH,
        ...(room ? { top: below } : { bottom: above }),
      }}
    >
      <strong>{doc?.title || "Untitled"}</strong>
      {target.heading && <small> › {target.heading}</small>}
      <p>{text}</p>
    </div>
  );
}
