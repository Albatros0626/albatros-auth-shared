# @albatros/auth-shared

Shared application-level authentication, secrets vault and session sync for Albatros desktop apps (Electron).

Used by Prospector V2, Cadence, Candidate Manager and future apps.

## Status

`v0.1.0` — Bootstrap (US1 of the [implementation plan](../01%20PROSPECTOR%20V2/docs/39_AUTH_SHARED_USER_STORIES.md)).

## Features

- **Auth service** — PBKDF2-SHA512 password hashing, anti-bruteforce lockout, recovery question.
- **Secrets vault** — DPAPI (Windows safeStorage) wrapping with allowlist enforcement.
- **Session sync** — shared `session.bin` so unlocking one app unlocks the others.
- **Idle lock** — auto-lock after configurable inactivity period.
- **Migration helpers** — one-shot migration from legacy per-app vaults to shared format.

## Install (consumer apps)

```bash
pnpm add github:Albatros0626/albatros-auth-shared#v1.0.0
```

The `prepare` script compiles TypeScript on install — no manual build step needed in the consumer.

## Public API

To be documented as US2-US7 land. Stub in `src/index.ts`.

## Development

```bash
pnpm install
pnpm test            # vitest run
pnpm test:watch      # vitest watch
pnpm build           # tsc -> dist/
pnpm lint            # tsc --noEmit (full type-check)
```

## Versioning

- `v0.x` — work in progress, breaking changes allowed
- `v1.x` — first stable, backwards-compatible bumps within the major
- Major bumps (`v2.0.0`) are breaking and require coordinated rollout across all consumer apps

The vault format carries a `version` + `schemaCompat` field to allow forward-compat reads when possible.

## License

UNLICENSED — internal use.
