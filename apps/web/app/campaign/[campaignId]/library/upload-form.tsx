"use client";

// The library's upload form. Where storage supports it, the file goes straight from the browser
// to storage (Vercel won't accept a request body over 4.5 MB) and only its key comes back
// through the server. Otherwise the form posts the file to the server as before.

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Prepared = { key: string; uploadUrl: string } | { error: string };

export interface FinishInput {
  key: string;
  fileName: string;
  mimeType: string;
  extractUnits: boolean;
  forPlayers: boolean;
}

export function UploadForm({
  accept,
  direct,
  upload,
  prepareUpload,
  finishUpload,
}: {
  accept: string;
  direct: boolean;
  upload: (formData: FormData) => Promise<void>;
  prepareUpload: (fileName: string, size: number) => Promise<Prepared>;
  finishUpload: (input: FinishInput) => Promise<{ href: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendDirect(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareUpload(file.name, file.size);
      if ("error" in prepared) {
        setError(prepared.error);
        return;
      }
      const res = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-upsert": "false",
        },
        body: file,
      });
      if (!res.ok) {
        setError("Couldn't upload that file — try again.");
        return;
      }
      const { href } = await finishUpload({
        key: prepared.key,
        fileName: file.name,
        mimeType: file.type,
        extractUnits: data.get("extract") !== null,
        forPlayers: data.get("forPlayers") !== null,
      });
      router.push(href);
      router.refresh();
    } catch {
      setError("Couldn't upload that file — try again.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!direct) {
      // The form's server action posts the file; just stop a second click from sending it again.
      setBusy(true);
      return;
    }
    event.preventDefault();
    void sendDirect(event.currentTarget);
  }

  return (
    <>
      <form className="upload-form" action={upload} onSubmit={onSubmit}>
        <input
          type="file"
          name="file"
          accept={accept}
          aria-label="Document to add"
          required
        />
        <label className="check">
          <input type="checkbox" name="extract" defaultChecked />
          Also pull out NPCs, places and facts
        </label>
        <label className="check">
          <input type="checkbox" name="forPlayers" />
          Players already have this
        </label>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add to memory"}
        </button>
      </form>
      {error && <p className="notice error">{error}</p>}
    </>
  );
}
