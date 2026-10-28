import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { prisma } from "@hearth/db";
import {
  finishImport,
  importFile,
  startFileImport,
  undoImport,
} from "./workspace-import.js";
import { createPage } from "./workspace.js";
import { directUploadKey } from "./upload.js";
import { putDocument, DOCUMENTS_BUCKET } from "./storage.js";
import { getQueue } from "./queue.js";

// Throwaway database AND local storage only (HEARTH_STORAGE_DIR set, no SUPABASE_URL) — see
// workspace.integration.test.ts.
const live = process.env.HEARTH_DB_TESTS === "1" && !process.env.SUPABASE_URL;

const C = "imp_test_campaign";
const OTHER = "imp_test_other";

/** A one-page PDF saying `text`, built by hand (no PDF library needed). */
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function upload(campaignId: string, fileName: string, data: Buffer) {
  const key = directUploadKey(campaignId, fileName);
  await putDocument(key, data);
  return key;
}

const stored = (key: string) =>
  existsSync(
    path.join(process.env.HEARTH_STORAGE_DIR ?? "", DOCUMENTS_BUCKET, key),
  );

describe.skipIf(!live)("workspace import (database + storage)", () => {
  beforeAll(async () => {
    for (const id of [C, OTHER]) {
      await prisma.campaign.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    }
  });
  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: [C, OTHER] } } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  it("imports a folder of notes as folders and editable pages", async () => {
    const { batchId, folders } = await startFileImport(C, {
      destinationFolderId: null,
      label: "Ondera",
      folderPaths: [
        "Ondera/NPCs",
        "Ondera/Places/Old Mill",
        "Ondera/NPCs",
        "../Ondera/./NPCs",
      ],
    });
    expect(Object.keys(folders).sort()).toEqual([
      "",
      "Ondera",
      "Ondera/NPCs",
      "Ondera/Places",
      "Ondera/Places/Old Mill",
    ]);

    const md = await importFile(C, batchId, {
      key: await upload(
        C,
        "Vess.md",
        Buffer.from("# Vess\n\n- Leader of the **Shepherds**\n"),
      ),
      fileName: "Vess.md",
      folderId: folders["Ondera/NPCs"]!,
    });
    expect(md).toMatchObject({ kind: "imported", title: "Vess" });

    const pdfKey = await upload(
      C,
      "map notes.pdf",
      pdf("The river ford floods at dusk."),
    );
    const fromPdf = await importFile(C, batchId, {
      key: pdfKey,
      fileName: "map notes.pdf",
      folderId: folders["Ondera/Places/Old Mill"]!,
    });
    expect(fromPdf.kind).toBe("imported");

    const pages = await prisma.page.findMany({
      where: { importBatchId: batchId },
      orderBy: { title: "asc" },
      include: { versions: true, folder: true },
    });
    expect(pages.map((p) => [p.title, p.folder?.name, p.markdown])).toEqual([
      ["map notes", "Old Mill", "The river ford floods at dusk."],
      ["Vess", "NPCs", "# Vess\n\n- Leader of the **Shepherds**"],
    ]);
    expect(pages.every((p) => p.versions[0]?.cause === "IMPORT")).toBe(true);

    // The PDF keeps its original; the markdown's upload was only a carrier.
    expect(pages[0]!.originalFileName).toBe("map notes.pdf");
    expect(stored(pdfKey)).toBe(true);
    expect(pages[1]!.originalFilePath).toBeNull();

    // Imported text is working prep: no knowledge is made from it.
    expect(await prisma.knowledgeUnit.count({ where: { campaignId: C } })).toBe(
      0,
    );

    await finishImport(C, batchId, 2);
    expect(
      await prisma.importBatch.findUnique({ where: { id: batchId } }),
    ).toMatchObject({
      status: "DONE",
      pagesCreated: 2,
      filesSkipped: 2,
    });
  });

  it("puts pages in the order the DM arranged them", async () => {
    const { batchId, folders } = await startFileImport(C, {
      destinationFolderId: null,
      label: "Ordered",
      folderPaths: ["Ordered"],
    });
    const folderId = folders["Ordered"]!;
    for (const [position, name] of [
      "Session 1",
      "Session 2",
      "Act I",
    ].entries()) {
      await importFile(C, batchId, {
        key: await upload(C, `${name}.md`, Buffer.from(`# ${name} notes`)),
        fileName: `${name}.md`,
        folderId,
        position,
      });
    }
    const pages = await prisma.page.findMany({
      where: { folderId },
      orderBy: [{ position: "asc" }, { title: "asc" }],
    });
    // The DM's order, not alphabetical.
    expect(pages.map((p) => p.title)).toEqual([
      "Session 1",
      "Session 2",
      "Act I",
    ]);
  });

  it("skips a file that's already been imported", async () => {
    const { batchId } = await startFileImport(C, {
      destinationFolderId: null,
      label: "again",
      folderPaths: [],
    });
    const result = await importFile(C, batchId, {
      key: await upload(
        C,
        "Vess copy.md",
        Buffer.from("# Vess\n\n- Leader of the **Shepherds**\n"),
      ),
      fileName: "Vess copy.md",
      folderId: null,
    });
    expect(result).toEqual({ kind: "duplicate", existingTitle: "Vess" });
  });

  it("skips what it can't read, without failing the import", async () => {
    const { batchId } = await startFileImport(C, {
      destinationFolderId: null,
      label: "odd",
      folderPaths: [],
    });
    expect(
      await importFile(C, batchId, {
        key: await upload(C, "stats.csv", Buffer.from("a,b")),
        fileName: "stats.csv",
        folderId: null,
      }),
    ).toEqual({ kind: "skipped", reason: "can't read this type" });
    expect(
      await importFile(C, batchId, {
        key: await upload(C, "broken.pdf", Buffer.from("not a pdf")),
        fileName: "broken.pdf",
        folderId: null,
      }),
    ).toEqual({ kind: "skipped", reason: "couldn't be read" });
  });

  it("refuses another campaign's upload, folder or import", async () => {
    const { batchId } = await startFileImport(C, {
      destinationFolderId: null,
      label: "x",
      folderPaths: [],
    });
    const theirKey = await upload(OTHER, "theirs.md", Buffer.from("secret"));
    await expect(
      importFile(C, batchId, {
        key: theirKey,
        fileName: "theirs.md",
        folderId: null,
      }),
    ).rejects.toThrow(/doesn't belong/);
    const theirFolder = await prisma.folder.create({
      data: { campaignId: OTHER, name: "Theirs" },
    });
    await expect(
      startFileImport(C, {
        destinationFolderId: theirFolder.id,
        label: "x",
        folderPaths: [],
      }),
    ).rejects.toThrow(/doesn't exist/);
    const theirs = await startFileImport(OTHER, {
      destinationFolderId: null,
      label: "t",
      folderPaths: [],
    });
    await expect(
      importFile(C, theirs.batchId, {
        key: await upload(C, "a.md", Buffer.from("a")),
        fileName: "a.md",
        folderId: null,
      }),
    ).rejects.toThrow(/doesn't exist/);
  });

  it("undo trashes its pages and removes its folders, unless the DM has used one", async () => {
    const { batchId, folders } = await startFileImport(C, {
      destinationFolderId: null,
      label: "Undo me",
      folderPaths: ["Undo me/Kept", "Undo me/Gone"],
    });
    await importFile(C, batchId, {
      key: await upload(C, "a.md", Buffer.from("# A page to undo")),
      fileName: "a.md",
      folderId: folders["Undo me/Gone"]!,
    });
    // The DM has since written their own page in one of the imported folders.
    await createPage(C, folders["Undo me/Kept"]!, "Mine");

    expect(await undoImport(C, batchId)).toBe(1);
    const remaining = await prisma.folder.findMany({
      where: { importBatchId: batchId },
      select: { name: true },
    });
    expect(remaining.map((f) => f.name).sort()).toEqual(["Kept", "Undo me"]);
    expect(
      await prisma.page.count({
        where: { importBatchId: batchId, archivedAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      await prisma.page.count({
        where: { campaignId: C, title: "Mine", archivedAt: null },
      }),
    ).toBe(1);
  });
});
