"use client";

// The workspace sidebar: folders inside folders, pages inside them. Folders open and close (and
// remember it for this browser); each row has a small menu for the things you do to it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  deleteFolderAction,
  moveFolderAction,
  movePageAction,
  newFolder,
  newPage,
  renameFolderAction,
  type ActionResult,
} from "./actions";

interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}
interface Page {
  id: string;
  folderId: string | null;
  title: string;
}

const OPEN_KEY = "hearth.workspace.open";

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
  const pathname = usePathname();
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
      if (result && !result.ok) setError(result.error);
    });
  }

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
              href={href}
              title={p.title}
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

  return (
    <nav className="ws-tree" aria-busy={pending}>
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
        </ul>
      )}
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

function FolderRow({
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
      <div className="ws-row" style={{ paddingLeft: 8 + depth * 14 }}>
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
  href,
  title,
  depth,
  active,
  folderPaths,
  onMove,
}: {
  href: string;
  title: string;
  depth: number;
  active: boolean;
  folderPaths: { id: string; path: string }[];
  onMove: (to: string | null) => void;
}) {
  const [moving, setMoving] = useState(false);
  return (
    <li role="treeitem">
      <div
        className={`ws-row${active ? " active" : ""}`}
        style={{ paddingLeft: 30 + depth * 14 }}
      >
        <Link
          href={href}
          className="ws-page-name"
          aria-current={active ? "page" : undefined}
        >
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
