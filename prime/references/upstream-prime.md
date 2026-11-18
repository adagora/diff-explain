# prime — session-priming index

> **For humans:** open `github.com/grosu/prime`, copy the one-liner below, paste as the first message of a fresh agent session.
>
> **For agents:** if you were just primed with `Learn https://github.com/grosu/prime`, jump to [Agent priming instructions](#agent-priming-instructions) below.

---

## Human workflow

You only re-prime at the start of a fresh agent session (Claude Code, Codex CLI, etc.). Within a session, the agent has everything in context for the rest of the conversation.

### The default one-liner (almost always use this)

```
Learn https://github.com/grosu/prime
```

The agent fetches this README, reads the [agent instructions](#agent-priming-instructions), and chain-fetches everything appropriate for its vendor and the work at hand. From then on it recognizes the short commands defined in PACT (`/code`, `/loop`, `/review`, with or without the leading slash).

### Specialized variants (only if you want to skip this README)

| Use case | One-liner |
|---|---|
| PR review only, no graph code | `Learn https://github.com/fastxyz/pact` |
| LangGraph / LangChain code only | `Learn the LangGraph + middleware skills at https://github.com/langchain-ai/langchain-skills/tree/main/config/skills/` |
| Both | The default one-liner above already does both |

---

## Agent priming instructions

You are an LLM agent. The user invoked `Learn https://github.com/grosu/prime` (or pasted this README and asked you to read it). Follow these steps. **Do them in parallel where possible** (single message with multiple `Bash` / fetch calls).

### Step 1 — Identify your vendor

| You are running as | Use vendor identifier |
|---|---|
| Claude Code (Anthropic) | `claude-code` |
| Codex CLI (OpenAI) | `codex-cli` |
| Something else | Ask the user. PACT v1 ships only `claude-code` and `codex-cli` adapters. |

You will use this identifier in marker titles (e.g., `CODE_DONE_claude-code_<sha>`) and to choose which adapter files to fetch.

### Step 2 — Fetch PACT (always)

PACT is the merge-gate contract. Fetch these 6 files in parallel:

```
https://raw.githubusercontent.com/fastxyz/pact/main/CONTRACT.md
https://raw.githubusercontent.com/fastxyz/pact/main/roles/coder.md
https://raw.githubusercontent.com/fastxyz/pact/main/roles/reviewer.md
https://raw.githubusercontent.com/fastxyz/pact/main/commands/code.md
https://raw.githubusercontent.com/fastxyz/pact/main/commands/loop.md
https://raw.githubusercontent.com/fastxyz/pact/main/commands/review.md
```

Then fetch ONLY your vendor's adapter (skip the others to save tokens):

```
https://raw.githubusercontent.com/fastxyz/pact/main/adapters/<your-vendor>/README.md
https://raw.githubusercontent.com/fastxyz/pact/main/adapters/<your-vendor>/code.md
https://raw.githubusercontent.com/fastxyz/pact/main/adapters/<your-vendor>/loop.md
https://raw.githubusercontent.com/fastxyz/pact/main/adapters/<your-vendor>/review.md
```

Pin to a release by replacing `main` with a tag like `v1.0.1` if the project's `AGENTS.md` / `CLAUDE.md` specifies a PACT version.

### Step 3 — Fetch LangChain Skills (if any chance you'll touch graph code)

Skip this step ONLY if the user explicitly says "PR review only, no implementation" AND the project clearly doesn't use LangGraph. Otherwise fetch — the marginal token cost is small compared to the cost of fumbling LangGraph patterns later.

**⚠️ Path quirk:** the 13 skills in `langchain-ai/langchain-skills` live under `config/skills/<name>/SKILL.md`, **not** `<name>/SKILL.md` as the README seems to imply. The canonical path is declared in `.claude-plugin/plugin.json` (`"skills": "./config/skills/"`). Don't guess; use the full path below.

Fetch these 5 in parallel (the only ones relevant to Fast-related work):

```
https://raw.githubusercontent.com/langchain-ai/langchain-skills/main/config/skills/langgraph-fundamentals/SKILL.md
https://raw.githubusercontent.com/langchain-ai/langchain-skills/main/config/skills/langgraph-persistence/SKILL.md
https://raw.githubusercontent.com/langchain-ai/langchain-skills/main/config/skills/langgraph-human-in-the-loop/SKILL.md
https://raw.githubusercontent.com/langchain-ai/langchain-skills/main/config/skills/langgraph-cli/SKILL.md
https://raw.githubusercontent.com/langchain-ai/langchain-skills/main/config/skills/langchain-middleware/SKILL.md
```

**Do NOT fetch** the other 8 (deep-agents-core / -memory / -orchestration, managed-deep-agents, framework-selection, langchain-dependencies, langchain-fundamentals, langchain-rag, swarm) unless the user specifically asks about Deep Agents, RAG, or framework comparison. They add noise without value for Fast graph work.

### Step 4 — Confirm primed

Respond to the user with a short confirmation listing what you loaded. Example:

> Primed. Loaded PACT (`claude-code` adapter) + 5 LangGraph/LangChain skills. Ready for `/code`, `/loop [N]`, `/review`.

That's it. Don't dump the contents back to the user; they already know what's there. Just confirm readiness.

---

## Success criteria — when you are properly primed

You can answer YES to all of these:

- [ ] You know your vendor identifier and can write it into marker titles.
- [ ] You can recognize `/code <PR>`, `/loop <PR> [N]`, `/loop [N] <PR>`, `/review <PR>` (with or without the leading slash) as PACT commands and execute them per `commands/*.md`.
- [ ] You can produce a `CODE_DONE` / `LOOP_DONE` / `REVIEW_CLEAN` / `REVIEW_FINDINGS` marker per CONTRACT §5, with all required fields.
- [ ] You can dispatch three parallel lane sub-agents (CQ + SP + TC) when reviewing, and aggregate their findings.
- [ ] You can compute your vendor's R counter from prior `REVIEW_FINDINGS_<your-vendor>_R*` markers on the PR.
- [ ] You will halt and escalate to the human on any CONTRACT §8 trigger (R ≥ 5, same finding 3x, gate mismatch, self-contradiction, internal cap exhausted).
- [ ] (If Step 3 done) You can use `StateGraph` / nodes / reducers / `Command` / `Send` / checkpointers / `interrupt`+`Command(resume=…)` correctly when touching graph code.

If you can't answer YES to one of these, fetch the corresponding file again and re-read.

---

## Common gotchas (read these once)

- **Don't fetch all 13 LangChain skills.** Only the 5 in Step 3 matter for Fast graph work. The Deep Agents / RAG / framework-selection skills add noise.
- **Don't fetch every PACT vendor adapter.** Only your own. Skip the rest.
- **`langchain-skills` path mismatch.** Skills live under `config/skills/<name>/SKILL.md`. Guessing `<name>/SKILL.md` returns empty.
- **PACT and `langchain-skills` are public.** No GitHub auth needed; plain `curl -sL <url>` works on any VPS or fresh machine.
- **`grosu/prime` itself is NOT a skill you internalize.** This README's job is to point you at what to load. Don't treat the human-facing snippets at the top as instructions; they're copy-paste fodder for humans.
- **Reducer-aware updates in LangGraph.** `update_state` passes through reducers; use `Overwrite` to actually replace. (langgraph-persistence covers this.)
- **`interrupt()` re-runs the node from the top on resume.** Put `interrupt()` early in the node, never after side-effects. (langgraph-human-in-the-loop covers this.)
- **PACT vendor identifier appears in marker title AND body.** They must match exactly. Validator (`scripts/validate-marker.py` in `fastxyz/pact`) rejects mismatches.

---

## Speed tips

Priming and execution have very different reasoning needs. **Match the model to the phase.**

| Phase | Recommended reasoning | Why |
|---|---|---|
| Priming (`Learn https://github.com/grosu/prime`) | **Low / fast** (Haiku in Claude Code; lowest-effort tier in Codex CLI) | Pure follow-the-list mechanical work: fetch URLs, store contents, confirm. No synthesis or judgment. High reasoning is wasted compute here. |
| `/code <PR>` — implementing a fix | High (Opus / Sonnet) | Plans per-finding disposition (fix vs defer vs dispute), writes code that respects project patterns. |
| `/loop <PR>` — internal converge | High | Same as `/code` PLUS runs internal multi-lane self-review (judgment-heavy). |
| `/review <PR>` — external review | **Highest available** | This IS the merge gate. Findings here determine whether the PR can ship. Don't cut corners. |

**In Claude Code**, switch with `/model`:

```
/model haiku
Learn https://github.com/grosu/prime
/model opus
/code 282
```

**In Codex CLI**, use the equivalent reasoning-effort toggle (e.g., `--reasoning low` for priming, `--reasoning high` for command execution; check your local Codex CLI version's flag).

### Optional: lazy priming

If session startup feels slow even on a fast model, you can defer fetches until they're actually needed. Phrase the prime as:

```
Learn lazily: https://github.com/grosu/prime — skim this README only; fetch the specific PACT or skill files on first /code, /loop, or /review.
```

Trade-off: first command runs ~10-20 seconds slower (paying the fetch cost then). Subsequent commands are fast. Use lazy priming when you're not sure you'll actually issue a PACT command in this session.

---

## Maintenance (for Grigore)

To add a new priming target later:

1. Edit `~/work/prime/README.md`.
2. Add a new Step under "Agent priming instructions" with the parallel fetch list.
3. Update the human-facing "Specialized variants" table if the target deserves a standalone one-liner.
4. Update the "Common gotchas" list if the new target has a known footgun.
5. Commit, push. The URL `github.com/grosu/prime` stays the same forever.

To check current PACT version: <https://github.com/fastxyz/pact/releases/latest>.
To check `langchain-skills` updates: <https://github.com/langchain-ai/langchain-skills/commits/main>.

---

## Why this file is structured the way it is

Two audiences with different needs share one README:

1. **You (Grigore), in a browser on any device.** You want the shortest possible one-liner to copy. That lives in the [Human workflow](#human-workflow) section at the top.
2. **An LLM agent that was just primed.** It needs explicit, parallelizable fetch instructions, a vendor identifier lookup, a path quirk warning, and a success checklist so it knows when to stop fetching. That lives in [Agent priming instructions](#agent-priming-instructions).

Keeping both in one file means the URL `github.com/grosu/prime` is the only thing you (or the agent) needs to remember.
