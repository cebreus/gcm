---
'gcm': patch
---

Write logs, the intro banner and progress to stderr so stdout carries only results, and draw the spinner only on a terminal. Repository warnings, commit failures, provider-unavailable notices and a reply that cannot be parsed are reported on stderr, and an unknown provider error names the rejected provider and lists the valid ones.
