# Audit the codebase

Investigate the repository rather than only its latest commit. The current agent
performs the investigation; loading this file does not scan or upload source.

Choose a primary domain from the user's concern: security, UX, performance,
API, copy, CLI, or general correctness. If none is named, use general correctness
and the repository's highest-risk boundaries. A multi-domain sweep is a shallow
triage unless the evidence supports deeper coverage; it is not several complete
audits. Load requested specialist guidance and only relevant checklists.

| Domain | Investigate |
|---|---|
| Security | Trust boundaries, authorization, untrusted inputs and sensitive outputs |
| UX | Complete user journeys, recovery, keyboard access and observed interface behavior |
| Performance | Workload, hot paths, resource lifetime and measured costs |
| API | Consumer contracts, errors, pagination, compatibility and failure handling |
| Copy | Whether instructions, actions and errors help users complete a real task |
| CLI | Discovery, argument handling, exit status, streams and recovery from errors |

Checklist entries and search matches are leads, not findings. Verify the trigger,
existing protections and actual consequence. Missing caching, a particular flag,
or a naming convention is not inherently a defect. Label unmeasured performance
concerns as hypotheses and UI behavior not exercised as unverified.

1. Identify HEAD and dirty state. Read project instructions, README, manifests,
   build/check commands, and existing architecture documents. Establish the
   requested directories and concern. For a whole-repository request, start with
   a map of first-party modules; exclude dependencies, build output and generated
   code from detailed reading unless they affect the question.
2. Locate entry points and trace representative paths through business logic,
   storage, external services, configuration and error handling. Follow references
   across files. Read the types and tests that define behavior at those boundaries.
3. Inspect high-risk paths first: authentication, authorization, input handling,
   writes, concurrency, retries and recovery. Also inspect any area the user named.
   Apply the review policy's implementation, contract and verification checks.
4. Track each major module as traced, sampled, or not inspected. For traced paths,
   record entry point, important dependencies, effects and supporting tests.
   Disclose missing source or context. Large repositories may need several passes;
   a sampled audit must not claim every file was reviewed.
5. Run required checks if they are available and appropriate to the task. Keep
   results separate from source-based conclusions. A passing suite does not
   establish the behavior of paths it does not exercise.
6. Return the architecture map, evidence-backed findings in priority order,
   coverage record, check results and the next useful investigation. Include
   concrete source references. A small diagram can explain an important flow.

Audit is read-only unless the user also requests fixes. Do not generate a diff
packet for the entire repository: packets accept unified diffs, not source trees.
Use Understand for a focused behavior question and Review for a specific change.

For each finding add the root cause and a recommended fix to the shared policy's
required evidence. Use columbo's P0–P3 priorities based on demonstrated impact;
retain and explain priorities from external reports rather than silently mapping
them. Include a compact coverage table:

| Module/path | Domain | Traced / sampled / not inspected | Evidence and gaps |
|---|---|---|---|

Record actual paths and checks, not just checked boxes. Recommend the next deep
pass where sampling leaves important uncertainty. Creating issues or applying
fixes requires that work to be in the user's scope.

This activity is self-contained. Specialist skills are optional.
