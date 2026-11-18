# Review a change

Apply the shared review policy to the user's selected change.

1. Establish the scope and identity: commit ID, base/head comparison, staged
   changes, unstaged tracked changes, or a supplied diff. Use the actual target
   branch. Identify new files omitted by ordinary Git diffs.
2. Read the original diff and relevant source, callers, contracts and tests.
   Check implementation, contract alignment and verification as defined in the
   policy. Record concrete findings once and cite their source evidence.
3. When a smaller reading view helps, run `columbo packet` for that same scope.
   Use a revision/range, `--staged`, `--worktree`, or explicit `--stdin` for pipes.
   Save artifacts outside the reviewed diff. Read `data.instructions`,
   `numbered_diff`, `plan_schema` and move hints. Use `selection_rubric` for
   detailed selection rules. Write a plan from `plan_template` and run
   `columbo compile --packet packet.json --plan plan.json`.
4. Repair rejected plans using the error message and original coordinates.
   Keep the packet unchanged. Offline packets accept 400 KiB of UTF-8 diff bytes;
   narrow the scope deliberately and disclose what was excluded.
5. If API processing was requested, use
   `columbo abridge -json -model MODEL <revision-or-range>`. For unstaged or staged
   input use `-w` or `-staged` without a revision. Legacy flags precede revisions.
   API processing can chunk larger diffs. A fresh `-agent codex` or `-agent claude`
   process returns prose, not compiled output, and has stricter tool/test limits.
6. Report findings, snapshot identity, inspected scope and actual verification.
   Recheck affected findings if the code changes. If another agent will continue,
   leave artifact paths, open questions and the next action in a short handoff.

The reading view omits imports and other model-selected detail. Use original
source for correctness checks. Mark reviews of your own edits as self-review.
PR comments, pushes, approvals and merges follow user authorization and project
policy; reaching the review checkpoint does not request them.

When requested or useful for stateful behavior, follow the entry file's optional
statechart guidance. Show proposed behavior before implementation or trace the
resulting behavior to source; compare transitions when that clarifies the change.
Label the evidence and omissions. Model checking is optional and requires an
actual check before claiming its result. Keep the original diff for review.
