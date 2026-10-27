---
"react-doctor": patch
---

Limit automatic lint concurrency to four workers to reduce memory used by replicated Node processes and plugin heaps. Core and memory limits still apply; explicit worker counts and `--no-parallel` keep their existing behavior.

Stop duplicate JSX analysis after its node budget is exhausted instead of parsing remaining files and repeating limit failures. Preserve collected findings and continue past oversized files while budget remains.
