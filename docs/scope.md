# Hearth — v1 Scope (must-haves)

**Boundary:** Hearth is a **narrative memory + prep tool with light, display-only
character sheets.** It is **not** a Virtual Tabletop — no dice, HP, combat, or
initiative. It lives *alongside* Roll20/Foundry/D&D Beyond, not against them.

**The lens:** one memory, one permission filter. Every feature is a *view* of the
memory or a *write* into it. If it's neither, it isn't Hearth.

Locked decisions (2026-07-04):
- **Character sheets:** light + display-only (level, class, key stats).
- **NPC generator:** must-have (Claude-powered; output = `DM_ADDED` units).
- **Interactive page:** full set in v1 — codex, chat, character page, timeline,
  relationship graph, map — and **visual quality is a first-class requirement.**

---

## Bot (primary interface)
- Ask the memory, **permission-filtered per character**.
- Replies **ephemeral / DM** so answers never leak in shared channels.
- **Session capture** (voice → per-speaker transcript → `SESSION` units).
- **Recap** ("catch me up / last session").
- **DM-only prep queries** (open threads, spotlight balance).
- **Provenance in answers** ("from Session 4").

## DM tools
- **Add knowledge** (upload/paste) → `DM_ADDED`, gated DM-only by default.
- **Fog-of-war reveal controls**: view visibility; reveal to everyone / party /
  character(s); revoke; full **reveal history** (audit).
- **Edit / correct / delete** units (trust in the memory).
- **Character management** — create PC, link to Discord user + web account,
  assign party; light sheet fields.
- **NPC generator** — Claude invents an NPC; DM keeps/edits; saved as `DM_ADDED`.
- **Prep dashboard** — light in early phases; rich stats dashboard in the page phase.
- **Narrative stats only** — spotlight balance, threads open/closed, session count.
  (No mechanical/combat stats.)

## Interactive page (behind login, per-viewer filtered, DESIGN-FORWARD)
- **Login + per-viewer permission-filtered rendering.**
- **Codex** — searchable NPCs/locations/lore/items.
- **Embedded chat** with the memory.
- **Character pages** — what a PC knows/has done + light sheet.
- **Timeline** — scrub the campaign session by session.
- **Relationship graph** — who knows/allies/betrays whom.
- **Map** — DM-uploaded image, pins linked to memory, fog-of-war overlay.
- **Themes** — at least one genuinely beautiful default; picker/more presets follow.

## Cross-cutting
- **Identity linking:** Discord user ↔ Hearth web account ↔ membership ↔ character,
  so both surfaces show the same filtered view.
- **The permission filter wraps every read on every surface.**
- **Design system + themes** treated as their own track (see below).

## Fog-of-war UX principle (how the filter shows up on screen)
- **Players never see what they're missing.** Hidden knowledge is *absent*, not
  greyed-out or locked. Every player's page looks complete to them — no teasing
  placeholders, no "🔒" hinting a secret exists.
- **Revelation is a live moment.** When the DM reveals something, it animates in
  on the player's open page — **fog lifting**, in real time (Supabase Realtime),
  no refresh. Creating a grant *is* the event the page subscribes to.
- **The DM sees the whole world**, fully legible, with small state chips
  (`Hidden` / `Party` / `Everyone`) for *management* — never as grey-out.
- **The bot/chat never leaks absence.** A filtered answer stays inside what the
  character knows and does not hint that anything was withheld.
- **Map is the one exception to consider:** classic "dark unexplored" fog is often
  *wanted* on a map. Flagged as a DM option, not assumed.

## Explicitly OUT (not just later — out)
- Dice rolling, HP/combat/initiative, full mechanical character sheets, VTT play.

## Deferred to a later phase (in scope, not v0)
- Live streaming "bathroom-break" recap (its own cost/complexity tail).

---

## Schema implications (for the Phase 0 model)
- **Character** gains display-only fields: `level`, `class`, `ancestry`,
  `pronouns`, `stats` (JSON), `avatarUrl`, `bio`, `status`. No combat logic.
- **Relationships = KnowledgeUnit** of `type = RELATIONSHIP` with `subjectId` /
  `objectId` FKs to other units. The graph is then "free" — it reads
  relationship units the viewer is allowed to see, through the *same* filter.
- **NPC generation** = `DM_ADDED` unit with an `origin` marker (`PLAYED` /
  `AUTHORED` / `GENERATED`) for provenance/trust. No new table.
- **Map / MapPin** = their own tables (built in the map phase). A pin references a
  `KnowledgeUnit` and inherits its visibility → fog-of-war overlay comes for free.
- **Timeline** = derived from `Session` + unit provenance. No schema change.

## Design track (because "amazing looking" is a requirement)
- The web page is a **first-class design effort**, not an afterthought.
- Explore themes + key screens (codex, character page, graph) as **mockups early**
  — in parallel with building the memory/bot — so visuals are ready by the page phase.
- Invest in a small **design system** (tokens, components) so every screen and
  every theme stays coherent.
