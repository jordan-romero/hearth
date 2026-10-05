// OneNote import. A DM signs in with Microsoft and picks sections; every page in them becomes a
// library document keyed by its page id ("onenote:<id>"), so an edited page is re-read in place
// and a page deleted in OneNote leaves the library on the next sync. Imported pages are DM-only,
// like any upload — the DM reveals what they choose.
//
// Talks to Microsoft Graph with delegated access (Notes.Read). The refresh token is the only
// credential kept, sealed at rest (secrets.ts); access tokens live for one sync and are never
// stored. Works for personal Microsoft accounts and work/school ones ("common" tenant).

import { prisma } from "@hearth/db";
import { openSecret, sealSecret } from "./secrets.js";
import { removeExternalDocument, syncExternalDocument } from "./external.js";
import { getQueue } from "./queue.js";
import { ONENOTE_SYNC_QUEUE, type OneNoteSyncJob } from "./jobs.js";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access User.Read Notes.Read";
const TOKEN_PURPOSE = "onenote-refresh-token";
const EXTERNAL_PREFIX = "onenote:";

/** Whether this deployment has a Microsoft app registered. Without one, OneNote isn't offered. */
export function oneNoteConfigured(): boolean {
  return !!(
    process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
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
    // Always show the account picker: a DM signed in to a work account usually wants the
    // personal one their notebooks live in, or the other way round.
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
    error_description?: string;
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

/** Finish sign-in: trade the code for tokens and store the connection for this campaign. */
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
  const accountName = me.mail || me.userPrincipalName || me.displayName || null;
  const refreshTokenEnc = sealSecret(t.refresh_token, TOKEN_PURPOSE);
  await prisma.oneNoteConnection.upsert({
    where: { campaignId: input.campaignId },
    create: {
      campaignId: input.campaignId,
      connectedByMembershipId: input.membershipId,
      accountName,
      refreshTokenEnc,
    },
    // Reconnecting (another account, or after the sign-in expired) keeps the chosen sections.
    update: {
      connectedByMembershipId: input.membershipId,
      accountName,
      refreshTokenEnc,
    },
  });
}

/** A fresh access token for a campaign's connection. Microsoft rotates refresh tokens, so the
 * new one replaces the stored one — keeping the old would eventually stop working. */
async function accessToken(campaignId: string): Promise<string> {
  const conn = await prisma.oneNoteConnection.findUnique({
    where: { campaignId },
    select: { refreshTokenEnc: true },
  });
  if (!conn) throw new OneNoteAuthError("not connected");
  const t = await token({
    grant_type: "refresh_token",
    refresh_token: openSecret(conn.refreshTokenEnc, TOKEN_PURPOSE),
  });
  if (t.refresh_token) {
    await prisma.oneNoteConnection.update({
      where: { campaignId },
      data: { refreshTokenEnc: sealSecret(t.refresh_token, TOKEN_PURPOSE) },
    });
  }
  return t.access_token;
}

async function graph(accessToken: string, path: string): Promise<Response> {
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  // OneNote throttles hard; honour Retry-After rather than failing a long import.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
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

async function graphJson<T>(accessToken: string, path: string): Promise<T> {
  return (await graph(accessToken, path)).json() as Promise<T>;
}

/** Every page of a paged Graph collection. */
async function graphAll<T>(accessToken: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: { value: T[]; "@odata.nextLink"?: string } = await graphJson(
      accessToken,
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
  notebook: string;
}

async function sectionsWith(accessToken: string): Promise<OneNoteSection[]> {
  // /me/onenote/sections covers sections inside section groups too, which walking notebooks
  // one level deep would miss.
  const rows = await graphAll<{
    id: string;
    displayName: string;
    parentNotebook?: { displayName?: string };
  }>(
    accessToken,
    "/me/onenote/sections?$select=id,displayName&$expand=parentNotebook($select=displayName)",
  );
  return rows
    .map((r) => ({
      id: r.id,
      name: r.displayName,
      notebook: r.parentNotebook?.displayName ?? "Notebook",
    }))
    .sort(
      (a, b) =>
        a.notebook.localeCompare(b.notebook) || a.name.localeCompare(b.name),
    );
}

/** The connected account's sections, for the DM to choose from. */
export async function listOneNoteSections(
  campaignId: string,
): Promise<OneNoteSection[]> {
  return sectionsWith(await accessToken(campaignId));
}

export interface OneNoteConnectionView {
  accountName: string | null;
  sectionIds: string[];
  extractUnits: boolean;
  syncing: boolean;
  lastSyncAt: Date | null;
  lastSyncResult: string | null;
}

/** The connection as the library shows it, or null if this campaign hasn't connected. */
export function getOneNoteConnection(
  campaignId: string,
): Promise<OneNoteConnectionView | null> {
  return prisma.oneNoteConnection.findUnique({
    where: { campaignId },
    select: {
      accountName: true,
      sectionIds: true,
      extractUnits: true,
      syncing: true,
      lastSyncAt: true,
      lastSyncResult: true,
    },
  });
}

/** Save which sections to import, and queue the import. */
export async function chooseOneNoteSections(
  campaignId: string,
  sectionIds: string[],
  extractUnits: boolean,
): Promise<void> {
  await prisma.oneNoteConnection.update({
    where: { campaignId },
    data: { sectionIds: [...new Set(sectionIds)], extractUnits },
  });
  await requestOneNoteSync(campaignId);
}

/** Queue an import. At most one per campaign is waiting at a time. */
export async function requestOneNoteSync(campaignId: string): Promise<void> {
  await prisma.oneNoteConnection.update({
    where: { campaignId },
    data: { syncing: true },
  });
  const job: OneNoteSyncJob = { campaignId };
  await (
    await getQueue()
  ).send(ONENOTE_SYNC_QUEUE, job, { singletonKey: campaignId });
}

/** Forget the Microsoft account. Pages already imported stay in the library. */
export async function disconnectOneNote(campaignId: string): Promise<void> {
  await prisma.oneNoteConnection.deleteMany({ where: { campaignId } });
}

/**
 * Bring the library in line with the chosen sections: new pages added, edited pages re-read,
 * pages deleted in OneNote (or in a section no longer chosen) removed. Runs in the worker.
 *
 * Removal only happens after every chosen section was listed successfully — a network failure
 * halfway must never look like "all those pages were deleted".
 */
export async function syncOneNote(campaignId: string): Promise<void> {
  const conn = await prisma.oneNoteConnection.findUnique({
    where: { campaignId },
  });
  if (!conn) return;

  const finish = (result: string) =>
    prisma.oneNoteConnection.update({
      where: { campaignId },
      data: { syncing: false, lastSyncAt: new Date(), lastSyncResult: result },
    });

  try {
    const at = await accessToken(campaignId);
    const sections = new Map((await sectionsWith(at)).map((s) => [s.id, s]));
    const counts = {
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      failed: 0,
    };
    const seen = new Set<string>();

    for (const sectionId of conn.sectionIds) {
      const section = sections.get(sectionId);
      if (!section) continue; // deleted in OneNote: its pages are removed below
      const pages = await graphAll<{
        id: string;
        title?: string;
        lastModifiedDateTime?: string;
      }>(
        at,
        `/me/onenote/sections/${encodeURIComponent(sectionId)}/pages?$select=id,title,lastModifiedDateTime&$top=100`,
      );

      for (const page of pages) {
        const externalId = EXTERNAL_PREFIX + page.id;
        seen.add(externalId);
        const existing = await prisma.sourceDocument.findUnique({
          where: { campaignId_externalId: { campaignId, externalId } },
          select: { externalVersion: true, status: true },
        });
        if (
          existing &&
          existing.status !== "FAILED" &&
          page.lastModifiedDateTime &&
          existing.externalVersion === page.lastModifiedDateTime
        ) {
          counts.unchanged++;
          continue;
        }
        try {
          const html = await (
            await graph(
              at,
              `/me/onenote/pages/${encodeURIComponent(page.id)}/content`,
            )
          ).text();
          const outcome = await syncExternalDocument({
            campaignId,
            externalId,
            sourceType: "ONENOTE",
            name: `${section.notebook} / ${section.name} / ${page.title?.trim() || "Untitled page"}`,
            text: oneNoteHtmlToMarkdown(html),
            fileStem: `onenote-${page.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            externalVersion: page.lastModifiedDateTime ?? null,
            baseVisibility: "DM_ONLY",
            extractUnits: conn.extractUnits,
          });
          counts[outcome]++;
        } catch (err) {
          if (err instanceof OneNoteAuthError) throw err;
          console.error(`[onenote] page ${page.id} failed:`, err);
          counts.failed++;
        }
      }
    }

    const gone = await prisma.sourceDocument.findMany({
      where: {
        campaignId,
        sourceType: "ONENOTE",
        externalId: { startsWith: EXTERNAL_PREFIX, notIn: [...seen] },
      },
      select: { externalId: true },
    });
    for (const doc of gone) {
      if (
        doc.externalId &&
        (await removeExternalDocument(campaignId, doc.externalId))
      ) {
        counts.removed++;
      }
    }

    await finish(describe(counts));
  } catch (err) {
    if (err instanceof OneNoteAuthError) {
      await finish("Microsoft sign-in expired — connect OneNote again.");
      return; // retrying can't fix this; the DM has to sign in
    }
    await finish("Import failed — it will retry.");
    throw err;
  }
}

function describe(c: Record<string, number>): string {
  const parts = (["added", "updated", "removed", "failed"] as const)
    .filter((k) => c[k])
    .map((k) => `${c[k]} ${k}`);
  return parts.length ? parts.join(", ") : `Up to date (${c.unchanged} pages)`;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * A OneNote page's HTML as plain markdown — headings, lists, paragraphs and table rows kept,
 * everything else (styling, positioning divs, scripts) dropped. Images become their alt text,
 * since the text pipeline can't read pixels. The page title is left out: the document name
 * already carries it.
 */
export function oneNoteHtmlToMarkdown(html: string): string {
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, n: string, inner: string) =>
      `\n\n${"#".repeat(Number(n) + 1)} ${inner}\n\n`,
  );
  s = s
    .replace(/<img[^>]*\balt="([^"]+)"[^>]*>/gi, " [image: $1] ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol|table|tr)>/gi, "\n")
    .replace(/<p(\s[^>]*)?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1]?.toLowerCase() === "x"
          ? parseInt(e.slice(2), 16)
          : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
