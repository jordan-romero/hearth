// Text extraction from a source file — the first step of ingestion. Format-routed and
// pure-JS (unpdf has no native deps), so it deploys anywhere. Unsupported types throw,
// which lands the SourceDocument in FAILED rather than silently ingesting nothing.

import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

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

  if (isText) return data.toString("utf8");
  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return text;
  }
  // docx (mammoth), images (OCR), spreadsheets → later; for now, be explicit.
  throw new Error(`unsupported document type: ${mimeType ?? ext} (${name})`);
}
