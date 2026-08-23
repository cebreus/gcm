# Build Pipeline Gotchas

Description: Known build pipeline issues, TypeScript errors, and environment configuration traps.

## 🚨 Missing `DOM.Iterable` Broke Typechecking of `Headers`

- **Date Discovered:** UNKNOWN
- **Category:** Build Pipeline
- **Context/Manifestation:** TypeScript typechecking failed on `res.headers.entries()` without `DOM.Iterable` in `tsconfig.json` libs.
- **Rule:** If code uses iterable DOM types (`Headers`, `URLSearchParams`, etc.), include `DOM.Iterable` in `tsconfig.json` `compilerOptions.lib`.
