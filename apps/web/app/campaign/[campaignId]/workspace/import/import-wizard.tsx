"use client";

// Bring a DM's notes in, once: pick or drop files or a whole folder, see the folders and pages it
// will make, choose where they go, and import. Folders keep their shape; every file becomes an
// editable page, starting as working prep.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  beginImport,
  endImport,
  importPosted,
  importUploaded,
  prepareImportUpload,
} from "./actions";

interface Picked {
  file: File;
  /** Path inside what was picked or dropped: "Ondera/NPCs/Vess.md". */
  path: string;
}

type Outcome =
  | { state: "waiting" }
  | { state: "working" }
  | { state: "imported"; pageId: string }
  | { state: "duplicate"; existing: string }
  | { state: "skipped"; reason: string };

const CONCURRENCY = 3;
const SYSTEM_FILES = new Set(["thumbs.db", "desktop.ini"]);

function localSkip(
  path: string,
  size: number,
  accept: readonly string[],
  maxBytes: number,
) {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith(".") || SYSTEM_FILES.has(base.toLowerCase()))
    return "system file";
  const lower = base.toLowerCase();
  if (!accept.some((ext) => lower.endsWith(ext))) return "can't read this type";
  if (size === 0) return "empty";
  if (size > maxBytes) return `over the ${maxBytes / 1024 / 1024}MB limit`;
  return null;
}

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");

export function ImportWizard({
  campaignId,
  folders,
  accept,
  maxBytes,
  direct,
}: {
  campaignId: string;
  folders: { id: string; path: string }[];
  accept: readonly string[];
  maxBytes: number;
  direct: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [destination, setDestination] = useState<string>("");
  const [wrap, setWrap] = useState(true);
  const [wrapName, setWrapName] = useState("");
  const [phase, setPhase] = useState<"pick" | "review" | "importing" | "done">(
    "pick",
  );
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () =>
      picked.map((p, i) => ({
        ...p,
        index: i,
        skip: localSkip(p.path, p.file.size, accept, maxBytes),
      })),
    [picked, accept, maxBytes],
  );
  const importable = rows.filter((r) => !r.skip);
  const skipped = rows.filter((r) => r.skip);
  const topFolders = useMemo(() => {
    const tops = new Set(
      importable
        .map((r) => r.path.split("/"))
        .filter((p) => p.length > 1)
        .map((p) => p[0]!),
    );
    return [...tops];
  }, [importable]);
  const folderCount = useMemo(
    () =>
      new Set(
        importable.flatMap((r) => {
          const parts = dirOf(r.path).split("/").filter(Boolean);
          return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
        }),
      ).size,
    [importable],
  );

  function take(files: Picked[]) {
    if (files.length === 0) return;
    setPicked(files);
    setOutcomes({});
    setError(null);
    const looseFiles = files.some((f) => !f.path.includes("/"));
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    // A single dropped folder already names itself; loose files get a folder to land in.
    const single = !looseFiles && tops.size === 1;
    setWrap(!single);
    setWrapName(
      single
        ? ""
        : `Imported ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
    );
    setPhase("review");
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (phase === "importing") return;
    take(await filesFromDrop(e.dataTransfer));
  }

  function folderPathFor(path: string): string {
    const dir = dirOf(path);
    const prefix = wrap && wrapName.trim() ? wrapName.trim() : "";
    return [prefix, dir].filter(Boolean).join("/");
  }

  async function run() {
    setPhase("importing");
    setError(null);
    const label =
      (wrap && wrapName.trim()) ||
      topFolders[0] ||
      `${importable.length} files`;
    const begun = await beginImport(campaignId, {
      destinationFolderId: destination || null,
      label,
      folderPaths: importable.map((r) => folderPathFor(r.path)),
    });
    if (!begun.ok) {
      setError(begun.error);
      setPhase("review");
      return;
    }
    const { batchId, folders: folderIds } = begun;
    const set = (i: number, o: Outcome) =>
      setOutcomes((prev) => ({ ...prev, [i]: o }));

    let next = 0;
    const worker = async () => {
      while (next < importable.length) {
        const row = importable[next++]!;
        set(row.index, { state: "working" });
        const folderId = folderIds[folderPathFor(row.path)] ?? null;
        const fileName = row.path.split("/").pop()!;
        try {
          let result;
          if (direct) {
            const prepared = await prepareImportUpload(
              campaignId,
              fileName,
              row.file.size,
            );
            if ("error" in prepared) {
              set(row.index, { state: "skipped", reason: prepared.error });
              continue;
            }
            const put = await fetch(prepared.uploadUrl, {
              method: "PUT",
              headers: {
                "content-type": row.file.type || "application/octet-stream",
                "x-upsert": "false",
              },
              body: row.file,
            });
            if (!put.ok) {
              set(row.index, { state: "skipped", reason: "upload failed" });
              continue;
            }
            result = await importUploaded(campaignId, batchId, {
              key: prepared.key,
              fileName,
              folderId,
            });
          } else {
            const form = new FormData();
            form.set("campaignId", campaignId);
            form.set("batchId", batchId);
            form.set("fileName", fileName);
            form.set("folderId", folderId ?? "");
            form.set("file", row.file);
            result = await importPosted(form);
          }
          if (result.kind === "imported")
            set(row.index, { state: "imported", pageId: result.pageId });
          else if (result.kind === "duplicate")
            set(row.index, {
              state: "duplicate",
              existing: result.existingTitle,
            });
          else set(row.index, { state: "skipped", reason: result.reason });
        } catch {
          set(row.index, { state: "skipped", reason: "upload failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await endImport(campaignId, batchId, skipped.length);
    setPhase("done");
    router.refresh();
  }

  const done = Object.values(outcomes).filter(
    (o) => o.state === "imported",
  ).length;
  const dupes = Object.values(outcomes).filter(
    (o) => o.state === "duplicate",
  ).length;
  const failed = Object.values(outcomes).filter(
    (o) => o.state === "skipped",
  ).length;
  const destinationName = destination
    ? folders.find((f) => f.id === destination)?.path
    : "the top level";

  return (
    <div className="imp">
      {(phase === "pick" || phase === "review") && (
        <div
          className={`dropzone${dragging ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="dropzone-title">
            Drop a folder of notes, or files, here
          </p>
          <p className="muted small">
            {accept.join(", ")} · folders keep their structure · up to{" "}
            {maxBytes / 1024 / 1024}MB a file
          </p>
          <div className="dropzone-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => folderInput.current?.click()}
            >
              Choose a folder
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => fileInput.current?.click()}
            >
              Choose files
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={accept.join(",")}
            onChange={(e) => {
              take(
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
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              take(
                Array.from(e.target.files ?? []).map((file) => ({
                  file,
                  path: file.webkitRelativePath || file.name,
                })),
              );
              e.target.value = "";
            }}
          />
        </div>
      )}

      {phase !== "pick" && (
        <section className="imp-review">
          <p className="imp-summary">
            <strong>{importable.length}</strong>{" "}
            {importable.length === 1 ? "page" : "pages"}
            {folderCount > 0 && (
              <>
                {" "}
                in <strong>{folderCount}</strong>{" "}
                {folderCount === 1 ? "folder" : "folders"}
              </>
            )}
            {skipped.length > 0 && (
              <span className="muted"> · {skipped.length} skipped</span>
            )}
          </p>

          {phase === "review" && (
            <div className="imp-options">
              <label className="imp-field">
                <span>Put it in</span>
                <select
                  className="ws-select"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Top level of the workspace</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.path}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={wrap}
                  onChange={(e) => setWrap(e.target.checked)}
                />
                Inside a new folder
              </label>
              {wrap && (
                <input
                  className="ws-name-input"
                  value={wrapName}
                  onChange={(e) => setWrapName(e.target.value)}
                  aria-label="New folder name"
                  placeholder="Folder name"
                />
              )}
              <p className="muted small" style={{ margin: 0 }}>
                Everything arrives as working notes. Players see nothing until
                you mark it canon. Word and PDF files keep their text; the
                original file stays attached to the page.
              </p>
              <div className="dropzone-actions" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={
                    importable.length === 0 || (wrap && !wrapName.trim())
                  }
                  onClick={() => void run()}
                >
                  Import {importable.length}{" "}
                  {importable.length === 1 ? "page" : "pages"}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setPicked([]);
                    setPhase("pick");
                  }}
                >
                  Start over
                </button>
              </div>
            </div>
          )}

          {(phase === "importing" || phase === "done") && (
            <p className="imp-progress" aria-live="polite">
              {phase === "importing" ? "Importing… " : "Done. "}
              {done} imported
              {dupes > 0 && ` · ${dupes} already here`}
              {failed > 0 && ` · ${failed} couldn't be imported`}
              {phase === "done" && <> into {destinationName}.</>}
            </p>
          )}
          {error && <p className="notice error">{error}</p>}

          <ul className="upload-list">
            {rows.map((r) => {
              const o =
                outcomes[r.index] ??
                (r.skip
                  ? { state: "skipped" as const, reason: r.skip }
                  : { state: "waiting" as const });
              return (
                <li key={r.index} className="upload-row">
                  <span className="upload-name" title={r.path}>
                    {o.state === "imported" ? (
                      <Link
                        href={`/campaign/${campaignId}/workspace/p/${o.pageId}`}
                      >
                        {r.path}
                      </Link>
                    ) : (
                      r.path
                    )}
                  </span>
                  <span
                    className={`upload-status ${o.state === "imported" ? "ok" : o.state === "skipped" ? "failed" : ""}`}
                  >
                    {o.state === "waiting" && "ready"}
                    {o.state === "working" && "importing…"}
                    {o.state === "imported" && "imported"}
                    {o.state === "duplicate" &&
                      `already here as “${o.existing}”`}
                    {o.state === "skipped" && `skipped · ${o.reason}`}
                  </span>
                </li>
              );
            })}
          </ul>

          {phase === "done" && (
            <div className="dropzone-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setPicked([]);
                  setOutcomes({});
                  setPhase("pick");
                }}
              >
                Import more
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Every file in a drop, walking into dropped folders. Paths keep the folders they came from. */
async function filesFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const entries = Array.from(dt.items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, path: file.name }));
  }
  const out: Picked[] = [];
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
