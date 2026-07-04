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

## Current status — Phase 0 (permission model)

Scaffold only. Next: design the knowledge-unit + visibility schema in
`packages/db`, implement `filterKnowledge` in `packages/core`, and turn the
`.todo` tests green. That green suite is the gate before anything trusts an answer.

## Getting started (once dependencies are installed)

```sh
pnpm install
pnpm db:generate     # after schema models exist
pnpm test            # runs the permission-filter guard suite
```
