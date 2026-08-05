# specs

Language-neutral specifications of `meat`, written during stages 1 and 2 of the
TypeScript migration and used as the source of truth for stage 3.

Every non-obvious claim here carries a citation to the Go implementation
(`meat/chunk.go:895-908`). The prose is what you build from; the citation is
where you go when the prose runs out.

- **Format and citation rules:** [`../migration/SPEC-FORMAT.md`](../migration/SPEC-FORMAT.md)
- **Coverage ledger:** [`INDEX.md`](INDEX.md)
- **Migration plan:** [`../migration/README.md`](../migration/README.md)

Nothing here describes Go types, signatures, or idioms. If a spec reads like Go,
it is wrong — see the anti-patterns in `SPEC-FORMAT.md`.
