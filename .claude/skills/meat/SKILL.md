---
name: meat
description: "Abridge a unified diff into a reading diff using this repo's meat CLI. Use when reviewing or summarizing a commit, range, staged, unstaged, or piped diff; when a large diff needs abridging into a reading-diff; or when looking at a diff's shape with no API key (`-look`)."
license: Apache-2.0
---

# meat

Run this repo's meat CLI on the user's actual diff. The answer is what meat printed. A raw unified diff is the input to meat, not the substitute for it. If meat cannot run, show that failure after `node src/cli/main.ts -h`.

## 1. Resolve the launch line

From this checkout, invoke meat with `node` on the CLI entry:

- Source: `node src/cli/main.ts`
- Built (after `npm run build`): `node dist/cli/main.js`

Run it in the git repo whose diff the user asked about.

**Done when** `node src/cli/main.ts -h` (or the `dist` equivalent) exits 0 and prints usage, or you already have a working launch line from this checkout.

## 2. Pick exactly one diff source

- HEAD / most recent commit / none named: `node src/cli/main.ts`
- A `<revision>` (sha, `HEAD~3`, a branch): `node src/cli/main.ts <revision>`
- A `<range>` (`sha1..sha2`, `main...HEAD`): `node src/cli/main.ts <range>`
- Staged / index: `node src/cli/main.ts -staged`
- Unstaged / working tree: `node src/cli/main.ts -w`
- Piped unified diff (stdin): `git show <sha> | node src/cli/main.ts` or `git diff | node src/cli/main.ts`

`-staged` and `-w` cannot combine with each other or with a revision/range.

**Done when** exactly one source above is selected.

## 3. Pick the mode

- **Abridge** (default): meat calls a model and prints a reading diff. Needs `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `XAI_API_KEY` (set `MEAT_MODEL` when the default model is not the one you want).
- **Look** (`-look`): shape, color, length, then the unified-diff text. No model, no API key. Use this when there is no key, or the user asked to look at the diff without abridging.
- **JSON** (`-json`): machine-readable output on stdout. Add it when the caller needs to parse the result.

**Done when** the argv includes `-look` if abridge cannot run (no key), includes `-json` if the caller needs JSON, and otherwise is a plain abridge.

## 4. Run meat

Execute the launch line with the source from step 2 and the mode from step 3.

**Done when** meat printed a reading diff, a `-look` shape/length/unified view, or `-json` output — or a clear failure (`meat: …`, or usage from `-h`). A missing-key abridge error is not success: obtain a key, or rerun with `-look`.

## 5. Return meat's output

Give the user meat's stdout (plus any `meat:` status line on stderr). Further flags and env: `node src/cli/main.ts -h` and `README.md`.

**Done when** the reply is meat's output for the user's diff.
