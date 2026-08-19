import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { ResolveModel, resolveModel, isAnthropicModel, isGrokModel, DefaultModel, NewModelFromEnv } from "../../src/meat/provider.ts";
import { DefaultGrokModel, DefaultXAIBaseURL } from "../../src/meat/openai.ts";
import { gatewayConfig } from "../../src/meat/gateway.ts";

const resolveEnvKeys = ["MEAT_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "XAI_API_KEY", "XAI_BASE_URL"] as const;

function snapshotEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((k) => [k, process.env[k]]));
}

function restoreEnvMap(original: Map<string, string | undefined>): void {
  for (const [k, v] of original) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearEnv(keys: readonly string[]): void {
  for (const k of keys) delete process.env[k];
}

// Ported from meat/resolvemodel_test.go — pins the precedence the cache key
// depends on: explicit wins, then $MEAT_MODEL, then the built-in default
// (OpenAI, or Grok when only xAI credentials are set).
describe("ResolveModel", () => {
  const original = snapshotEnv(resolveEnvKeys);

  afterEach(() => restoreEnvMap(original));

  test("explicit wins over env", () => {
    process.env["MEAT_MODEL"] = "env-model";
    assert.equal(ResolveModel("explicit"), "explicit");
  });

  test("env used when no explicit", () => {
    process.env["MEAT_MODEL"] = "env-model";
    assert.equal(ResolveModel(""), "env-model");
  });

  test("default when nothing set is the OpenAI built-in", () => {
    clearEnv(resolveEnvKeys);
    assert.equal(ResolveModel(""), DefaultModel());
  });

  test("XAI_API_KEY alone defaults to grok-4.6 so the cache key matches the model that will run", () => {
    clearEnv(resolveEnvKeys);
    process.env["XAI_API_KEY"] = "xai-only";
    assert.equal(ResolveModel(""), "grok-4.6");
    assert.equal(ResolveModel(""), DefaultGrokModel);
  });

  test("XAI_BASE_URL alone also selects the Grok default", () => {
    clearEnv(resolveEnvKeys);
    process.env["XAI_BASE_URL"] = "https://proxy.example/v1";
    assert.equal(ResolveModel(""), "grok-4.6");
  });

  test("OPENAI_API_KEY wins the default over XAI_API_KEY", () => {
    clearEnv(resolveEnvKeys);
    process.env["OPENAI_API_KEY"] = "sk-openai";
    process.env["XAI_API_KEY"] = "xai-also";
    assert.equal(ResolveModel(""), DefaultModel());
  });

  test("explicit grok-4.6 wins even when OpenAI credentials are set", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    process.env["MEAT_MODEL"] = "env-model";
    assert.equal(ResolveModel("grok-4.6"), "grok-4.6");
  });
});

describe("resolveModel (two-argument core)", () => {
  test("explicit model wins regardless of fallback", () => {
    assert.equal(resolveModel("explicit", "fallback"), "explicit");
  });
  test("falls back to the given fallback, not DefaultModel, when env is unset", () => {
    delete process.env["MEAT_MODEL"];
    assert.equal(resolveModel("", "some-fallback"), "some-fallback");
  });
});

describe("isAnthropicModel", () => {
  test("claude- prefixed ids are Anthropic", () => {
    assert.ok(isAnthropicModel("claude-sonnet-4-6"));
  });
  test("anthropic/ prefix is stripped before the claude- check", () => {
    assert.ok(isAnthropicModel("anthropic/claude-sonnet-4-6"));
  });
  test("non-claude ids are not Anthropic", () => {
    assert.ok(!isAnthropicModel("gpt-5.6-sol"));
  });
  test("anthropic/ prefix alone, without claude-, is not Anthropic", () => {
    assert.ok(!isAnthropicModel("anthropic/some-other-model"));
  });
  test("empty model id is not Anthropic", () => {
    assert.ok(!isAnthropicModel(""));
  });
  test("does not mutate or truncate an id that legitimately starts with claude- twice", () => {
    // Only one leading "anthropic/" is stripped, matching strings.TrimPrefix
    // (which removes at most one occurrence).
    assert.ok(!isAnthropicModel("anthropic/anthropic/claude-x"));
  });
});

describe("isGrokModel", () => {
  test("grok- prefixed ids are Grok", () => {
    assert.ok(isGrokModel("grok-4.6"));
    assert.ok(isGrokModel("grok-4.5"));
    assert.ok(isGrokModel("grok-code-fast-1"));
  });
  test("xai/ prefix is stripped before the grok- check", () => {
    assert.ok(isGrokModel("xai/grok-4.6"));
  });
  test("non-grok ids are not Grok", () => {
    assert.ok(!isGrokModel("gpt-5.6-sol"));
    assert.ok(!isGrokModel("claude-sonnet-4-6"));
    assert.ok(!isGrokModel("grok"));
  });
  test("xai/ prefix alone, without grok-, is not Grok", () => {
    assert.ok(!isGrokModel("xai/some-other-model"));
  });
  test("empty model id is not Grok", () => {
    assert.ok(!isGrokModel(""));
  });
  test("strips at most one leading xai/ prefix", () => {
    assert.ok(!isGrokModel("xai/xai/grok-4.6"));
  });
});

// Ported from meat/gateway_test.go's TestNewModelFromEnv_* (G17) — these two
// specifically exercise NewModelFromEnv's dispatch, not gateway discovery
// itself (already covered in gateway.test.ts, item 4c).
describe("NewModelFromEnv (meat/gateway_test.go, G17)", () => {
  const originalMarkerPath = gatewayConfig.exeDevMarkerPath;
  const originalReflectionURL = gatewayConfig.reflectionIntegrationsURL;
  const envKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "MEAT_MODEL", "XAI_API_KEY", "XAI_BASE_URL"] as const;
  const originalEnv = new Map(envKeys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    gatewayConfig.exeDevMarkerPath = originalMarkerPath;
    gatewayConfig.reflectionIntegrationsURL = originalReflectionURL;
    for (const k of envKeys) {
      const v = originalEnv.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function withMarker(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "meat-provider-"));
    const markerPath = join(dir, "exe.dev");
    await writeFile(markerPath, "x");
    return markerPath;
  }

  function startReflectionServer(body: string): Promise<{ server: Server; url: string }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
        resolve({ server, url: `http://127.0.0.1:${address.port}` });
      });
    });
  }

  test("no credentials at all routes the default OpenAI backend through the exe.dev gateway", async () => {
    for (const k of envKeys) delete process.env[k];
    const markerPath = await withMarker();
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "llm", type: "llm" }] }));
    gatewayConfig.reflectionIntegrationsURL = url;
    try {
      const model = await NewModelFromEnv(new AbortController().signal, "");
      const m = model as unknown as { model: string; baseURL: string; reasoningEffort: string };
      assert.equal(m.model, "gpt-5.6-sol");
      assert.equal(m.baseURL, "https://llm.int.exe.xyz/openai");
      assert.equal(m.reasoningEffort, "medium");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a claude- model id dispatches to Anthropic", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-anthropic";
    delete process.env["ANTHROPIC_BASE_URL"];
    const model = await NewModelFromEnv(new AbortController().signal, "claude-sonnet-4-6");
    const m = model as unknown as { model: string; apiKey: string };
    assert.equal(m.model, "claude-sonnet-4-6");
    assert.equal(m.apiKey, "sk-anthropic");
  });

  test("a grok- model id dispatches to xAI with the default api.x.ai/v1 base", async () => {
    process.env["XAI_API_KEY"] = "xai-explicit";
    delete process.env["XAI_BASE_URL"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    const model = await NewModelFromEnv(new AbortController().signal, "grok-4.6");
    const m = model as unknown as { model: string; apiKey: string; baseURL: string; reasoningEffort: string };
    assert.equal(m.model, "grok-4.6");
    assert.equal(m.apiKey, "xai-explicit");
    assert.equal(m.baseURL, DefaultXAIBaseURL);
    assert.equal(m.baseURL, "https://api.x.ai/v1");
    assert.equal(m.reasoningEffort, "medium");
  });

  test("xai/grok-4.6 is classified as Grok and the stored id drops the xai/ prefix", async () => {
    process.env["XAI_API_KEY"] = "xai-explicit";
    delete process.env["XAI_BASE_URL"];
    const model = await NewModelFromEnv(new AbortController().signal, "xai/grok-4.6");
    const m = model as unknown as { model: string };
    assert.equal(m.model, "grok-4.6");
  });

  test("a grok- id does not fall through to OPENAI_API_KEY", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    delete process.env["XAI_API_KEY"];
    delete process.env["XAI_BASE_URL"];
    await assert.rejects(() => NewModelFromEnv(new AbortController().signal, "grok-4.6"), /XAI_API_KEY/);
  });
});
