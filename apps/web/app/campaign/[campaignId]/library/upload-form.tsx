"use client";

// The library's uploader. Takes one file, many, or a whole folder (picked or dropped), and sends
// them a few at a time so a DM can hand over years of notes in one go.
//
// Where storage supports it, each file goes straight from the browser to storage (Vercel won't
// accept a request body over 4.5 MB) and only its key comes back through the server. Otherwise
// each file is posted to the server on its own.

import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";

type Prepared = { key: string; uploadUrl: string } | { error: string };

export interface FinishInput {
  key: string;
  fileName: string;
  mimeType: string;
  extractUnits: boolean;
  forPlayers: boolean;
}

/** What happened to one file, in words the DM can act on. */
export type FileOutcome =
  | { kind: "added"; replaced: boolean }
  | { kind: "already"; existingName: string }
  | { kind: "error"; message: string };

type Status =
  | { state: "waiting" }
  | { state: "uploading" }
  | { state: "skipped"; reason: string }
  | { state: "done"; outcome: FileOutcome };

interface Item {
  id: number;
  file: File;
  /** The name it's stored under: its path inside a dropped/picked folder, else the file name. */
  name: string;
  status: Status;
}

// Enough to keep the pipe busy without a hundred-file drop opening a hundred connections.
const CONCURRENCY = 3;

export function UploadForm({
  accept,
  maxBytes,
  direct,
  uploadOne,
  prepareUpload,
  finishUpload,
}: {
  accept: readonly string[];
  maxBytes: number;
  direct: boolean;
  uploadOne: (formData: FormData) => Promise<FileOutcome>;
  prepareUpload: (fileName: string, size: number) => Promise<Prepared>;
  finishUpload: (input: FinishInput) => Promise<FileOutcome>;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [extract, setExtract] = useState(true);
  const [forPlayers, setForPlayers] = useState(false);
  const nextId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  function skipReason(name: string, size: number): string | null {
    const base = name.split("/").pop() ?? name;
    // Finder and Explorer litter folders with these; nobody means to upload them.
    if (
      base.startsWith(".") ||
      base === "Thumbs.db" ||
      base === "desktop.ini"
    ) {
      return "system file";
    }
    const lower = base.toLowerCase();
    if (!accept.some((ext) => lower.endsWith(ext)))
      return "can't read this type";
    if (size === 0) return "empty";
    if (size > maxBytes) {
      return `${(size / 1024 / 1024).toFixed(1)}MB — over the ${maxBytes / 1024 / 1024}MB limit`;
    }
    return null;
  }

  function add(files: { file: File; path: string }[]) {
    if (files.length === 0) return;
    const fresh: Item[] = files.map(({ file, path }) => {
      const reason = skipReason(path, file.size);
      return {
        id: nextId.current++,
        file,
        name: path,
        status: reason ? { state: "skipped", reason } : { state: "waiting" },
      };
    });
    setItems((prev) => [...prev, ...fresh]);
  }

  function setStatus(id: number, status: Status) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, status } : it)),
    );
  }

  async function send(item: Item): Promise<FileOutcome> {
    if (!direct) {
      const data = new FormData();
      data.set("file", item.file);
      data.set("name", item.name);
      if (extract) data.set("extract", "on");
      if (forPlayers) data.set("forPlayers", "on");
      return uploadOne(data);
    }
    const prepared = await prepareUpload(item.name, item.file.size);
    if ("error" in prepared) return { kind: "error", message: prepared.error };
    const res = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": item.file.type || "application/octet-stream",
        "x-upsert": "false",
      },
      body: item.file,
    });
    if (!res.ok)
      return { kind: "error", message: "Upload failed — try again." };
    return finishUpload({
      key: prepared.key,
      fileName: item.name,
      mimeType: item.file.type,
      extractUnits: extract,
      forPlayers,
    });
  }

  async function start() {
    const queue = items.filter((it) => it.status.state === "waiting");
    if (queue.length === 0) return;
    setBusy(true);
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const item = queue[next++]!;
        setStatus(item.id, { state: "uploading" });
        try {
          setStatus(item.id, { state: "done", outcome: await send(item) });
        } catch {
          setStatus(item.id, {
            state: "done",
            outcome: { kind: "error", message: "Upload failed — try again." },
          });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setBusy(false);
    router.refresh();
  }

  function retryFailed() {
    setItems((prev) =>
      prev.map((it) =>
        isFailed(it.status) ? { ...it, status: { state: "waiting" } } : it,
      ),
    );
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    add(await filesFromDrop(event.dataTransfer));
  }

  const waiting = items.filter((it) => it.status.state === "waiting").length;
  const failed = items.filter((it) => isFailed(it.status)).length;
  const done = items.filter(
    (it) => it.status.state === "done" && !isFailed(it.status),
  ).length;
  const skipped = items.filter((it) => it.status.state === "skipped").length;

  return (
    <div className="uploader">
      <div
        className={`dropzone${dragging ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="dropzone-title">Drop files or a whole folder here</p>
        <p className="muted small">
          {accept.join(", ")} · up to {maxBytes / 1024 / 1024}MB each
        </p>
        <div className="dropzone-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Choose files
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => folderInput.current?.click()}
          >
            Choose a folder
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={accept.join(",")}
          onChange={(e) => {
            add(
              Array.from(e.target.files ?? []).map((file) => ({
                file,
                path: file.name,
              })),
            );
            e.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          // Non-standard but supported by every current browser; React doesn't know the prop.
          {...{ webkitdirectory: "" }}
          onChange={(e) => {
            add(
              Array.from(e.target.files ?? []).map((file) => ({
                file,
                path: file.webkitRelativePath || file.name,
              })),
            );
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <>
          <div className="upload-options">
            <label className="check">
              <input
                type="checkbox"
                checked={extract}
                disabled={busy}
                onChange={(e) => setExtract(e.target.checked)}
              />
              Also pull out NPCs, places and facts
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={forPlayers}
                disabled={busy}
                onChange={(e) => setForPlayers(e.target.checked)}
              />
              Players already have these
            </label>
          </div>

          <ul className="upload-list">
            {items.map((it) => (
              <li key={it.id} className="upload-row">
                <span className="upload-name" title={it.name}>
                  {it.name}
                </span>
                <span className={`upload-status ${statusClass(it.status)}`}>
                  {statusLabel(it.status)}
                </span>
              </li>
            ))}
          </ul>

          <div className="upload-footer">
            <span className="muted small">
              {[
                done && `${done} added`,
                failed && `${failed} failed`,
                skipped && `${skipped} skipped`,
                waiting && `${waiting} ready`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <div className="dropzone-actions">
              {failed > 0 && !busy && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={retryFailed}
                >
                  Retry failed
                </button>
              )}
              {!busy && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setItems([])}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy || waiting === 0}
                onClick={() => void start()}
              >
                {busy
                  ? "Adding…"
                  : `Add ${waiting} ${waiting === 1 ? "file" : "files"} to memory`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const isFailed = (s: Status) =>
  s.state === "done" && s.outcome.kind === "error";

function statusLabel(s: Status): string {
  if (s.state === "done") {
    const o = s.outcome;
    if (o.kind === "added")
      return o.replaced ? "added · replaces older" : "added";
    if (o.kind === "already") return "already in library";
    return o.message;
  }
  if (s.state === "skipped") return `skipped · ${s.reason}`;
  if (s.state === "uploading") return "uploading…";
  return "ready";
}

function statusClass(s: Status): string {
  if (s.state === "done") return isFailed(s) ? "failed" : "ok";
  return s.state;
}

/** Every file in a drop, walking into dropped folders. Paths keep the folder they came from. */
async function filesFromDrop(
  dt: DataTransfer,
): Promise<{ file: File; path: string }[]> {
  const entries = Array.from(dt.items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, path: file.name }));
  }
  const out: { file: File; path: string }[] = [];
  const walk = async (
    entry: FileSystemEntry,
    prefix: string,
  ): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push({ file, path: prefix + entry.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands back at most ~100 at a time; keep reading until it returns none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}
