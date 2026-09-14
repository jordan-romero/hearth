import { describe, it, expect } from "vitest";
import {
  directUploadKey,
  isDirectUploadKey,
  uploadProblem,
  MAX_UPLOAD_BYTES,
} from "./upload.js";

describe("directUploadKey / isDirectUploadKey — a browser upload's storage key", () => {
  it("gives each upload its own folder under its campaign", () => {
    const a = directUploadKey("camp1", "Ondera notes.pdf");
    const b = directUploadKey("camp1", "Ondera notes.pdf");
    expect(a).toMatch(/^camp1\/uploads\/[0-9a-f-]{36}\/Ondera_notes\.pdf$/);
    expect(a).not.toBe(b);
    expect(isDirectUploadKey("camp1", a)).toBe(true);
  });

  it("refuses a key from another campaign", () => {
    expect(
      isDirectUploadKey("camp1", directUploadKey("camp2", "notes.pdf")),
    ).toBe(false);
  });

  it("refuses a campaign id that only shares a prefix", () => {
    expect(isDirectUploadKey("camp1", "camp10/uploads/abc/notes.pdf")).toBe(
      false,
    );
  });

  it("refuses path tricks and keys that aren't upload folders", () => {
    expect(isDirectUploadKey("camp1", "camp1/uploads/../camp2/notes.pdf")).toBe(
      false,
    );
    expect(isDirectUploadKey("camp1", "camp1/uploads/abc/../x.pdf")).toBe(
      false,
    );
    expect(isDirectUploadKey("camp1", "camp1/uploads/notes.pdf")).toBe(false);
    expect(isDirectUploadKey("camp1", "camp1/doc123/notes.pdf")).toBe(false);
    expect(isDirectUploadKey("", "/uploads/abc/notes.pdf")).toBe(false);
  });
});

describe("uploadProblem — what the library accepts", () => {
  it("accepts a supported file within the limit", () => {
    expect(uploadProblem("notes.PDF", 1024)).toBeNull();
  });

  it("asks for a file when there isn't one", () => {
    expect(uploadProblem("", 0)).toBe("Choose a file first.");
  });

  it("names the formats it can read", () => {
    expect(uploadProblem("map.png", 1024)).toMatch(
      /\.txt, \.md, \.pdf, \.docx/,
    );
  });

  it("refuses a file over the limit and says how big it was", () => {
    expect(uploadProblem("notes.pdf", MAX_UPLOAD_BYTES + 1)).toMatch(
      /^That file is 25\.0MB — the limit is 25MB\.$/,
    );
  });
});
