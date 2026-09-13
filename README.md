# Hearth

A D&D Discord bot backed by a permission-filtered **campaign memory** you can
talk to — and a rich, themed campaign page behind login. The bot is the primary
interface; the memory is the substance; the fog-of-war permission filter is the
spine.

## Monorepo layout

```
hearth/
├─ apps/
│  ├─ web/        Next.js (Vercel) — campaign page, web API, Auth.js       [Phase 5]
│  ├─ bot/        Discord.js (Railway) — capture, live Q&A, DM prep        [Phase 1/2]
│  └─ worker/     Node (Railway) — pg-boss consumer: transcription, agents [Phase 2]
├─ packages/
│  ├─ db/         Prisma schema + client (single source of the schema)     [Phase 0]
│  ├─ core/       ★ the permission filter + knowledge-unit domain ★        [Phase 0]
│  └─ agents/     Claude workflows (extract, classify, retrieve, prep)     [Phase 1/3]
```

## Stack

TypeScript · pnpm + Turborepo · Supabase Postgres + pgvector + Storage · Prisma ·
Auth.js (email + Discord) · Next.js/Vercel · Discord.js/Railway · pg-boss ·
Anthropic SDK · Groq Whisper (→ Deepgram/AssemblyAI) · Stripe.

Full rationale: `~/.claude/plans/campaign-memory-playful-stearns.md`.

## Current status — Phase 5 done (web app), heading into the interactive-page finish

Phases 0-5 are merged: permission model, bot memory + capture, live sessions
(incl. live transcription), NPC generation, and the campaign web app (ask,
memory/codex, journal, DM library, corrections, share flow).

Next, per `docs/scope.md`'s "Interactive page" list, the still-unbuilt pieces:

- **Character pages** — what a PC knows/has done + the light display-only sheet.
- **Relationship graph** — `RELATIONSHIP` knowledge units already model this;
  it just needs a graph view.
- **Map** — DM-uploaded image, pins linked to memory, fog-of-war overlay
  (no `Map`/`MapPin` tables yet).
- **Timeline** — scrub the campaign session by session (derived from
  `Session` + provenance; no schema change needed).
- **Theme picker** — the "Firelight in the dark" default theme is in;
  presets/picker are not.

## Getting started (once dependencies are installed)

```sh
pnpm install
pnpm db:generate     # after schema models exist
pnpm test            # runs the permission-filter guard suite
```
