"use client";

import { useTransition } from "react";
import { newPage } from "./actions";

export function NewPageButton({
  campaignId,
  folderId = null,
}: {
  campaignId: string;
  folderId?: string | null;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      onClick={() =>
        start(async () => void (await newPage(campaignId, folderId)))
      }
    >
      {pending ? "Creating…" : "New page"}
    </button>
  );
}
