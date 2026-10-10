"use server";

// The import screen's server side. Each action re-checks the DM (a server action is its own entry
// point); the import service checks every id belongs to the campaign.

import { revalidatePath } from "next/cache";
import {
  directUploadKey,
  finishImport,
  importFile,
  importProblem,
  prepareDirectUpload,
  putDocument,
  startFileImport,
  undoImport,
  WorkspaceError,
  type ImportFileResult,
} from "@hearth/agents";
import { requireDm } from "@/lib/campaign";

const workspace = (campaignId: string) => `/campaign/${campaignId}/workspace`;
const optionalId = (v: unknown) => (typeof v === "string" && v ? v : null);
const position = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export type BeginResult =
  | { ok: true; batchId: string; folders: Record<string, string | null> }
  | { ok: false; error: string };

export async function beginImport(
  campaignId: string,
  input: {
    destinationFolderId: string | null;
    label: string;
    folderPaths: string[];
  },
): Promise<BeginResult> {
  await requireDm(String(campaignId));
  try {
    const result = await startFileImport(campaignId, {
      destinationFolderId: optionalId(input.destinationFolderId),
      label: String(input.label ?? ""),
      folderPaths: Array.isArray(input.folderPaths)
        ? input.folderPaths.map(String)
        : [],
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, error: err.message };
    console.error("starting import failed:", err);
    return { ok: false, error: "Couldn't start the import — try again." };
  }
}

/** Where the browser should put one file (direct-to-storage). */
export async function prepareImportUpload(
  campaignId: string,
  fileName: string,
  size: number,
) {
  await requireDm(String(campaignId));
  const problem = importProblem(String(fileName), Number(size));
  if (problem) return { error: problem };
  return prepareDirectUpload(campaignId, String(fileName));
}

/** The browser has put a file in storage: make it a page. */
export async function importUploaded(
  campaignId: string,
  batchId: string,
  input: {
    key: string;
    fileName: string;
    folderId: string | null;
    position: number;
  },
): Promise<ImportFileResult> {
  await requireDm(String(campaignId));
  try {
    return await importFile(campaignId, String(batchId), {
      key: String(input.key),
      fileName: String(input.fileName),
      folderId: optionalId(input.folderId),
      position: position(input.position),
    });
  } catch (err) {
    if (err instanceof WorkspaceError)
      return { kind: "skipped", reason: err.message };
    console.error("importing a file failed:", err);
    return { kind: "skipped", reason: "couldn't be imported" };
  }
}

/** Where storage can't take direct uploads (local disk), the file comes through the server. */
export async function importPosted(
  formData: FormData,
): Promise<ImportFileResult> {
  const campaignId = String(formData.get("campaignId") ?? "");
  await requireDm(campaignId);
  const file = formData.get("file");
  const fileName = String(formData.get("fileName") ?? "");
  if (!(file instanceof File)) return { kind: "skipped", reason: "no file" };
  const problem = importProblem(fileName, file.size);
  if (problem) return { kind: "skipped", reason: problem };
  const key = directUploadKey(campaignId, fileName);
  await putDocument(
    key,
    Buffer.from(await file.arrayBuffer()),
    file.type || undefined,
  );
  return importUploaded(campaignId, String(formData.get("batchId") ?? ""), {
    key,
    fileName,
    folderId: optionalId(formData.get("folderId")),
    position: position(formData.get("position")),
  });
}

export async function endImport(
  campaignId: string,
  batchId: string,
  skippedInBrowser: number,
) {
  await requireDm(String(campaignId));
  await finishImport(campaignId, String(batchId), Number(skippedInBrowser));
  revalidatePath(workspace(campaignId), "layout");
}

export async function undoImportAction(campaignId: string, batchId: string) {
  await requireDm(String(campaignId));
  await undoImport(campaignId, String(batchId));
  revalidatePath(workspace(campaignId), "layout");
}
