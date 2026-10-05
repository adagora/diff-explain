# Specifications and their authority

Use [INDEX](INDEX.md) to find the current TypeScript module, contract and tests
for a question. Use [system design](../docs/system-design.md) for relationships
between modules and the [roadmap](../docs/roadmap.md) for proposed work.

## Status and evidence

Most subject documents originated during the Go-to-TypeScript migration.
Their Go citations and stage checkmarks describe the frozen baseline. Current
TypeScript additions and source-observed limits are labelled separately.
[Agent interface](agent-interface.md) is a proposed contract with no runtime
implementation; its names are not available commands or fields.

For each non-obvious current claim, identify the active source path and symbol.
Link a test when one constrains the claim. Distinguish an executable guarantee
from behavior observed only in source. Use line references when helpful, and
verify them when editing; stable paths and symbols survive line movement.

Source shows what currently happens, tests constrain cases, and specs describe
the intended contract. Resolve disagreements in the owning change. Preserve
frozen vectors; new TypeScript behavior is permitted with explicit compatibility
and version decisions. Historical Go authority does not prohibit new features.

## Maintaining a subject contract

Keep purpose, vocabulary, guarantees, mechanism, limits, errors and evidence
together. Follow [the baseline format](../migration/SPEC-FORMAT.md) where it
helps, using TypeScript evidence for TypeScript behavior. A useful new contract
also states:

- Inputs, identity and coordinate units.
- Outputs and the precise validation or coverage they establish.
- Dependencies, side effects and costs.
- Failure/cancellation/partial-result behavior and useful recovery.
- Compatibility, protocol/cache implications, and acceptance evidence.

Update the owning spec and meaningful tests when behavior changes. Keep design
proposals in the proposed interface/roadmap until implementation exists. At
completion, reconcile the proposal, current spec, usage and decision rationale;
avoid two competing definitions of the same contract.

[Glossary](glossary.md) owns shared vocabulary. [Decisions](../docs/decisions.md)
owns maintained rationale and revisit conditions. [INDEX](INDEX.md) retains
the historical extraction ledger below its current navigation table. Counts
and checkmarks in that ledger are not current test-run results.
