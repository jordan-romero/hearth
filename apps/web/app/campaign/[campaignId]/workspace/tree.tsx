"use client";

// The workspace sidebar: folders inside folders, pages inside them. Folders open and close (and
// remember it for this browser); each row has a small menu for the things you do to it. Drag a
// page or folder to move it: onto a folder to put it inside, between rows to reorder.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
} from "react";
import {
  deleteFolderAction,
  moveFolderAction,
  movePageAction,
  newFolder,
  placeFolderAction,
  placePageAction,
  newPage,
  renameFolderAction,
  type ActionResult,
} from "./actions";
import { openQuickSwitcher, QuickSwitcher } from "./quick-switcher";
import { openShortcuts, ShortcutSheet } from "./shortcuts";
import { useKeys } from "./keys";
import { useWorkspace } from "./workspace-context";

interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}
interface Page {
  id: string;
  folderId: string | null;
  title: string;
  icon?: string | null;
}

const OPEN_KEY = "hearth.workspace.open";

type Kind = "page" | "folder";
type Zone = "before" | "after" | "into";
interface Dragged {
  kind: Kind;
  id: string;
}

/** What a row needs to take part in drag and drop. */
export interface RowDnd {
  /** The zone this row shows a drop marker for, if any. */
  hint: Zone | null;
  dragging: boolean;
  start: (e: DragEvent) => void;
  over: (e: DragEvent) => void;
  drop: (e: DragEvent) => void;
  end: () => void;
}

/** Before or after a page; before, inside or after a folder (its middle half is "inside"). */
function zoneOf(e: DragEvent, kind: Kind): Zone {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (e.clientY - box.top) / box.height;
  if (kind === "page") return y < 0.5 ? "before" : "after";
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
}

function readOpen(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

export function WorkspaceTree({
  campaignId,
  folders,
  pages,
}: {
  campaignId: string;
  folders: Folder[];
  pages: Page[];
}) {
  // The same pages, with titles as typed in the editor, so a rename shows here at once.
  const livePages = useWorkspace().pages;
  // A drop shows at once; the server's order replaces it when it arrives.
  const [local, setLocal] = useState<{
    pages: Page[];
    folders: Folder[];
  } | null>(null);
  // Only when the server's arrangement actually changes (not on every title keystroke).
  const serverOrder =
    livePages.map((p) => `${p.id}:${p.folderId}`).join() +
    "|" +
    folders.map((f) => `${f.id}:${f.parentId}`).join();
  useEffect(() => setLocal(null), [serverOrder]);
  pages = local?.pages ?? livePages;
  folders = local?.folders ?? folders;
  const pathname = usePathname();
  const { mod } = useKeys();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const base = `/campaign/${campaignId}/workspace`;

  useEffect(() => setOpen(readOpen()), []);

  const byParent = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    for (const f of folders)
      m.set(f.parentId, [...(m.get(f.parentId) ?? []), f]);
    return m;
  }, [folders]);
  const pagesIn = useMemo(() => {
    const m = new Map<string | null, Page[]>();
    for (const p of pages) m.set(p.folderId, [...(m.get(p.folderId) ?? []), p]);
    return m;
  }, [pages]);

  // A page that's open keeps its folders open, so you can see where you are.
  useEffect(() => {
    const current = pages.find((p) => pathname === `${base}/p/${p.id}`);
    if (!current?.folderId) return;
    const parents = new Map(folders.map((f) => [f.id, f.parentId]));
    setOpen((prev) => {
      const next = new Set(prev);
      for (
        let id: string | null | undefined = current.folderId;
        id;
        id = parents.get(id)
      ) {
        next.add(id);
      }
      return next;
    });
  }, [pathname, pages, folders, base]);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      } catch {
        /* remembering is a convenience */
      }
      return next;
    });
  }

  function act(fn: () => Promise<ActionResult | void>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result && !result.ok) {
        setError(result.error);
        setLocal(null);
      }
    });
  }

  // ─── Drag and drop ───
  // Refs, not state, for what the drag events read: the browser fires them faster than React
  // re-renders.
  const dragRef = useRef<Dragged | null>(null);
  const hintRef = useRef<{ key: string; zone: Zone } | null>(null);
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [hint, setHint] = useState<{ key: string; zone: Zone } | null>(null);
  const blocked = useRef<Set<string>>(new Set());

  /** A folder and everything inside it: where a dragged folder can't go. */
  function selfAndBelow(folderId: string) {
    const out = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders)
        if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
    }
    return out;
  }

  function endDrag() {
    dragRef.current = null;
    hintRef.current = null;
    setDragging(null);
    setHint(null);
  }

  function commit(
    d: Dragged,
    target: { kind: Kind; id: string } | null,
    zone: Zone,
  ) {
    const pagesOf = (folderId: string | null) =>
      pages.filter((p) => p.folderId === folderId && p.id !== d.id);
    const foldersOf = (parentId: string | null) =>
      folders.filter((f) => f.parentId === parentId && f.id !== d.id);
    const after = <T extends { id: string }>(list: T[], id: string) =>
      list[list.findIndex((x) => x.id === id) + 1]?.id ?? null;

    if (d.kind === "page") {
      let folderId: string | null = null;
      let beforeId: string | null = null;
      if (target?.kind === "page") {
        const t = pages.find((p) => p.id === target.id)!;
        folderId = t.folderId;
        beforeId = zone === "before" ? t.id : after(pagesOf(folderId), t.id);
      } else if (target?.kind === "folder") {
        const f = folders.find((x) => x.id === target.id)!;
        if (zone === "into") {
          folderId = f.id;
          if (!open.has(f.id)) toggle(f.id);
        } else {
          // Next to a folder: in that folder's parent, ahead of its pages.
          folderId = f.parentId;
          beforeId = pagesOf(folderId)[0]?.id ?? null;
        }
      }
      const moved = { ...pages.find((p) => p.id === d.id)!, folderId };
      const rest = pages.filter((p) => p.id !== d.id);
      const at = beforeId ? rest.findIndex((p) => p.id === beforeId) : -1;
      rest.splice(at >= 0 ? at : rest.length, 0, moved);
      setLocal({ pages: rest, folders });
      act(() => placePageAction(campaignId, d.id, folderId, beforeId));
    } else {
      let parentId: string | null = null;
      let beforeId: string | null = null;
      if (target?.kind === "folder") {
        const f = folders.find((x) => x.id === target.id)!;
        if (zone === "into") {
          parentId = f.id;
          if (!open.has(f.id)) toggle(f.id);
        } else {
          parentId = f.parentId;
          beforeId =
            zone === "before" ? f.id : after(foldersOf(parentId), f.id);
        }
      } else if (target?.kind === "page") {
        parentId = pages.find((p) => p.id === target.id)!.folderId;
      }
      const moved = { ...folders.find((f) => f.id === d.id)!, parentId };
      const rest = folders.filter((f) => f.id !== d.id);
      const at = beforeId ? rest.findIndex((f) => f.id === beforeId) : -1;
      rest.splice(at >= 0 ? at : rest.length, 0, moved);
      setLocal({ pages, folders: rest });
      act(() => placeFolderAction(campaignId, d.id, parentId, beforeId));
    }
  }

  function dndFor(kind: Kind, id: string): RowDnd {
    const key = `${kind}:${id}`;
    const allowed = () => {
      const d = dragRef.current;
      return (
        !!d && !(d.kind === kind && d.id === id) && !blocked.current.has(id)
      );
    };
    return {
      hint: hint?.key === key ? hint.zone : null,
      dragging: dragging?.kind === kind && dragging.id === id,
      start: (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id); // Firefox won't drag without data
        dragRef.current = { kind, id };
        blocked.current = kind === "folder" ? selfAndBelow(id) : new Set();
        setDragging({ kind, id });
      },
      over: (e) => {
        if (!allowed()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        // A page can't go "inside" a page; treat a folder's middle as inside only.
        const zone = zoneOf(e, kind);
        if (hintRef.current?.key !== key || hintRef.current.zone !== zone) {
          hintRef.current = { key, zone };
          setHint(hintRef.current);
        }
      },
      drop: (e) => {
        const d = dragRef.current;
        if (!d || !allowed()) return;
        e.preventDefault();
        e.stopPropagation();
        commit(d, { kind, id }, zoneOf(e, kind));
        endDrag();
      },
      end: endDrag,
    };
  }

  /** The strip at the bottom of the tree while dragging: drop there for the top level. */
  const rootDrop = {
    over: (e: DragEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();
      if (hintRef.current?.key !== "root") {
        hintRef.current = { key: "root", zone: "into" };
        setHint(hintRef.current);
      }
    },
    drop: (e: DragEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      commit(d, null, "into");
      endDrag();
    },
  };

  // Folder paths for "Move to…", deepest last so nesting reads naturally.
  const folderPaths = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const pathOf = (f: Folder): string => {
      const parts = [f.name];
      for (
        let p = f.parentId && byId.get(f.parentId);
        p;
        p = p.parentId ? byId.get(p.parentId) : undefined
      ) {
        parts.unshift(p.name);
      }
      return parts.join(" / ");
    };
    return folders
      .map((f) => ({ id: f.id, path: pathOf(f) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [folders]);

  function renderLevel(parentId: string | null, depth: number) {
    return (
      <>
        {(byParent.get(parentId) ?? []).map((f) => (
          <FolderRow
            key={f.id}
            dnd={dndFor("folder", f.id)}
            folder={f}
            depth={depth}
            isOpen={open.has(f.id)}
            onToggle={() => toggle(f.id)}
            folderPaths={folderPaths}
            onNewPage={() => act(() => newPage(campaignId, f.id))}
            onNewFolder={(name) =>
              act(async () => {
                const r = await newFolder(campaignId, f.id, name);
                if (r.ok && !open.has(f.id)) toggle(f.id);
                return r;
              })
            }
            onRename={(name) =>
              act(() => renameFolderAction(campaignId, f.id, name))
            }
            onMove={(to) => act(() => moveFolderAction(campaignId, f.id, to))}
            onDelete={() => act(() => deleteFolderAction(campaignId, f.id))}
          >
            {open.has(f.id) && renderLevel(f.id, depth + 1)}
          </FolderRow>
        ))}
        {(pagesIn.get(parentId) ?? []).map((p) => {
          const href = `${base}/p/${p.id}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <PageRow
              key={p.id}
              dnd={dndFor("page", p.id)}
              pageId={p.id}
              href={href}
              title={p.title}
              icon={p.icon ?? null}
              depth={depth}
              active={active}
              folderPaths={folderPaths}
              onMove={(to) => act(() => movePageAction(campaignId, p.id, to))}
            />
          );
        })}
      </>
    );
  }

  const empty = folders.length === 0 && pages.length === 0;

  // For ⌘K: every page with the folders it sits in.
  const switcherPages = useMemo(() => {
    const pathById = new Map(folderPaths.map((f) => [f.id, f.path]));
    return pages
      .filter((p) => p.title.trim())
      .map((p) => ({
        id: p.id,
        title: p.title,
        icon: p.icon ?? null,
        where: p.folderId ? (pathById.get(p.folderId) ?? "") : "",
      }));
  }, [pages, folderPaths]);

  return (
    <nav className="ws-tree" aria-busy={pending}>
      <QuickSwitcher campaignId={campaignId} pages={switcherPages} />
      <ShortcutSheet />
      <div className="ws-tree-head">
        <Link
          href={base}
          className={`ws-home${pathname === base ? " active" : ""}`}
        >
          Workspace
        </Link>
        <div className="ws-tree-actions">
          <button
            type="button"
            className="ws-icon"
            title="New page"
            onClick={() => act(() => newPage(campaignId, null))}
          >
            + Page
          </button>
          <NewFolderButton
            onCreate={(name) => act(() => newFolder(campaignId, null, name))}
          />
        </div>
      </div>
      <button
        type="button"
        className="ws-find"
        onClick={openQuickSwitcher}
        title={`Go to a page (${mod} K)`}
      >
        <span>Go to a page…</span>
        <kbd>{mod} K</kbd>
      </button>
      {error && (
        <p className="ws-error" role="alert">
          {error}
        </p>
      )}
      {empty ? (
        <p className="muted small ws-empty">
          No pages yet. Start with a page, or a folder to hold them.
        </p>
      ) : (
        <ul className="ws-list" role="tree">
          {renderLevel(null, 0)}
          {dragging && (
            <li
              className={`ws-root-drop${hint?.key === "root" ? " over" : ""}`}
              onDragOver={rootDrop.over}
              onDragEnter={rootDrop.over}
              onDrop={rootDrop.drop}
            >
              Top level
            </li>
          )}
        </ul>
      )}
      <Link
        href={`${base}/import`}
        className={`ws-trash${pathname === `${base}/import` ? " active" : ""}`}
      >
        Import notes
      </Link>
      <Link
        href={`${base}/colors`}
        className={`ws-trash${pathname === `${base}/colors` ? " active" : ""}`}
      >
        Table colors
      </Link>
      <Link
        href={`${base}/trash`}
        className={`ws-trash${pathname === `${base}/trash` ? " active" : ""}`}
      >
        Trash
      </Link>
      <button
        type="button"
        className="ws-trash ws-help"
        onClick={openShortcuts}
      >
        Shortcuts &amp; tips <kbd>?</kbd>
      </button>
    </nav>
  );
}

function NewFolderButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  if (naming) {
    return (
      <NameInput
        placeholder="Folder name"
        onDone={(name) => {
          setNaming(false);
          if (name) onCreate(name);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="ws-icon"
      title="New folder"
      onClick={() => setNaming(true)}
    >
      + Folder
    </button>
  );
}

/** A one-line name field: Enter saves, Escape or clicking away cancels. */
function NameInput({
  initial = "",
  placeholder,
  onDone,
}: {
  initial?: string;
  placeholder: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="ws-name-input"
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() =>
        onDone(value.trim() && value.trim() !== initial ? value.trim() : null)
      }
    />
  );
}

/** The row's classes and drag handlers. */
function dragProps(dnd: RowDnd, base: string) {
  return {
    className: [base, dnd.dragging && "lifted", dnd.hint && `drop-${dnd.hint}`]
      .filter(Boolean)
      .join(" "),
    draggable: true,
    onDragStart: dnd.start,
    onDragOver: dnd.over,
    onDragEnter: dnd.over,
    onDrop: dnd.drop,
    onDragEnd: dnd.end,
  };
}

function FolderRow({
  dnd,
  folder,
  depth,
  isOpen,
  onToggle,
  folderPaths,
  onNewPage,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  children,
}: {
  dnd: RowDnd;
  folder: Folder;
  depth: number;
  isOpen: boolean;
  onToggle: () => void;
  folderPaths: { id: string; path: string }[];
  onNewPage: () => void;
  onNewFolder: (name: string) => void;
  onRename: (name: string) => void;
  onMove: (to: string | null) => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const [mode, setMode] = useState<
    "idle" | "rename" | "subfolder" | "move" | "confirmDelete"
  >("idle");
  return (
    <li role="treeitem" aria-expanded={isOpen}>
      <div
        {...dragProps(dnd, "ws-row")}
        style={{ paddingLeft: 8 + depth * 14 }}
        title="Drag to move or reorder"
      >
        <button
          type="button"
          className="ws-caret"
          onClick={onToggle}
          aria-label={isOpen ? "Close folder" : "Open folder"}
        >
          {isOpen ? "▾" : "▸"}
        </button>
        {mode === "rename" ? (
          <NameInput
            initial={folder.name}
            placeholder="Folder name"
            onDone={(name) => {
              setMode("idle");
              if (name) onRename(name);
            }}
          />
        ) : (
          <button type="button" className="ws-folder-name" onClick={onToggle}>
            {folder.name}
          </button>
        )}
        <RowMenu
          items={[
            ["New page here", onNewPage],
            ["New folder here", () => setMode("subfolder")],
            ["Rename", () => setMode("rename")],
            ["Move to…", () => setMode("move")],
            ["Delete", () => setMode("confirmDelete")],
          ]}
        />
      </div>
      {mode === "subfolder" && (
        <div className="ws-inline" style={{ paddingLeft: 30 + depth * 14 }}>
          <NameInput
            placeholder="Folder name"
            onDone={(name) => {
              setMode("idle");
              if (name) onNewFolder(name);
            }}
          />
        </div>
      )}
      {mode === "move" && (
        <MovePicker
          depth={depth}
          options={folderPaths.filter((f) => f.id !== folder.id)}
          current={folder.parentId}
          onPick={(to) => {
            setMode("idle");
            if (to !== undefined) onMove(to);
          }}
        />
      )}
      {mode === "confirmDelete" && (
        <div
          className="ws-inline ws-confirm"
          style={{ paddingLeft: 30 + depth * 14 }}
        >
          <span>Delete &ldquo;{folder.name}&rdquo;?</span>
          <button
            type="button"
            className="ws-link danger"
            onClick={() => {
              setMode("idle");
              onDelete();
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="ws-link"
            onClick={() => setMode("idle")}
          >
            Cancel
          </button>
        </div>
      )}
      {isOpen && <ul role="group">{children}</ul>}
    </li>
  );
}

function PageRow({
  dnd,
  pageId,
  href,
  title,
  icon,
  depth,
  active,
  folderPaths,
  onMove,
}: {
  dnd: RowDnd;
  pageId: string;
  href: string;
  title: string;
  icon: string | null;
  depth: number;
  active: boolean;
  folderPaths: { id: string; path: string }[];
  onMove: (to: string | null) => void;
}) {
  const [moving, setMoving] = useState(false);
  const { openPage, warmPage } = useWorkspace();
  // Fetch the page when the pointer (or focus) arrives, so by the click it's here (the workspace
  // also fetches its pages in the background).
  const warm = () => {
    if (!active) warmPage(pageId);
  };
  return (
    <li role="treeitem">
      <div
        {...dragProps(dnd, `ws-row${active ? " active" : ""}`)}
        style={{ paddingLeft: 30 + depth * 14 }}
      >
        <Link
          href={href}
          // The row drags, not the link (which would drag its address).
          draggable={false}
          className="ws-page-name"
          aria-current={active ? "page" : undefined}
          onMouseEnter={warm}
          onFocus={warm}
          onClick={(e) => {
            // ⌘/Ctrl/Shift-click keeps the browser's own behaviour (a new tab or window).
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            openPage(pageId);
          }}
        >
          {icon && <span className="ws-row-icon">{icon}</span>}
          {title || "Untitled"}
        </Link>
        <RowMenu items={[["Move to…", () => setMoving(true)]]} />
      </div>
      {moving && (
        <MovePicker
          depth={depth}
          options={folderPaths}
          current={undefined}
          onPick={(to) => {
            setMoving(false);
            if (to !== undefined) onMove(to);
          }}
        />
      )}
    </li>
  );
}

function MovePicker({
  depth,
  options,
  current,
  onPick,
}: {
  depth: number;
  options: { id: string; path: string }[];
  current: string | null | undefined;
  /** undefined = cancelled; null = top level. */
  onPick: (to: string | null | undefined) => void;
}) {
  return (
    <div className="ws-inline" style={{ paddingLeft: 30 + depth * 14 }}>
      <select
        className="ws-select"
        autoFocus
        aria-label="Move to folder"
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") return;
          onPick(v === "__top" ? null : v);
        }}
        onBlur={() => onPick(undefined)}
      >
        <option value="" disabled>
          Move to…
        </option>
        {current !== null && <option value="__top">Top level</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={o.id === current}>
            {o.path}
          </option>
        ))}
      </select>
    </div>
  );
}

function RowMenu({ items }: { items: [string, () => void][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="ws-menu"
      onBlur={(e) =>
        !e.currentTarget.contains(e.relatedTarget) && setOpen(false)
      }
    >
      <button
        type="button"
        className="ws-dots"
        aria-label="More"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="ws-menu-list" role="menu">
          {items.map(([label, fn]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                fn();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
