# Deploying Hearth (Railway)

Two long-running services from this one repo — **bot** (Discord gateway + voice
capture) and **worker** (transcription + extraction) — both talking to the existing
Supabase Postgres and Supabase Storage. No web server, no domain needed.

## 0. Prerequisites (one-time, on Supabase)

Hearth stores audio clips in Supabase Storage in prod (local disk is dev-only).

1. **Create a private bucket** named `recordings`
   (Supabase dashboard → Storage → New bucket → uncheck "Public").
2. Grab two values (Project Settings → API):
   - `SUPABASE_URL` — the Project URL, e.g. `https://<ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** secret (server-side only;
     never ship to a browser). This bypasses RLS, which is what a trusted backend wants.
3. Storage works even with the Data API disabled — it uses the `/storage/v1` endpoint,
   not PostgREST. No change needed.

Migrations are already applied to this Supabase project from local `migrate dev`, and
Railway connects to the _same_ project, so there is no separate prod-migrate step. (One
shared DB for dev + deploy is fine for dogfooding; split later if we want real envs.)

## 1. Create the Railway project

- New Project → Deploy from GitHub repo → pick this repo.
- You'll create **two services** from the same repo (below). Railway builds the whole
  repo for each; they differ only in start command + env.

## 2. Per-service settings

For **both** services, set:

- **Build command:** `pnpm install --frozen-lockfile && pnpm db:generate:prod`
  (the generated Prisma client is gitignored, so it must be generated at build)

Then set the **start command** per service:

| Service  | Start command                             |
| -------- | ----------------------------------------- |
| `bot`    | `pnpm --filter @hearth/bot start:prod`    |
| `worker` | `pnpm --filter @hearth/worker start:prod` |

Node ≥ 20.19 is pinned via `engines` in the root `package.json`; Nixpacks honours it.

## 3. Environment variables

**Both services** need:

```
DATABASE_URL              # Supabase pooled (…pooler…:6543) — runtime client
DIRECT_URL                # Supabase SESSION pooler (…pooler…:5432) — pg-boss + Prisma CLI
ANTHROPIC_API_KEY
DEEPGRAM_API_KEY
VOYAGE_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
HEARTH_STORAGE_BUCKET=recordings   # optional; this is the default
```

**Bot** additionally needs:

```
DISCORD_BOT_TOKEN
DISCORD_CLIENT_ID
DISCORD_GUILD_ID          # registers slash commands instantly to your server
HEARTH_CAMPAIGN_ID        # e.g. seed-ondera (the campaign this table records into)
```

Copy values from your local `.env`. Do **not** commit them.

## 4. Deploy & verify

Push to the deploy branch; both services build and boot. Check logs:

- worker → `🛠  Hearth worker online — waiting for jobs`
- bot → `Registered commands…` then `🔥 Hearth online as …`

Then run the live loop in Discord (`/record → talk → /stop → /ask`) and watch the
worker log for `[transcribe] …` and `[extract] … units stored`.

## Gotchas / notes

- **pg-boss needs LISTEN/NOTIFY**, which the transaction pooler (`:6543`) does not
  support. `DIRECT_URL` must be the **session pooler** (`…pooler…:5432`, IPv4) — which
  it already is. Do not point `DIRECT_URL` at the IPv6 `db.<ref>.supabase.co` direct host.
- **Voice = outbound UDP.** `@discordjs/voice` opens a UDP socket to Discord's voice
  servers. Railway allows outbound UDP, but if capture ever silently no-ops after deploy,
  this is the first thing to check.
- **Storage backend auto-selects:** with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  set, `storage.ts` uses the bucket; without them it falls back to local disk. So a
  missing/typo'd Supabase var shows up as "clips written to a container's ephemeral
  disk that the worker can't read" — verify both vars are set on **both** services.
- **Prod runs via `tsx`** (no compile step) for now. Fine for dogfooding; a future
  hardening pass can compile to JS and run `node`.
