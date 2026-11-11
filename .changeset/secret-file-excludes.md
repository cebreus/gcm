---
"gcm": minor
---

Exclude secret-bearing files from analysis by default: `.env` and `.env.*` (including `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` and `id_ed25519*`; they are neither sent nor listed and still commit normally.
