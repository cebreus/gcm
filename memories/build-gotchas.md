# Build Pipeline Gotchas

Description: Known build pipeline issues, TypeScript errors, and environment configuration traps.

## 🚨 Missing `DOM.Iterable` Broke Typechecking of `Headers`

- **Date Discovered:** UNKNOWN
- **Category:** Build Pipeline
- **Context/Manifestation:** TypeScript typechecking failed on `res.headers.entries()` without `DOM.Iterable` in `tsconfig.json` libs.
- **Rule:** If code uses iterable DOM types (`Headers`, `URLSearchParams`, etc.), include `DOM.Iterable` in `tsconfig.json` `compilerOptions.lib`.

## 🚨 `bunx tsc --noEmit` Not Green Due To Test Typings

- **Date Discovered:** UNKNOWN
- **Category:** Build Pipeline
- **Context/Manifestation:** TypeScript typechecking reports errors in tests around `fetch`/`Response` typing (e.g., missing Bun `fetch.preconnect`) and other mocks, even though `bun test` passes.
- **Rule:** Treat `bun test` and `tsc --noEmit` as separate gates; keep a documented policy for whether typecheck includes tests, and align test mocks with the runtime's type definitions if typecheck must be green.
