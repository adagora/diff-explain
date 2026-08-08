// exe.dev managed-gateway discovery — both provider constructors' last-resort
// credential fallback when no explicit API key/base URL is configured
// (specs/providers.md "exe.dev managed gateway discovery"). Every failure
// path, of any kind, converges on "" with no side channel: the marker stat,
// the network round trip, the status check, and the JSON decode can each
// fail independently, and the caller sees only "not available."

import { stat } from "node:fs/promises";

/**
 * The two module-level values `gateway.go` keeps as overridable `var`s so
 * its tests can point them at a temp path / stub server without touching
 * process state. A plain exported `const` object with mutable fields is the
 * port's equivalent seam: an `export let` binding cannot be reassigned from
 * an importing test module (ES module live bindings are read-only outside
 * their own module), but its properties can.
 */
export const gatewayConfig = {
  exeDevMarkerPath: "/exe.dev",
  reflectionIntegrationsURL: "https://reflection.int.exe.xyz/integrations",
};

/**
 * Stands in for Go's `*http.Client` parameter. `fetch` has no persistent
 * client object to pass instead, so this carries just the one thing that
 * parameter actually varies: the client-level timeout (`meat/gateway.go:33`,
 * 5s when the caller passes `nil`). Both current call sites pass nothing,
 * so `timeoutMs` defaults to 5000 in practice; the parameter exists so a
 * future caller can override it exactly as a caller-supplied `*http.Client`
 * would in Go.
 */
export interface GatewayHttpClientOpts {
  readonly timeoutMs?: number;
}

interface GatewayIntegration {
  readonly name: string;
  readonly type: string;
  readonly team: boolean;
}

/**
 * Validates and normalizes the decoded JSON body into the shape
 * `discoverExeGatewayBase` scans, or returns `null` on any structural
 * mismatch. Go's `json.Decoder.Decode` returns a non-nil error — treated by
 * the caller as total decode failure — not just on malformed JSON syntax
 * but also when a known field's value doesn't match its struct type (e.g.
 * `"name"` is a number). This mirrors that: a present-but-wrong-typed field
 * fails the whole decode rather than silently coercing. An absent
 * `"integrations"` key decodes as Go's zero value, an empty (nil) slice, not
 * a failure — reflected in `null` only for genuine shape mismatches.
 */
function parseIntegrations(raw: unknown): readonly GatewayIntegration[] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const topLevel = raw as Record<string, unknown>;
  const rawIntegrations = topLevel["integrations"];
  if (rawIntegrations === undefined) return [];
  if (!Array.isArray(rawIntegrations)) return null;

  const integrations: GatewayIntegration[] = [];
  for (const entry of rawIntegrations) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const rec = entry as Record<string, unknown>;
    const name = rec["name"];
    const type = rec["type"];
    const team = rec["team"];
    if (name !== undefined && typeof name !== "string") return null;
    if (type !== undefined && typeof type !== "string") return null;
    if (team !== undefined && typeof team !== "boolean") return null;
    integrations.push({
      name: name ?? "",
      type: type ?? "",
      // Absent "team" (H15): undefined must read identically to Go's zero value `false`.
      team: team === true,
    });
  }
  return integrations;
}

/**
 * Go's `discoverExeGatewayBase` (`meat/gateway.go:28-73`). Returns the bare
 * origin of the exe.dev managed LLM gateway for this VM (e.g.
 * `"https://llm.int.exe.xyz"`), or `""` if we are not on an exe.dev VM or no
 * `"llm"` integration is attached. Never throws — every failure mode
 * (missing marker, transport failure, non-200, undecodable body, no
 * matching integration) returns `""`.
 */
export async function discoverExeGatewayBase(
  signal: AbortSignal,
  httpClientOpts?: GatewayHttpClientOpts,
): Promise<string> {
  try {
    await stat(gatewayConfig.exeDevMarkerPath);
  } catch {
    return "";
  }

  // Two independent 5s timeouts (H6): the client-level one (overridable via
  // httpClientOpts, defaulting to 5s exactly as a nil *http.Client would),
  // and a second, always-5s one standing in for context.WithTimeout composed
  // with the caller's own signal. Either alone is not equivalent.
  const clientTimeoutMs = httpClientOpts?.timeoutMs ?? 5_000;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000), AbortSignal.timeout(clientTimeoutMs)]);

  let response: Response;
  try {
    response = await fetch(gatewayConfig.reflectionIntegrationsURL, {
      method: "GET",
      signal: requestSignal,
    });
  } catch {
    return "";
  }
  if (response.status !== 200) {
    return "";
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return "";
  }
  const integrations = parseIntegrations(raw);
  if (integrations === null) return "";

  for (const integration of integrations) {
    if (integration.type !== "llm" || integration.name === "") continue;
    const host =
      integration.team === true ? `${integration.name}.team.exe.xyz` : `${integration.name}.int.exe.xyz`;
    return `https://${host}`;
  }
  return "";
}
