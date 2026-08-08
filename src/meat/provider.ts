// Model resolution and backend dispatch (specs/providers.md G1-G2), plus
// `NewModelFromEnv` (G17 — routes through either provider constructor,
// deferred here from item 4b since both `anthropic.ts`/`openai.ts` needed
// to exist first; item 4p, the later of the two, lands it).

import { NewAnthropicFromEnv } from "./anthropic.ts";
import { NewOpenAIFromEnv, DefaultOpenAIModel } from "./openai.ts";
import { type Model } from "./model.ts";

/**
 * Go's `const DefaultModel = DefaultOpenAIModel` (`meat/provider.go:10`) —
 * a re-export, not a duplicated literal, so the two can never drift. A
 * **function**, deliberately, not a top-level `const`: `openai.ts` imports
 * `resolveModel` from this file (used inside `NewOpenAIFromEnv`'s body),
 * and this file needs `DefaultOpenAIModel` from `openai.ts` — a genuine
 * circular ES module dependency, unlike `rubric.ts`<->`meat.ts`'s (item
 * 4n), where every cross-reference on both sides is safely inside a
 * function body. A top-level `const DefaultModel = DefaultOpenAIModel`
 * would read that binding at MODULE EVALUATION time, whose value depends
 * on which of the two modules a consumer happens to import first — one
 * order initializes cleanly, the other hits `DefaultOpenAIModel` still in
 * its temporal dead zone and throws. Deferring to a function call
 * sidesteps the ordering hazard entirely: by the time anything calls
 * `DefaultModel()`, both modules have long finished loading.
 */
export function DefaultModel(): string {
  return DefaultOpenAIModel;
}

/** The two-argument fallback core `ResolveModel` calls with `DefaultModel()`. */
export function resolveModel(model: string, fallback: string): string {
  if (model === "") {
    model = process.env["MEAT_MODEL"] ?? "";
  }
  if (model === "") {
    model = fallback;
  }
  return model;
}

/**
 * The CLI model fallback chain: an explicit value wins outright; otherwise
 * `$MEAT_MODEL`; otherwise `DefaultModel()`. No network or credential work,
 * so callers can resolve the cache identity cheaply and offline.
 */
export function ResolveModel(model: string): string {
  return resolveModel(model, DefaultModel());
}

/**
 * A pure string-prefix rule applied to the *resolved* model id: after
 * stripping one optional leading `"anthropic/"`, an id starting with
 * `"claude-"` dispatches to Anthropic; any other id (including the default)
 * dispatches to OpenAI. H1 does not apply — an ASCII-literal prefix compare
 * agrees under byte or UTF-16 indexing either way.
 */
export function isAnthropicModel(model: string): boolean {
  const stripped = model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
  return stripped.startsWith("claude-");
}

/**
 * Go's `NewModelFromEnv` (`meat/provider.go:31-37`, G17): constructs the
 * built-in backend appropriate for `model` — Claude model ids dispatch to
 * Anthropic Messages, every other id to OpenAI Responses. Its only caller
 * in the whole Go tree is `cmd/meat/main.go:130` (item 5d).
 */
export async function NewModelFromEnv(signal: AbortSignal, model: string): Promise<Model> {
  const resolved = ResolveModel(model);
  if (isAnthropicModel(resolved)) {
    return NewAnthropicFromEnv(signal, resolved);
  }
  return NewOpenAIFromEnv(signal, resolved);
}
