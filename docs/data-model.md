# Hearth — Full Data Model (north-star)

**Philosophy: design-complete, build-incremental.** This document maps the
_entire_ production schema so we know Phase 0's lean core is a clean **subset**,
not a dead-end. We still only _build_ each group in its phase — but nothing here
forces a rewrite of the spine, because Postgres/Prisma migrations are **additive**
(new tables/columns don't disturb existing ones).

The Phase 0 migration ships group **A (partial) + B (core)** only. Everything else
lands later. A handful of cheap forward-looking fields are included early (marked
⚑) so early phases don't thrash the schema.

---

## A · Identity & tenancy

| Entity                                       | Purpose                                                    | Phase |
| -------------------------------------------- | ---------------------------------------------------------- | ----- |
| `User`                                       | A person (Auth.js owns this table)                         | 0/1   |
| `Account`, `WebSession`, `VerificationToken` | Auth.js adapter tables                                     | 1     |
| `Campaign`                                   | Tenant root; owns everything; holds `theme` + `gameSystem` | 0     |
| `Membership`                                 | User × Campaign, `role` = DM \| PLAYER                     | 0     |
| `Party`                                      | A group of characters (latent for single-table)            | 0     |
| `Character`                                  | A PC; light display sheet; belongs to Membership + Party   | 0     |
| `CampaignDiscord`                            | guildId, voiceChannelId, textChannelId ↔ campaign          | 1/2   |

> ⚑ **Naming fix baked in at Phase 0:** Auth.js's own model is literally named
> `Session`. Our game session is therefore **`GameSession`** everywhere, so the two
> never collide. We create the (empty) `GameSession` table in Phase 0 for this reason.

## B · The memory — THE SPINE (Phase 0)

| Entity               | Purpose                                                                                                                                                            | Phase |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `KnowledgeUnit`      | The atom: content, `type`, `source`, `origin` ⚑, `baseVisibility`, `campaignId`, `gameSessionId?` ⚑, `sourceDocumentId?`, `authorMembershipId?`, `subjectId?/objectId?` ⚑ (relationships) | 0     |
| `KnowledgeGrant`     | Targeted reveal → Character \| Party; who/when                                                                                                                     | 0     |
| `RevealEvent`        | Append-only audit of every visibility change                                                                                                                       | 0     |
| `KnowledgeEmbedding` | pgvector embedding(s) per unit, by model                                                                                                                           | 1     |
| `ThreadState`        | 1:1 with a `type=THREAD` unit: `status` (OPEN/RESOLVED), `heat`, `lastAdvancedAt`                                                                                  | 3     |

> **Player journal (`/journal`, Phase 3).** A player's private note is a `KnowledgeUnit`
> with `source = PLAYER_NOTE` and `authorMembershipId` set, `baseVisibility = DM_ONLY` +
> a self-grant to the author's character — so it's visible to that player and the DM only,
> yet askable and later shareable through the same spine. Created by the shared
> `addJournalNote()` so bot and web behave identically.

## C · Capture & sessions

| Entity                      | Purpose                                                             | Phase         |
| --------------------------- | ------------------------------------------------------------------- | ------------- |
| `GameSession`               | One session: number, title, date, status                            | 0 (empty) → 2 |
| `Recording`                 | Audio blob ref (Supabase Storage) + speaker map, per session        | 2             |
| `TranscriptSegment`         | Per-utterance: speaker, `tStartMs`, `tEndMs`, `text`, `confidence`  | 2             |
| `SessionAttendance`         | Which characters were present (split-party + spotlight)             | 2             |
| _(live rolling transcript)_ | The bathroom-break buffer — likely **in-memory/Redis, not a table** | 4             |

> **Transcripts are _source_, not memory.** Raw segments are the _input_ to
> extraction; `SESSION` KnowledgeUnits point back to them for provenance. The
> permission filter runs over _extracted units_, never over raw transcript — so
> transcript volume never touches the security hot path. (Exception: the Phase 4
> live recap reads the current-session buffer, which is table-shared knowledge.)

## D · DM inputs

| Entity            | Purpose                                                                                                                                              | Phase |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `SourceDocument`  | A DM source (uploaded file OR synced/linked original): `sourceType`, `storagePath?`/`sourceUrl?`, `status`. The DM's library + `DM_ADDED` provenance | 3 ✅  |
| `DocumentChunk`   | One embedded chunk of a doc's text — the **RAG layer**. `baseVisibility` (DM_ONLY default; EVERYONE for player-visible sources); filtered like units | 3 ✅  |
| _(NPC generator)_ | Writes `KnowledgeUnit` with `origin = GENERATED`, linked to its `GenerationRun` — **no new table**                                                   | 3     |

> **Corpus ingestion, source-agnostic.** A whole doc corpus (upload → Discord → Notion →
> Drive) fans out per-file through the queue: parse → chunk → **embed every chunk** (cheap,
> lossless RAG) → **extract `DM_ADDED` units selectively** (Claude, cost-gated). Raw kept
> for uploads (the `documents` bucket); synced sources keep a link back. Everything is
> `DM_ONLY` by default → hidden from players, revealed on cue.
>
> **Reveal is polymorphic (built in the Phase 3 reveal bite).** `KnowledgeGrant` /
> `RevealEvent` gain optional `documentChunkId` / `sourceDocumentId` alongside
> `knowledgeUnitId` (exactly one target). So a reveal can open a **unit** (a fact), a
> **chunk** (a passage), or a **whole document** (the "party finds a dossier" case — one
> grant opens all its chunks). The permission filter checks unit/chunk `baseVisibility`
> plus grants at all three levels.

## E · Derived artifacts (generated, permission-scoped)

| Entity            | Purpose                                                                                                                | Phase |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----- |
| `DerivedDocument` | Recaps / session summaries / prep briefs: `type`, `audienceScope` (DM \| PARTY \| CHARACTER), `content`, `sourceRunId` | 3     |

> **Recaps are _derived views_, generated _through_ the filter.** A recap is
> permission-sensitive — a player's recap must only contain what their character
> knows. So each is generated from the filtered unit set for a given audience and
> stored with its `audienceScope` (for history + to avoid regenerating). It's
> regenerated when the underlying memory changes. This is _why_ we log generations.

## F · Agent runs / eval / ops

| Entity          | Purpose                                                                                  | Phase |
| --------------- | ---------------------------------------------------------------------------------------- | ----- |
| `GenerationRun` | Every Claude call: `kind`, `promptVersion`, `model`, tokens, latency, cost, status       | 3     |
| _(prompts)_     | **Versioned files in the repo**, not a table — `promptVersion` on the run points at them | 3     |

> One table (`GenerationRun`) serves three needs at once: eval run-logging,
> provenance for derived docs, and the metering source for usage-based billing.

## G · Prep intelligence (mostly derived / computed)

| Concept           | How it's modeled                                                                                                        | Phase |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ----- |
| Open threads      | `KnowledgeUnit(type=THREAD)` + `ThreadState`                                                                            | 3     |
| Spotlight balance | Computed from `TranscriptSegment` + `SessionAttendance` (cache optional)                                                | 3     |
| Belief vs. truth  | A `RELATIONSHIP` unit linking a player-belief unit → a `DM_ONLY` truth unit — **reuses the spine, inherits the filter** | 3     |

## H · The interactive page

| Entity    | Purpose                                                                                      | Phase |
| --------- | -------------------------------------------------------------------------------------------- | ----- |
| `Map`     | DM-uploaded image, dimensions, storage ref                                                   | 5     |
| `MapPin`  | x/y on a map → `knowledgeUnitId` (**inherits that unit's visibility** → fog-of-war for free) | 5     |
| _(theme)_ | `Campaign.theme` preset enum (+ optional overrides later)                                    | 5     |

## I · Billing

| Entity                      | Purpose                                                   | Phase |
| --------------------------- | --------------------------------------------------------- | ----- |
| `Subscription` / `Customer` | Campaign/User ↔ Stripe ids, plan, status                  | 6     |
| _(usage)_                   | Metered off `GenerationRun` (no separate ledger to start) | 6     |

---

## Why the lean start is safe (the load-bearing principles)

1. **Additive migrations.** Every group B→I is _new_ tables/columns added in its
   phase. The Phase 0 core (`KnowledgeUnit` + grants + filter) is never reshaped.
2. **Transcripts = source, memory = extracted units.** Big transcript data never
   enters the permission hot path.
3. **Recaps/summaries = derived, permission-scoped artifacts**, produced through
   the filter, logged to a run.
4. **Threads, belief-vs-truth, relationships all reuse the spine** — they're
   knowledge units, so they're already filtered. No parallel permission systems.
5. **One runs table** covers eval, provenance, and billing.
6. **`GameSession` naming** avoids the Auth.js `Session` collision from day one.

### Cheap forward-stubs included in the Phase 0 migration (⚑)

So early phases don't immediately re-migrate:

- `GameSession` table (empty until Phase 2).
- `KnowledgeUnit.origin` (`PLAYED` / `AUTHORED` / `GENERATED`).
- `KnowledgeUnit.gameSessionId?` (nullable FK — capture fills it).
- `KnowledgeUnit.subjectId? / objectId?` (self-refs — relationships/graph).

Everything else is added when its phase arrives.
