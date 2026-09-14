"use client";

// Disables itself while its form is submitting, so a second click can't send the same upload
// twice.

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pendingLabel,
}: {
  children: React.ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
