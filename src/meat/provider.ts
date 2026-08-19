// Model resolution and backend dispatch (specs/providers.md G1-G2), plus
// `NewModelFromEnv` (G17 — routes through either provider constructor,
// deferred here from item 4b since both `anthropic.ts`/`openai.ts` needed
// to exist first; item 4p, the later of the two, lands it).

import { NewAnthropicFromEnv } from "./anthropic.ts";
import { NewOpenAIFromEnv, NewGrokFromEnv, DefaultOpenAIModel, DefaultGrokModel } from "./openai.ts";
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

function envNonEmpty(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== "";
}

/**
 * Built-in default when neither `-model` nor `$MEAT_MODEL` is set. OpenAI's
 * default stays the built-in unless the process has xAI credentials and no
 * OpenAI credentials — then `meat` with only `XAI_API_KEY` uses Grok, and
 * the cache key matches the model that will actually run.
 *
 * Env reads only; no network. Empty string and unset are the same (matches
 * Go's `os.Getenv`).
 */
export function defaultModelForEnv(): string {
  if (!envNonEmpty("OPENAI_API_KEY") && !envNonEmpty("OPENAI_BASE_URL") && (envNonEmpty("XAI_API_KEY") || envNonEmpty("XAI_BASE_URL"))) {
    return DefaultGrokModel;
  }
  return DefaultModel();
}

/**
 * The CLI model fallback chain: an explicit value wins outright; otherwise
 * `$MEAT_MODEL`; otherwise `defaultModelForEnv()`. No network, so callers
 * can resolve the cache identity cheaply and offline.
 */
export function ResolveModel(model: string): string {
  return resolveModel(model, defaultModelForEnv());
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
 * After stripping one optional leading `"xai/"`, an id starting with
 * `"grok-"` dispatches to the xAI backend. Same TrimPrefix-once rule as
 * `isAnthropicModel`.
 */
export function isGrokModel(model: string): boolean {
  const stripped = model.startsWith("xai/") ? model.slice("xai/".length) : model;
  return stripped.startsWith("grok-");
}

/**
 * Constructs the built-in backend appropriate for `model` — Claude ids to
 * Anthropic Messages, Grok ids to xAI's OpenAI-compatible Responses API,
 * every other id to OpenAI Responses.
 */
export async function NewModelFromEnv(signal: AbortSignal, model: string): Promise<Model> {
  const resolved = ResolveModel(model);
  if (isAnthropicModel(resolved)) {
    return NewAnthropicFromEnv(signal, resolved);
  }
  if (isGrokModel(resolved)) {
    return NewGrokFromEnv(signal, resolved);
  }
  return NewOpenAIFromEnv(signal, resolved);
}
