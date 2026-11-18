# Work

Implement the user's requested outcome and leave enough evidence to assess it.

1. Carefully read the complete root AGENTS.md and README.md, when present, and
   applicable nested instructions. Recover truncated sections before proceeding.
   Establish the project's purpose, entry points, major components and technical
   architecture from source and tests. Then trace the paths relevant to the task,
   including effects and failure handling. Match investigation depth to scope;
   a focused fix does not require auditing every file. State important gaps rather
   than claiming complete understanding. Establish intended behavior and acceptance
   criteria, inspect existing patterns, and preserve unrelated working changes.
2. Implement the scoped outcome. Resolve routine choices yourself. Ask only for
   information that materially blocks the work, while progressing independently
   where possible. Do not turn an implementation request into a perpetual review
   loop or grow scope merely to satisfy an activity checklist.
3. Run the project's required checks and appropriate targeted verification.
   Provider checks normally use mocks; live model calls require user intent.
   Report actual commands and outcomes separately from checks you only recommend.
4. Before finishing, inspect the actual final diff and relevant surrounding code.
   Check behavior, contract alignment, regression risks, and test relevance.
   Include added files explicitly: ordinary Git diffs omit untracked files.
5. For a substantial or hard-to-read change, load `columbo prime review` and apply
   its checkpoint in this session. A separate agent or API is optional, never
   automatic. For a small, clear edit, direct diff inspection is enough. When
   using a reading diff, retain the original for correctness review.
6. Fix concrete issues found within scope, then rerun checks justified by those
   fixes. Stop speculative cycling; if unresolved concerns remain, state them.
   Do not claim an independent review of your own work.

Finish with the resulting behavior, important evidence, checks actually run, and
material limitations. Update the target's relevant specs or durable decisions
when warranted. Do not commit, push, post comments, or merge merely because the
workflow reached its final checkpoint; those operations follow user authorization
and project policy.

## Continuation and completion

Fixing findings is implementation work: verify each finding against the current
snapshot, make scoped fixes, rerun affected checks and review the result. Record
fixed, open, disputed or deferred findings with evidence. There is no default
round cap. Honor explicit user limits across turns and session handoffs.

Complete when the requested behavior is implemented, required checks pass and
consequential changes have been reviewed. Missing checks remain unverified.
When progress stalls, investigate the cause or change approach; do not repeat an
ineffective fix or invent work to keep going. Report blockers and continue any
independent authorized work. Host lifecycle and budget rules govern continuation;
never report an unfinished objective as achieved because a limit was reached.

For explicitly requested persistence, prefer the host's native `/goal` when
available. Do not create a second loop, schedule, hook or goal automatically.
A goal keeps work moving; it does not supply review evidence or permission for
new scope. Ordinary implementation proceeds in the current session.

On a status request or requested next-session prompt, follow the entry file's
status and handoff guidance. Keep goals, agreed work and optional ideas distinct.

When requested or useful for stateful behavior, follow the entry file's optional
statechart guidance. Show proposed behavior before implementation or trace the
resulting behavior to source; compare transitions when that clarifies the change.
Label the evidence and omissions. Model checking is optional and requires an
actual check before claiming its result. Keep the original diff for review.
