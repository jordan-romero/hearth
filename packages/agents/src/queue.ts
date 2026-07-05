// Shared pg-boss access — the bot enqueues, the worker consumes, both through
// this one helper so they agree on connection + queue setup.
// pg-boss uses LISTEN/NOTIFY, so it connects on the DIRECT URL (not the pooler).

import { PgBoss } from "pg-boss";
import { TRANSCRIBE_QUEUE } from "./jobs.js";

let boss: PgBoss | undefined;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  const instance = new PgBoss(url);
  instance.on("error", (err) => console.error("pg-boss error:", err));
  await instance.start();
  await instance.createQueue(TRANSCRIBE_QUEUE); // idempotent
  boss = instance;
  return boss;
}
