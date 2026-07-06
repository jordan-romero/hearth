// Text extraction from a source file — the first step of ingestion. Format-routed and
// pure-JS (unpdf has no native deps), so it deploys anywhere. Unsupported types throw,
// which lands the SourceDocument in FAILED rather than silently ingesting nothing.

import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function extOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

/** Extract plain text from a document's bytes, routed by mime type / filename. */
export async function extractText(
  data: Buffer,
  mimeType: string | null,
  name: string,
): Promise<string> {
  const ext = extOf(name);
  const isText =
    mimeType?.startsWith("text/") ||
    ["txt", "md", "markdown", "text"].includes(ext);
  const isPdf = mimeType === "application/pdf" || ext === "pdf";
  const isDocx = mimeType === DOCX_MIME || ext === "docx";

  if (isText) return data.toString("utf8");
  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return text;
  }
  if (isDocx) {
    // mammoth is pure-JS (no native deps) → deploys anywhere. We only need the text,
    // not the styled HTML, so extractRawText is the right, lighter call.
    const { value } = await mammoth.extractRawText({ buffer: data });
    return value;
  }
  // Legacy .doc, images (OCR), spreadsheets → later; for now, be explicit.
  throw new Error(`unsupported document type: ${mimeType ?? ext} (${name})`);
}
