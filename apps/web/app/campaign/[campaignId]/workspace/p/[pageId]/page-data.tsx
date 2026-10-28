"use client";

// Hands the server's copy of a page to the page store; the page host shows it.

import { useEffect } from "react";
import { putDoc, type PageDoc } from "../../page-store";

export function PageData({ doc }: { doc: PageDoc }) {
  useEffect(() => putDoc(doc), [doc]);
  return null;
}
