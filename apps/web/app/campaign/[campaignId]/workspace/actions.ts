"use server";

// Every workspace change goes through here. A server action is its own entry point — anyone can
// call it with any arguments — so each one re-checks that the caller is this campaign's DM, and
// the workspace service checks that every id it's given belongs to that campaign.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  archivePage,
  createFolder,
  createPage,
  deleteFolder,
  moveFolder,
  movePage,
  renameFolder,
  restorePage,
  restorePageVersion,
  savePage,
  WorkspaceError,
  type PmNode,
  type SaveResult,
} from "@hearth/agents";
import { requireDm } from "@/lib/campaign";

export type ActionResult = { ok: true } | { ok: false; error: string };

const base = (campaignId: string) => `/campaign/${campaignId}/workspace`;
const optionalId = (v: unknown) => (typeof v === "string" && v ? v : null);

async function run(
  campaignId: string,
  fn: () => Promise<void>,
): Promise<ActionResult> {
  await requireDm(String(campaignId));
  try {
    await fn();
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, error: err.message };
    console.error("workspace action failed:", err);
    return { ok: false, error: "That didn't work — try again." };
  }
  revalidatePath(base(campaignId), "layout");
  return { ok: true };
}

export async function newFolder(
  campaignId: string,
  parentId: string | null,
  name: string,
) {
  return run(campaignId, async () => {
    await createFolder(campaignId, optionalId(parentId), String(name));
  });
}

export async function renameFolderAction(
  campaignId: string,
  folderId: string,
  name: string,
) {
  return run(campaignId, () =>
    renameFolder(campaignId, String(folderId), String(name)),
  );
}

export async function moveFolderAction(
  campaignId: string,
  folderId: string,
  parentId: string | null,
) {
  return run(campaignId, () =>
    moveFolder(campaignId, String(folderId), optionalId(parentId)),
  );
}

export async function deleteFolderAction(campaignId: string, folderId: string) {
  return run(campaignId, () => deleteFolder(campaignId, String(folderId)));
}

/** Create a page and open it. */
export async function newPage(campaignId: string, folderId: string | null) {
  await requireDm(String(campaignId));
  let pageId: string;
  try {
    pageId = await createPage(campaignId, optionalId(folderId));
  } catch (err) {
    if (err instanceof WorkspaceError)
      return { ok: false as const, error: err.message };
    throw err;
  }
  revalidatePath(base(campaignId), "layout");
  redirect(`${base(campaignId)}/p/${pageId}`);
}

/** Create a page from a link ("[[Ildin]]" with no Ildin yet), without leaving the page the DM
 * is writing. Returns the new page's id. */
export async function createLinkedPageAction(
  campaignId: string,
  folderId: string | null,
  title: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await requireDm(String(campaignId));
  try {
    const id = await createPage(
      campaignId,
      optionalId(folderId),
      String(title ?? "").slice(0, 200),
    );
    revalidatePath(base(campaignId), "layout");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function movePageAction(
  campaignId: string,
  pageId: string,
  folderId: string | null,
) {
  return run(campaignId, () =>
    movePage(campaignId, String(pageId), optionalId(folderId)),
  );
}

export async function archivePageAction(campaignId: string, pageId: string) {
  await requireDm(String(campaignId));
  await archivePage(campaignId, String(pageId));
  revalidatePath(base(campaignId), "layout");
  redirect(base(campaignId));
}

export async function restorePageAction(campaignId: string, pageId: string) {
  return run(campaignId, () => restorePage(campaignId, String(pageId)));
}

export async function savePageAction(
  campaignId: string,
  pageId: string,
  input: { title: string; content: string; baseRevision: number },
): Promise<SaveResult | { ok: false; error: string }> {
  await requireDm(String(campaignId));
  let content: PmNode;
  try {
    content = JSON.parse(String(input.content)) as PmNode;
  } catch {
    return {
      ok: false,
      error: "That page couldn't be read — reload and try again.",
    };
  }
  try {
    const result = await savePage(campaignId, String(pageId), {
      title: String(input.title ?? ""),
      content,
      baseRevision: Number(input.baseRevision),
    });
    // No revalidation here: autosave runs every few seconds, and the editor refreshes the sidebar
    // itself when the title changes.
    return result;
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, error: err.message };
    console.error("saving page failed:", err);
    return { ok: false, error: "Couldn't save — check your connection." };
  }
}

export async function restoreVersionAction(
  campaignId: string,
  pageId: string,
  versionId: string,
) {
  await requireDm(String(campaignId));
  await restorePageVersion(campaignId, String(pageId), String(versionId));
  revalidatePath(base(campaignId), "layout");
  redirect(`${base(campaignId)}/p/${pageId}`);
}
