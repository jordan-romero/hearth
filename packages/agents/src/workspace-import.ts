// One-time imports into the workspace (docs/workspace.md §5): a DM's folders of notes become
// workspace folders and editable pages. Everything imported starts as working prep — nothing
// reaches a player until the DM marks it canon.
//
// The flow, driven by the import screen:
//   1. startFileImport   — make the import record and every folder it needs, in one go
//                          (so files uploading in parallel never race to create the same one)
//   2. importFile × n    — the browser puts each file in storage; this turns it into a page
//   3. finishImport      — record how it went
//   undoImport           — trash its pages and remove its folders once empty
//
// Every call is scoped to the campaign; ids from the browser are checked, never trusted.

import { createHash } from "node:crypto";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { prisma, type Prisma } from "@hearth/db";
import { getDocument, removeDocumentObject } from "./storage.js";
import { isDirectUploadKey, MAX_UPLOAD_BYTES } from "./upload.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { markdownToPage, textToPage } from "./markdown-to-page.js";
import { pageToMarkdown, type PmNode } from "./page-markdown.js";
import { schedulePageIndex, WorkspaceError } from "./workspace.js";

export const IMPORTABLE_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".docx",
  ".pdf",
] as const;

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
};

/** Why a file can't be imported, or null. Names and sizes come from the browser; they're
 * checked again on the bytes that actually arrive. */
export function importProblem(fileName: string, size: number): string | null {
  const base = fileName.split("/").pop() ?? fileName;
  if (!base || base.startsWith(".")) return "system file";
  if (!(IMPORTABLE_EXTENSIONS as readonly string[]).includes(extOf(base))) {
    return "can't read this type";
  }
  if (size <= 0) return "empty";
  if (size > MAX_UPLOAD_BYTES) {
    return `${(size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`;
  }
  return null;
}

/** A page title from a file name: no extension, no folder. */
export function titleFromFileName(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return (
    (i > 0 ? base.slice(0, i) : base)
      .replace(/[_]+/g, " ")
      .trim()
      .slice(0, 200) || "Untitled"
  );
}

/**
 * A file's bytes as a page. Markdown and text keep their structure; Word keeps headings, lists,
 * tables and emphasis; PDF comes through as text. `keepOriginal` is true where layout is lost,
 * so the original file stays attached to the page.
 */
export async function fileToPage(
  data: Buffer,
  fileName: string,
): Promise<{ content: PmNode; keepOriginal: boolean }> {
  const ext = extOf(fileName);
  if (ext === ".md" || ext === ".markdown") {
    return {
      content: markdownToPage(data.toString("utf8")),
      keepOriginal: false,
    };
  }
  if (ext === ".txt") {
    return { content: textToPage(data.toString("utf8")), keepOriginal: false };
  }
  if (ext === ".docx") {
    const { value: html } = await mammoth.convertToHtml({ buffer: data });
    return {
      content: markdownToPage(htmlToMarkdown(html)),
      keepOriginal: true,
    };
  }
  if (ext === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractPdfText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { content: textToPage(pages.join("\n\n")), keepOriginal: true };
  }
  throw new WorkspaceError(`Hearth can't import ${ext || "that"} files.`);
}

async function ownFolder(
  campaignId: string,
  folderId: string | null,
): Promise<void> {
  if (folderId === null) return;
  const n = await prisma.folder.count({ where: { id: folderId, campaignId } });
  if (n === 0) throw new WorkspaceError("That folder doesn't exist any more.");
}

/** Clean a folder path from the browser: "Notes/NPCs" → ["Notes", "NPCs"]. */
function pathParts(path: string): string[] {
  return path
    .split("/")
    .map((p) => p.trim().slice(0, 200))
    .filter((p) => p && p !== "." && p !== "..");
}

/**
 * Begin an import: the record, and every folder the files need, created up front under the
 * destination. Returns each folder path's id ("" is the destination itself).
 */
export async function startFileImport(
  campaignId: string,
  input: {
    destinationFolderId: string | null;
    label: string;
    folderPaths: string[];
  },
): Promise<{ batchId: string; folders: Record<string, string | null> }> {
  await ownFolder(campaignId, input.destinationFolderId);
  const paths = [
    ...new Set(
      input.folderPaths.map((p) => pathParts(p).join("/")).filter(Boolean),
    ),
  ];
  if (paths.length > 2000)
    throw new WorkspaceError("That's more than 2,000 folders in one import.");

  return prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          campaignId,
          source: "FILES",
          destinationFolderId: input.destinationFolderId,
          label: input.label.trim().slice(0, 200) || "Imported files",
        },
        select: { id: true },
      });
      const folders: Record<string, string | null> = {
        "": input.destinationFolderId,
      };
      // Every prefix of every path, shallowest first, so a parent always exists first.
      const all = new Set<string>();
      for (const p of paths) {
        const parts = p.split("/");
        for (let i = 1; i <= parts.length; i++)
          all.add(parts.slice(0, i).join("/"));
      }
      const ordered = [...all].sort(
        (a, b) =>
          a.split("/").length - b.split("/").length || a.localeCompare(b),
      );
      for (const path of ordered) {
        const parts = path.split("/");
        const parent = folders[parts.slice(0, -1).join("/")] ?? null;
        const folder = await tx.folder.create({
          data: {
            campaignId,
            parentId: parent,
            name: parts[parts.length - 1]!,
            importBatchId: batch.id,
          },
          select: { id: true },
        });
        folders[path] = folder.id;
      }
      return { batchId: batch.id, folders };
    },
    { timeout: 60_000 },
  );
}

export type ImportFileResult =
  | { kind: "imported"; pageId: string; title: string }
  | { kind: "duplicate"; existingTitle: string }
  | { kind: "skipped"; reason: string };

/** Turn one uploaded file into a page in the given folder of this import. */
export async function importFile(
  campaignId: string,
  batchId: string,
  input: { key: string; fileName: string; folderId: string | null },
): Promise<ImportFileResult> {
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, campaignId },
    select: { status: true },
  });
  if (!batch) throw new WorkspaceError("That import doesn't exist.");
  if (!isDirectUploadKey(campaignId, input.key)) {
    throw new WorkspaceError("That upload doesn't belong to this campaign.");
  }
  await ownFolder(campaignId, input.folderId);

  const data = await getDocument(input.key);
  const discard = () => removeDocumentObject(input.key).catch(() => {});
  const problem = importProblem(input.fileName, data.length);
  if (problem) {
    await discard();
    await bump(batchId, "filesSkipped");
    return { kind: "skipped", reason: problem };
  }

  const importHash = createHash("sha256").update(data).digest("hex");
  const existing = await prisma.page.findFirst({
    where: { campaignId, importHash, archivedAt: null },
    select: { title: true },
  });
  if (existing) {
    await discard();
    await bump(batchId, "filesSkipped");
    return { kind: "duplicate", existingTitle: existing.title || "Untitled" };
  }

  let converted: Awaited<ReturnType<typeof fileToPage>>;
  try {
    converted = await fileToPage(data, input.fileName);
  } catch (err) {
    console.error(`[import] couldn't read ${input.fileName}:`, err);
    await discard();
    await bump(batchId, "filesSkipped");
    return { kind: "skipped", reason: "couldn't be read" };
  }
  if (!converted.keepOriginal) await discard();

  const title = titleFromFileName(input.fileName);
  const markdown = pageToMarkdown(converted.content);
  const content = converted.content as unknown as Prisma.InputJsonValue;
  const page = await prisma.$transaction(async (tx) => {
    const created = await tx.page.create({
      data: {
        campaignId,
        folderId: input.folderId,
        title,
        content,
        markdown,
        importBatchId: batchId,
        importHash,
        ...(converted.keepOriginal
          ? {
              originalFilePath: input.key,
              originalFileName: input.fileName.split("/").pop(),
            }
          : {}),
      },
      select: { id: true },
    });
    await tx.pageVersion.create({
      data: { pageId: created.id, title, content, markdown, cause: "IMPORT" },
    });
    await tx.importBatch.update({
      where: { id: batchId },
      data: { pagesCreated: { increment: 1 } },
    });
    return created;
  });
  await schedulePageIndex(page.id, 5);
  return { kind: "imported", pageId: page.id, title };
}

function bump(batchId: string, field: "filesSkipped" | "pagesCreated") {
  return prisma.importBatch.update({
    where: { id: batchId },
    data: { [field]: { increment: 1 } },
  });
}

/** The browser skipped some files before uploading (wrong type, too big): count them too. */
export async function finishImport(
  campaignId: string,
  batchId: string,
  skippedInBrowser: number,
): Promise<void> {
  await prisma.importBatch.updateMany({
    where: { id: batchId, campaignId, status: "RUNNING" },
    data: {
      status: "DONE",
      finishedAt: new Date(),
      filesSkipped: {
        increment: Math.max(0, Math.floor(skippedInBrowser) || 0),
      },
    },
  });
}

/** Undo an import: its pages go to the trash (restorable), and its folders go once empty. */
export async function undoImport(
  campaignId: string,
  batchId: string,
): Promise<number> {
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, campaignId },
    select: { id: true },
  });
  if (!batch) throw new WorkspaceError("That import doesn't exist.");

  const pages = await prisma.page.findMany({
    where: { campaignId, importBatchId: batchId, archivedAt: null },
    select: { id: true },
  });
  await prisma.page.updateMany({
    where: { id: { in: pages.map((p) => p.id) } },
    data: { archivedAt: new Date() },
  });
  for (const p of pages) await schedulePageIndex(p.id, 0);

  // Its folders, deepest first; any that now hold something the DM added are left alone.
  const folders = await prisma.folder.findMany({
    where: { campaignId, importBatchId: batchId },
    select: { id: true, parentId: true },
  });
  const depth = new Map<string, number>();
  const byId = new Map(folders.map((f) => [f.id, f]));
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const parent = byId.get(id)?.parentId;
    const d = parent && byId.has(parent) ? depthOf(parent) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const f of [...folders].sort((a, b) => depthOf(b.id) - depthOf(a.id))) {
    const [children, live] = await Promise.all([
      prisma.folder.count({ where: { parentId: f.id } }),
      prisma.page.count({ where: { folderId: f.id, archivedAt: null } }),
    ]);
    if (children === 0 && live === 0) {
      await prisma.$transaction([
        prisma.page.updateMany({
          where: { folderId: f.id },
          data: { folderId: null },
        }),
        prisma.folder.delete({ where: { id: f.id } }),
      ]);
    }
  }

  await prisma.importBatch.update({
    where: { id: batchId },
    data: { undoneAt: new Date() },
  });
  return pages.length;
}

export function listImports(campaignId: string) {
  return prisma.importBatch.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      label: true,
      source: true,
      status: true,
      pagesCreated: true,
      filesSkipped: true,
      createdAt: true,
      undoneAt: true,
      message: true,
    },
  });
}

/** An imported page's original file, if it kept one: where it is and what it was called. */
export async function pageOriginal(
  campaignId: string,
  pageId: string,
): Promise<{ data: Buffer; fileName: string } | null> {
  const page = await prisma.page.findFirst({
    where: { id: pageId, campaignId },
    select: { originalFilePath: true, originalFileName: true },
  });
  if (!page?.originalFilePath) return null;
  return {
    data: await getDocument(page.originalFilePath),
    fileName: page.originalFileName ?? "original",
  };
}
