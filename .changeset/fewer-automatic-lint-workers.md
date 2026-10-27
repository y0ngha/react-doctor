---
"react-doctor": patch
---

Limit automatic lint concurrency to four workers to reduce memory used by replicated Node processes and plugin heaps. Core and memory limits still apply; explicit worker counts and `--no-parallel` keep their existing behavior.
