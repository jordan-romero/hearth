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

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

    if (res.ok) {
      const json = (await res.json()) as VoyageResponse;
      // Voyage tags each result with its input `index`; sort to guarantee order.
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }

    // Retry on rate-limit (429) and transient server errors, with backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1500 * 2 ** attempt, 24_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    throw new Error(
      `Voyage embeddings request failed: ${res.status} ${await res.text()}`,
    );
  }
  throw new Error("Voyage embeddings: retries exhausted");
}

/** Format a vector as a pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
