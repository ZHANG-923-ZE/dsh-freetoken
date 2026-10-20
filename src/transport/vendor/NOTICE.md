# Vendored transport modules

These TypeScript files are copied from the frozen reference implementation:

- Project: `cv-superding/dsh-deepseek-web-login`
- Commit: `cfd684d` (v1.0.3)
- License: Apache-2.0 (see the repository `LICENSE` / root `NOTICE`)

Files: `auth.ts`, `browser-login.ts`, `browser-transport.ts`, `context-feed.ts`,
`cookies.ts`, `gate.ts`, `page-session.ts`, `protocol.ts`, `transport-heartbeat.ts`,
`version.ts`, `webapi.ts`.

Local modifications:

- `paths.ts` is a dsh-Freetoken shim (`<DSH_HOME>/freetoken` instead of `web-login`).
- `accounts.ts` is a single-account shim (`activeAccountId()` → undefined, `listAccounts()` → []).
- `webapi.ts` PoW path uses the in-page solver (`solvePowInPage`) and fails closed with
  `POW_REQUIRES_BROWSER`; the Node-side solve is never used (R14).
- All files carry `// @ts-nocheck`; upstream is JavaScript-adjacent TypeScript that is
  type-checked in its own repository. Vendored code is otherwise unmodified.

The rest of dsh-Freetoken (adapter, lifecycle, rhythm, narration, session mapping) is
original code and lives outside this directory.
