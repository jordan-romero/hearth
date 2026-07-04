# Hearth — Architecture & Patterns

The contract we build against. If a change violates one of these, we stop and
either fix it or change the rule on purpose — we don't let it slide.

## The one rule: dependencies flow inward, `core` stays pure

```
   apps (bot / web / worker)        ← thin adapters, no business logic
        │
        ▼
   agents / services                ← orchestration: load data, apply rules
        │            │
        ▼            ▼
   core (pure)   db (Prisma)         ← core NEVER imports db / apps / a framework
```

- **`core`** — pure domain logic (the permission filter). No I/O, no Prisma, no
  framework imports. Tested exhaustively with plain objects. This is the security
  spine; it must be provable without a database.
- **`db`** — the ONLY place that touches Postgres. One Prisma client singleton,
  the schema, and data-access helpers. A leaf.
- **`agents`** — Claude workflows (extraction, retrieval answers, prep). Compose
  `core` + `db`.
- **`services`** (added as needed) — orchestration: load via `db`, decide via
  `core`, return. Where "filtered retrieval" lives.
- **`apps`** — translate a transport event (Discord message, HTTP request) into a
  service call and back. **No business logic in an app file.**

## Functional core, imperative shell
Decisions are **pure functions** in `core`; I/O happens only at the edges.
`filterKnowledge` is the exemplar — plain data in, plain data out, touches nothing.
That purity is *why* the security boundary is testable, and every rule follows it.

## The filtered-retrieval pattern (Phase 1's backbone)
Every read of the memory has one shape, and there is **no code path that returns
knowledge without passing through the filter**:
```ts
async function retrieveForViewer(viewer, query) {
  const candidates = await db.knowledge.findCandidates(query); // I/O  (shell)
  const mapped     = candidates.map(toFilterable);             // boundary mapping
  return filterKnowledge(viewer, mapped);                      // pure (core)
}
```

## Boundary types — don't leak the ORM into the domain
`core` defines its own minimal inputs (`Viewer`, `FilterableKnowledgeUnit`) instead
of importing Prisma models. A thin mapper converts Prisma rows → domain shapes, so
neither side is chained to the other.

## Single source of truth
One schema (Prisma). One filter (`core`). Types generate from the schema. The
permission rule exists in exactly one place and is imported everywhere.

## Testing
- **`core`** → pure unit tests, exhaustive, no mocks. Heaviest coverage in the repo.
- **`db` / `services`** → integration tests against a test database.
- Security paths are tested **adversarially**: try to leak, assert it can't.

## Conventions we hold (sane defaults — change deliberately, not by drift)
- **Validate at boundaries** (proposed: `zod`). The core trusts its typed inputs;
  anything crossing an app/service edge is validated first.
- **Errors**: throw typed errors at the edges; `core` returns values, it doesn't
  throw for control flow.
- **Config/env**: read in one place, never scatter `process.env` through logic.
- **Small, named, single-responsibility functions** over clever abstractions.
  Explicit beats implicit.
- **Apps stay thin.** If an app file grows logic, it moves to a service or `core`.
- **Naming**: match the surrounding code; domain words the table would recognise.

## Where spaghetti actually creeps in
Not here — the current code is small and clean. It creeps in at the **app/service
layer** we haven't built yet: the moment a Discord handler starts querying the DB
and branching on business rules inline. The rule at the top (apps thin, logic in
`core`/services, filter wraps retrieval) is the specific guardrail against that.
We hold it, and we review every new app file against it.
