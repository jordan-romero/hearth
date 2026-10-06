// The workspace assistant's endpoint: one conversation turn, streamed back as newline-delimited
// JSON events (text as it's written, each tool call, suggestion cards, then the updated history).
// DM-only; the campaign comes from the URL and every tool is scoped to it on the server.

import {
  runAssistant,
  type AssistantEvent,
  type AssistantHistory,
} from "@hearth/agents";
import { requireDm } from "@/lib/campaign";

// A turn can take several tool rounds.
export const maxDuration = 300;

const MAX_BODY = 4 * 1024 * 1024;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const { viewer } = await requireDm(campaignId);

  const raw = await req.text();
  if (raw.length > MAX_BODY) {
    return Response.json(
      { error: "This conversation is too long — start a new one." },
      { status: 413 },
    );
  }
  let body: {
    history?: unknown;
    text?: unknown;
    pageId?: unknown;
    selection?: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const text =
    typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
  if (!text)
    return Response.json({ error: "Ask something first." }, { status: 400 });
  // The DM's own conversation from this panel, sent back as the previous turn returned it.
  const history = Array.isArray(body.history)
    ? (body.history as AssistantHistory)
    : [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AssistantEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      await runAssistant({
        viewer,
        history,
        userText: text,
        open: {
          pageId:
            typeof body.pageId === "string" && body.pageId ? body.pageId : null,
          selection: typeof body.selection === "string" ? body.selection : "",
        },
        emit,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
