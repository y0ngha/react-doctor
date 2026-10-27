---
"oxlint-plugin-react-doctor": patch
---

Build control-flow graphs only for requested functions and compute unconditional-block sets only when needed. Reuse both results across rule queries to avoid scanning and retaining unused function graphs.

Avoid tracing class helper invocation paths for AST nodes that do not acquire a listener or timer.
