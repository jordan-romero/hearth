// OneNote import (docs/workspace.md §5): a one-time backfill of a DM's notebooks into the
// workspace. Notebook → folder, section group → folder, section → folder, page → page. Pages
// arrive as working prep, like every import; afterwards Hearth is where they're edited.
//
// Microsoft Graph, delegated access (Notes.Read), "common" tenant: personal and work/school
// accounts both work. The refresh token is the only credential kept, sealed at rest
// (secrets.ts); access tokens live for one request or one import and are never stored.

import { prisma, type Prisma } from "@hearth/db";
import { canSealSecrets, openSecret, sealSecret } from "./secrets.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { markdownToPage } from "./markdown-to-page.js";
import { pageToMarkdown } from "./page-markdown.js";
import { schedulePageIndex, WorkspaceError } from "./workspace.js";
import { getQueue } from "./queue.js";
import { ONENOTE_IMPORT_QUEUE, type OneNoteImportJob } from "./jobs.js";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access User.Read Notes.Read";
const TOKEN_PURPOSE = "onenote-refresh-token";

/** Whether this deployment can offer OneNote: an Azure app, and a key to seal its tokens. */
export function oneNoteConfigured(): boolean {
  return !!(
    process.env.MICROSOFT_CLIENT_ID &&
    process.env.MICROSOFT_CLIENT_SECRET &&
    canSealSecrets()
  );
}

function client() {
  const id = process.env.MICROSOFT_CLIENT_ID;
  const secret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error("MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET not set");
  return { id, secret };
}

/** The Microsoft sign-in page to send the DM to. `state` must come back unchanged. */
export function oneNoteAuthorizeUrl(
  redirectUri: string,
  state: string,
): string {
  const q = new URLSearchParams({
    client_id: client().id,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
    // Always offer the account picker: the browser may be signed in to a different account
    // from the one the notebooks live in.
    prompt: "select_account",
  });
  return `${AUTHORITY}/authorize?${q}`;
}

/** Microsoft refused the stored sign-in (revoked, expired, password changed): connect again. */
export class OneNoteAuthError extends Error {}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
}

async function token(params: Record<string, string>): Promise<TokenResponse> {
  const { id, secret } = client();
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      scope: SCOPES,
      ...params,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & {
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    if (
      body.error === "invalid_grant" ||
      body.error === "interaction_required"
    ) {
      throw new OneNoteAuthError(body.error);
    }
    throw new Error(
      `Microsoft token request failed: ${body.error ?? res.status}`,
    );
  }
  return body;
}

/** Finish sign-in: trade the code for tokens and keep the connection for this campaign. */
export async function connectOneNote(input: {
  campaignId: string;
  membershipId: string;
  code: string;
  redirectUri: string;
}): Promise<void> {
  const t = await token({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  if (!t.refresh_token) throw new Error("Microsoft returned no refresh token");
  const me = await graphJson<{
    displayName?: string;
    userPrincipalName?: string;
    mail?: string;
  }>(t.access_token, "/me?$select=displayName,userPrincipalName,mail");
  const data = {
    connectedByMembershipId: input.membershipId,
    accountName: me.mail || me.userPrincipalName || me.displayName || null,
    refreshTokenEnc: sealSecret(t.refresh_token, TOKEN_PURPOSE),
  };
  await prisma.oneNoteConnection.upsert({
    where: { campaignId: input.campaignId },
    create: { campaignId: input.campaignId, ...data },
    update: data,
  });
}

export function getOneNoteConnection(
  campaignId: string,
): Promise<{ accountName: string | null } | null> {
  return prisma.oneNoteConnection.findUnique({
    where: { campaignId },
    select: { accountName: true },
  });
}

/** Forget the Microsoft account. What was imported stays. */
export async function disconnectOneNote(campaignId: string): Promise<void> {
  await prisma.oneNoteConnection.deleteMany({ where: { campaignId } });
}

/** A fresh access token. Microsoft rotates refresh tokens, so the new one is stored. */
async function accessToken(campaignId: string): Promise<string> {
  const conn = await prisma.oneNoteConnection.findUnique({
    where: { campaignId },
    select: { refreshTokenEnc: true },
  });
  if (!conn) throw new OneNoteAuthError("not connected");
  let refresh: string;
  try {
    refresh = openSecret(conn.refreshTokenEnc, TOKEN_PURPOSE);
  } catch {
    throw new OneNoteAuthError("stored sign-in can't be read"); // e.g. the key was rotated
  }
  const t = await token({
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  if (t.refresh_token) {
    await prisma.oneNoteConnection.update({
      where: { campaignId },
      data: { refreshTokenEnc: sealSecret(t.refresh_token, TOKEN_PURPOSE) },
    });
  }
  return t.access_token;
}

async function graph(at: string, path: string): Promise<Response> {
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  // OneNote throttles hard; honour Retry-After rather than failing a long import.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${at}` },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
      await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
      continue;
    }
    if (res.status === 401) throw new OneNoteAuthError("unauthorized");
    if (!res.ok)
      throw new Error(
        `Microsoft Graph ${res.status} for ${path.split("?")[0]}`,
      );
    return res;
  }
}

async function graphJson<T>(at: string, path: string): Promise<T> {
  return (await graph(at, path)).json() as Promise<T>;
}

async function graphAll<T>(at: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: { value: T[]; "@odata.nextLink"?: string } = await graphJson(
      at,
      next,
    );
    out.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return out;
}

export interface OneNoteSection {
  id: string;
  name: string;
  /** Notebook, then any section groups, outermost first: ["Ondera", "Factions"]. */
  path: string[];
}

interface ParentRef {
  id?: string;
  displayName?: string;
}

/** Every section on the account, with the notebook and section groups it sits in. */
async function sectionsWithPaths(at: string): Promise<OneNoteSection[]> {
  const [groups, sections] = await Promise.all([
    graphAll<{
      id: string;
      displayName: string;
      parentNotebook?: ParentRef;
      parentSectionGroup?: ParentRef;
    }>(
      at,
      "/me/onenote/sectionGroups?$select=id,displayName&$expand=parentNotebook($select=id,displayName),parentSectionGroup($select=id)",
    ),
    graphAll<{
      id: string;
      displayName: string;
      parentNotebook?: ParentRef;
      parentSectionGroup?: ParentRef;
    }>(
      at,
      "/me/onenote/sections?$select=id,displayName&$expand=parentNotebook($select=id,displayName),parentSectionGroup($select=id)",
    ),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupPath = (id: string | undefined, depth = 0): string[] => {
    const g = id ? groupById.get(id) : undefined;
    if (!g || depth > 20) return [];
    return [...groupPath(g.parentSectionGroup?.id, depth + 1), g.displayName];
  };
  return sections
    .map((s) => ({
      id: s.id,
      name: s.displayName,
      path: [
        s.parentNotebook?.displayName ??
          groupNotebook(s.parentSectionGroup?.id, groupById) ??
          "Notebook",
        ...groupPath(s.parentSectionGroup?.id),
      ],
    }))
    .sort((a, b) =>
      [...a.path, a.name]
        .join("/")
        .localeCompare([...b.path, b.name].join("/")),
    );
}

/** A section inside a group may not report its notebook; the outermost group does. */
function groupNotebook(
  id: string | undefined,
  groups: Map<
    string,
    { parentNotebook?: ParentRef; parentSectionGroup?: ParentRef }
  >,
): string | undefined {
  for (let g = id ? groups.get(id) : undefined, d = 0; g && d < 20; d++) {
    if (g.parentNotebook?.displayName) return g.parentNotebook.displayName;
    g = g.parentSectionGroup?.id
      ? groups.get(g.parentSectionGroup.id)
      : undefined;
  }
  return undefined;
}

/** The connected account's sections, for the DM to choose from. */
export async function listOneNoteSections(
  campaignId: string,
): Promise<OneNoteSection[]> {
  return sectionsWithPaths(await accessToken(campaignId));
}

/** Queue an import of the chosen sections into the workspace. Runs in the worker. */
export async function startOneNoteImport(
  campaignId: string,
  input: {
    sectionIds: string[];
    destinationFolderId: string | null;
    label: string;
  },
): Promise<string> {
  const sectionIds = [...new Set(input.sectionIds.map(String).filter(Boolean))];
  if (sectionIds.length === 0)
    throw new WorkspaceError("Choose at least one section.");
  if (sectionIds.length > 500)
    throw new WorkspaceError("That's more than 500 sections at once.");
  if (input.destinationFolderId) {
    const n = await prisma.folder.count({
      where: { id: input.destinationFolderId, campaignId },
    });
    if (n === 0)
      throw new WorkspaceError("That folder doesn't exist any more.");
  }
  if (!(await getOneNoteConnection(campaignId))) {
    throw new WorkspaceError("Connect OneNote first.");
  }
  // Two imports at once could each find a page not yet imported and both bring it in.
  const running = await prisma.importBatch.count({
    where: {
      campaignId,
      source: "ONENOTE",
      status: "RUNNING",
      // One stuck "running" by a crashed worker mustn't block imports for good.
      createdAt: { gt: new Date(Date.now() - 30 * 60_000) },
    },
  });
  if (running > 0) {
    throw new WorkspaceError(
      "A OneNote import is already running — it shows under Past imports.",
    );
  }
  const batch = await prisma.importBatch.create({
    data: {
      campaignId,
      source: "ONENOTE",
      destinationFolderId: input.destinationFolderId,
      label: input.label.trim().slice(0, 200) || "OneNote",
    },
    select: { id: true },
  });
  const job: OneNoteImportJob = { batchId: batch.id, sectionIds };
  await (await getQueue()).send(ONENOTE_IMPORT_QUEUE, job);
  return batch.id;
}

/**
 * Do an import (worker). Folders for each notebook / group / section under the destination,
 * then a page per OneNote page. A page already imported (and not since undone) is skipped, so
 * running it again only brings in what's new.
 */
export async function runOneNoteImport(job: OneNoteImportJob): Promise<void> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: job.batchId },
    select: { campaignId: true, destinationFolderId: true, status: true },
  });
  if (!batch || batch.status !== "RUNNING") return;
  const { campaignId } = batch;
  const finish = (message: string | null) =>
    prisma.importBatch.update({
      where: { id: job.batchId },
      data: { status: "DONE", finishedAt: new Date(), message },
    });

  try {
    const at = await accessToken(campaignId);
    const wanted = new Set(job.sectionIds);
    const sections = (await sectionsWithPaths(at)).filter((s) =>
      wanted.has(s.id),
    );

    // Folders, created once per distinct path (notebook / groups / section).
    const folderIds = new Map<string, string>();
    const folderFor = async (parts: string[]): Promise<string | null> => {
      let parent = batch.destinationFolderId;
      for (let i = 1; i <= parts.length; i++) {
        const key = parts.slice(0, i).join("\u0000");
        let id = folderIds.get(key);
        if (!id) {
          id = (
            await prisma.folder.create({
              data: {
                campaignId,
                parentId: parent,
                name: parts[i - 1]!.slice(0, 200) || "Untitled",
                importBatchId: job.batchId,
              },
              select: { id: true },
            })
          ).id;
          folderIds.set(key, id);
        }
        parent = id;
      }
      return parent;
    };

    for (const section of sections) {
      const folderId = await folderFor([...section.path, section.name]);
      const pages = await graphAll<{
        id: string;
        title?: string;
        order?: number;
      }>(
        at,
        `/me/onenote/sections/${encodeURIComponent(section.id)}/pages?$select=id,title,order&$top=100`,
      );
      pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      for (const [position, p] of pages.entries()) {
        const importHash = `onenote:${p.id}`;
        const already = await prisma.page.count({
          where: { campaignId, importHash, archivedAt: null },
        });
        if (already > 0) {
          await bump(job.batchId, "filesSkipped");
          continue;
        }
        try {
          const html = await (
            await graph(
              at,
              `/me/onenote/pages/${encodeURIComponent(p.id)}/content`,
            )
          ).text();
          // OneNote's body headings start at h1 like the title's; push them below it.
          const content = markdownToPage(
            htmlToMarkdown(html, { headingOffset: 1 }),
          );
          const title = p.title?.trim().slice(0, 200) || "Untitled page";
          const markdown = pageToMarkdown(content);
          const json = content as unknown as Prisma.InputJsonValue;
          const page = await prisma.$transaction(async (tx) => {
            const created = await tx.page.create({
              data: {
                campaignId,
                folderId,
                title,
                content: json,
                markdown,
                position,
                importBatchId: job.batchId,
                importHash,
              },
              select: { id: true },
            });
            await tx.pageVersion.create({
              data: {
                pageId: created.id,
                title,
                content: json,
                markdown,
                cause: "IMPORT",
              },
            });
            await tx.importBatch.update({
              where: { id: job.batchId },
              data: { pagesCreated: { increment: 1 } },
            });
            return created;
          });
          await schedulePageIndex(page.id, 5);
        } catch (err) {
          if (err instanceof OneNoteAuthError) throw err;
          console.error(`[onenote] page ${p.id} failed:`, err);
          await bump(job.batchId, "filesSkipped");
        }
      }
    }
    const missing = job.sectionIds.length - sections.length;
    await finish(
      missing > 0
        ? `${missing} section(s) weren't found — moved or deleted in OneNote?`
        : null,
    );
  } catch (err) {
    if (err instanceof OneNoteAuthError) {
      await finish(
        "Microsoft sign-in expired — connect OneNote again and re-run the import.",
      );
      return; // retrying can't fix this; the DM has to sign in
    }
    // Not rethrown: a queue retry would find the import finished and do nothing. Running the
    // import again is the retry, and it skips what already came in.
    console.error(`[onenote] import ${job.batchId} stopped:`, err);
    await finish(
      "The import stopped partway — run it again to bring in the rest.",
    );
  }
}

function bump(batchId: string, field: "filesSkipped" | "pagesCreated") {
  return prisma.importBatch.update({
    where: { id: batchId },
    data: { [field]: { increment: 1 } },
  });
}
