# meat

Abridge a code diff into a **reading diff**.

Humans need to review agent-written code in critical systems.
But models are good now. You don't need to review for style or nil-checks
or imports. You need to review concepts, algorithm choices, architecture.

So meat uses a model to reduce a diff to the important parts.
It shows you the meat.

Very large diffs are split at file and hunk boundaries and abridged
chunk by chunk (up to a few MB), so one huge commit still produces a
single merged reading diff — it just takes proportionally longer.

## Run it (TL;DR)

```
npm install
npm run build
export OPENAI_API_KEY=...   # or ANTHROPIC_API_KEY=... with MEAT_MODEL=claude-...
node dist/cli/main.js        # reviews HEAD in the current git repo
```

Or skip the build and run straight from source:

```
node src/cli/main.ts <revision-or-range>
```

Common flags: `-staged` (review the index), `-w` (review unstaged changes),
`-json` (machine-readable output), `-h` (full usage). Results are cached
under `~/.meat`; set `MEAT_CACHE` to relocate it.

Dev loop: `npm run check` (type-check + `node --test`, includes the
conformance suite against `conformance/vectors/`).
