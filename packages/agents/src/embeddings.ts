// Voyage AI embeddings — the semantic-search vectors behind "talk to the memory".
// Standalone I/O (no DB dependency): used by the seed and by retrieval alike.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

/** voyage-3.5 outputs 1024 dims by default — matches the `vector(1024)` column. */
export const EMBEDDING_MODEL = "voyage-3.5";
export const EMBEDDING_DIM = 1024;

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

/**
 * Embed a batch of texts. Use `document` for stored knowledge and `query` for a
 * user's question — Voyage tunes the two sides of retrieval differently.
 */
export async function embedTexts(
  texts: string[],
  inputType: "document" | "query" = "document",
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not set — cannot generate embeddings.");
  }
  if (texts.length === 0) return [];

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Voyage embeddings request failed: ${res.status} ${await res.text()}`,
    );
  }

  const json = (await res.json()) as VoyageResponse;
  // Voyage tags each result with its input `index`; sort to guarantee order.
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** Format a vector as a pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
