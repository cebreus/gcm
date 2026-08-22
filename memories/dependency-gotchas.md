# Dependency Gotchas

Description: Known package manager issues, version incompatibilities, and module resolution traps.

## 🚨 Mixed Package Managers Can Break `node_modules` State

- **Date Discovered:** UNKNOWN
- **Category:** Dependency
- **Context/Manifestation:** Running `pnpm` in a workspace previously populated by another package manager caused warnings about moving packages to `node_modules/.ignored` and produced an `ENOENT` failure during dependency status checks.
- **Rule:** Use one package manager per workspace (Bun, per `AGENTS.md`). If `pnpm` is used for scripts/tests, avoid mixing `bun install` and `pnpm install` in the same `node_modules` without a defined reconciliation process.
