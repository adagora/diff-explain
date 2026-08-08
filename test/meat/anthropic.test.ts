// Port of meat/anthropic_test.go (TestAbridge_AnthropicEditPlanEndToEnd,
// TestGenerate_RetriesTransient, TestGenerate_NoRetryOnBadRequest,
// TestGenerate_GivesUpAfterMaxAttempts, TestGenerate_MaxTokensStopIsAnError,
// TestGenerate_SendsMaxOutputTokens) and the three Anthropic-specific
// credential-resolution tests from meat/gateway_test.go
// (TestNewAnthropicFromEnv_PrefersExplicitKey/FallsBackToGateway/
// NoCredentials — the gateway-discovery-only tests in that Go file are
// ported in gateway.test.ts, item 4c). Plus direct tests (no Go precedent,
// this codebase's established convention for new port-only mechanisms) for
// the raw-JSON-value preservation this file had to newly solve (H4): Go's
// json.RawMessage has no JS equivalent, so `tool_use.input` is captured and
// replayed by scanning bracket/quote nesting in the original text rather
// than JSON.parse/JSON.stringify, which would silently reformat it.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import {
  type AnthropicModel,
  DefaultAnthropicModel,
  maxAttempts,
  maxOutputTokens,
  newAnthropicModel,
  NewAnthropicFromEnv,
  retryConfig,
} from "../../src/meat/anthropic.ts";
import { RoleUser, textBlock, type Message, type ToolUseBlock, type ToolResultBlock } from "../../src/meat/model.ts";
import { Abridge } from "../../src/meat/meat.ts";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { gatewayConfig } from "../../src/meat/gateway.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const s = (text: string): Uint8Array => encodeUTF8(text);
const d = (b: Uint8Array): string => decodeUTF8(b);

// ---------------------------------------------------------------------------
// Test infrastructure — Go's `antServer`/`okBody` (meat/anthropic_test.go:16-42).
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

interface AntTestServer {
  model: AnthropicModel;
  calls: () => number;
  close: () => Promise<void>;
}

/**
 * Go's `antServer` (`meat/anthropic_test.go:16-33`): a real local HTTP
 * server (not an interface fake — `specs/test-infrastructure.md`'s explicit
 * requirement), with a live call counter the handler closure can branch on.
 * `clientTimeoutMs: 0` mirrors `srv.Client()`'s zero-value `Timeout` (no
 * client-level cap), so the model's own defaulting logic for that field is
 * never exercised by any test built on this harness — matching Go's own
 * framing of what this harness does and doesn't cover.
 */
async function antServer(handler: (req: IncomingMessage, res: ServerResponse, callNumber: number) => void): Promise<AntTestServer> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    calls++;
    handler(req, res, calls);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
  const model = newAnthropicModel({ apiKey: "test-key", baseURL: `http://127.0.0.1:${address.port}`, clientTimeoutMs: 0 });
  return {
    model,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Go's `okBody` (`meat/anthropic_test.go:35-42`). */
function okBody(stopReason: string): unknown {
  return {
    content: [{ type: "text", text: "hi" }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const originalBaseDelayMs = retryConfig.baseDelayMs;
afterEach(() => {
  retryConfig.baseDelayMs = originalBaseDelayMs;
});

// ---------------------------------------------------------------------------
// Guarantees (meat/anthropic_test.go)
// ---------------------------------------------------------------------------

describe("AnthropicModel.generate (meat/anthropic_test.go)", () => {
  test("a full plan-correction exchange round-trips through the real Messages wire shape (G10, TestAbridge_AnthropicEditPlanEndToEnd)", async () => {
    retryConfig.baseDelayMs = 1;
    const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n";

    const srv = await antServer((req, res, call) => {
      void readBody(req).then((bodyText) => {
        const parsed = JSON.parse(bodyText) as {
          system: string;
          tools: { name: string; input_schema: unknown }[];
          messages: { content: { type: string; text?: string; is_error?: boolean; content?: string }[] }[];
        };
        assert.ok(parsed.system.includes("edit plan"), "system prompt does not describe edit plans");
        assert.equal(parsed.tools.length, 2);
        assert.equal(parsed.tools[0]?.name, "preview_plan");
        assert.equal(parsed.tools[1]?.name, "submit");
        const schemaText = JSON.stringify(parsed.tools[1]?.input_schema);
        assert.ok(!schemaText.includes("smart_diff"), "submit schema leaks smart_diff");
        assert.ok(schemaText.includes('"fold"'), "submit schema missing fold");
        const firstText = parsed.messages[0]?.content[0]?.text ?? "";
        assert.ok(firstText.includes("1|diff --git"), "user prompt is not line-numbered");

        if (call === 2) {
          let sawError = false;
          for (const msg of parsed.messages) {
            for (const block of msg.content) {
              if (block.type === "tool_result" && block.is_error === true && (block.content ?? "").includes("outside the diff")) {
                sawError = true;
              }
            }
          }
          assert.ok(sawError, "second request did not contain invalid-plan tool result");
        }

        const input =
          call === 2
            ? { remove: [{ start_line: 3, end_line: 3 }], replace: [{ line: 4, old: "new", new: "n..." }], fold: [], summary: "Changes the value." }
            : { remove: [], replace: [{ line: 99, old: "new", new: "..." }], fold: [], summary: "Changes the value." };

        sendJSON(res, 200, {
          content: [{ type: "tool_use", id: "submit-plan", name: "submit", input }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      });
    });
    try {
      const result = await Abridge(new AbortController().signal, srv.model, { unifiedDiff: s(diff) });
      assert.equal(srv.calls(), 2, "HTTP model calls, want invalid plan plus corrected plan");
      const smartDiff = d(result.smartDiff);
      assert.ok(!smartDiff.includes("-old"));
      assert.ok(smartDiff.includes("+n..."));
    } finally {
      await srv.close();
    }
  });

  test("a 429 then a 529 are retried with backoff; the third attempt's 200 succeeds (G11, TestGenerate_RetriesTransient)", async () => {
    retryConfig.baseDelayMs = 1;
    const srv = await antServer((_req, res, call) => {
      if (call === 1) {
        sendJSON(res, 429, { error: { type: "rate_limit_error", message: "slow down" } });
      } else if (call === 2) {
        sendJSON(res, 529, { error: { type: "overloaded_error", message: "overloaded" } });
      } else {
        sendJSON(res, 200, okBody("end_turn"));
      }
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("x")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(srv.calls(), 3, "attempts, want 3 (two retries then success)");
      assert.equal(resp.content.length, 1);
      const first = resp.content[0];
      assert.ok(first !== undefined && first.type === "text" && first.text === "hi");
    } finally {
      await srv.close();
    }
  });

  test("a 400 is never retried (G12, TestGenerate_NoRetryOnBadRequest)", async () => {
    const srv = await antServer((_req, res) => {
      sendJSON(res, 400, { error: { type: "invalid_request_error", message: "too large" } });
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("x")] }];
      await assert.rejects(() => srv.model.generate(new AbortController().signal, "sys", messages, []));
      assert.equal(srv.calls(), 1, "attempts, want 1 (no retry on 4xx)");
    } finally {
      await srv.close();
    }
  });

  test("persistent 500s exhaust maxAttempts and return an error wrapping the last failure (G13, TestGenerate_GivesUpAfterMaxAttempts)", async () => {
    retryConfig.baseDelayMs = 1;
    const srv = await antServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("x")] }];
      await assert.rejects(() => srv.model.generate(new AbortController().signal, "sys", messages, []));
      assert.equal(srv.calls(), maxAttempts);
    } finally {
      await srv.close();
    }
  });

  test("stop_reason max_tokens on an HTTP 200 is a hard error (G14, TestGenerate_MaxTokensStopIsAnError)", async () => {
    const srv = await antServer((_req, res) => {
      sendJSON(res, 200, okBody("max_tokens"));
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("x")] }];
      await assert.rejects(
        () => srv.model.generate(new AbortController().signal, "sys", messages, []),
        /max_tokens/,
      );
    } finally {
      await srv.close();
    }
  });

  test("every request asks for exactly maxOutputTokens (G15, TestGenerate_SendsMaxOutputTokens)", async () => {
    let gotMax = -1;
    const srv = await antServer((req, res) => {
      void readBody(req).then((bodyText) => {
        gotMax = (JSON.parse(bodyText) as { max_tokens: number }).max_tokens;
        sendJSON(res, 200, okBody("end_turn"));
      });
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("x")] }];
      await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(gotMax, maxOutputTokens);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Credential resolution (meat/gateway_test.go's TestNewAnthropicFromEnv_*, G7-G9)
// ---------------------------------------------------------------------------

async function withMarker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "meat-anthropic-"));
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

describe("NewAnthropicFromEnv (meat/gateway_test.go, G7-G9)", () => {
  const originalMarkerPath = gatewayConfig.exeDevMarkerPath;
  const originalReflectionURL = gatewayConfig.reflectionIntegrationsURL;
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];
  const originalBaseURL = process.env["ANTHROPIC_BASE_URL"];
  const originalMeatModel = process.env["MEAT_MODEL"];

  afterEach(() => {
    gatewayConfig.exeDevMarkerPath = originalMarkerPath;
    gatewayConfig.reflectionIntegrationsURL = originalReflectionURL;
    if (originalApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    if (originalBaseURL === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = originalBaseURL;
    if (originalMeatModel === undefined) delete process.env["MEAT_MODEL"];
    else process.env["MEAT_MODEL"] = originalMeatModel;
  });

  test("an explicit ANTHROPIC_API_KEY wins outright over gateway discovery, even with a matching llm integration present (G7)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-explicit";
    delete process.env["ANTHROPIC_BASE_URL"];
    const markerPath = await withMarker();
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "llm", type: "llm" }] }));
    gatewayConfig.reflectionIntegrationsURL = url;
    try {
      const m = await NewAnthropicFromEnv(new AbortController().signal, "");
      assert.equal(m.apiKey, "sk-explicit");
      assert.equal(m.baseURL, "");
      assert.equal(m.model, DefaultAnthropicModel);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("no explicit credential falls back to the discovered exe.dev gateway (G8)", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["MEAT_MODEL"];
    const markerPath = await withMarker();
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "llm", type: "llm" }] }));
    gatewayConfig.reflectionIntegrationsURL = url;
    try {
      const m = await NewAnthropicFromEnv(new AbortController().signal, "");
      assert.equal(m.apiKey, "implicit");
      assert.equal(m.baseURL, "https://llm.int.exe.xyz/anthropic");
      assert.equal(m.model, DefaultAnthropicModel);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("no explicit credential and no gateway marker throws (G9)", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_BASE_URL"];
    gatewayConfig.exeDevMarkerPath = join(await mkdtemp(join(tmpdir(), "meat-anthropic-")), "nope");
    await assert.rejects(() => NewAnthropicFromEnv(new AbortController().signal, ""));
  });
});

// ---------------------------------------------------------------------------
// Direct tests, no Go precedent: raw-JSON-value preservation (H4). Go's
// json.RawMessage has no JS equivalent, so this file's incoming/outgoing
// scanning is new port-only machinery that needs its own coverage.
// ---------------------------------------------------------------------------

describe("raw tool_use.input preservation (H4, no Go precedent)", () => {
  test("a value that JSON.parse/JSON.stringify would reformat survives the incoming decode byte-for-byte", async () => {
    // 1.50 -> JSON.parse/stringify would normalize to 1.5; a 17-digit
    // integer -> JSON.parse/stringify loses precision past 2^53. Both
    // survive only if the response is never round-tripped as a whole.
    const rawInput = '{"start_line":1.50,"note":"a\\nb","big":123456789012345678}';
    const srv = await antServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        `{"content":[{"type":"tool_use","id":"t1","name":"submit","input":${rawInput}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1}}`,
      );
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("x")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(resp.content.length, 1);
      const block = resp.content[0];
      assert.ok(block !== undefined && block.type === "tool_use");
      assert.equal(d((block as ToolUseBlock).toolInput), rawInput);
    } finally {
      await srv.close();
    }
  });

  test("a replayed tool_use block's raw input is spliced verbatim into the outgoing request, never re-parsed", async () => {
    const rawInput = '{"weird":  1.500,"dup":1,"dup":2}';
    let capturedBody = "";
    const srv = await antServer((req, res) => {
      void readBody(req).then((bodyText) => {
        capturedBody = bodyText;
        sendJSON(res, 200, okBody("end_turn"));
      });
    });
    try {
      const toolUse: ToolUseBlock = { type: "tool_use", id: "t1", toolName: "submit", toolInput: s(rawInput) };
      const messages: Message[] = [{ role: RoleUser, content: [toolUse] }];
      await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.ok(capturedBody.includes(`"input":${rawInput}`), `request body did not splice raw input verbatim:\n${capturedBody}`);
    } finally {
      await srv.close();
    }
  });

  test("a message whose only block is an unrecognized type marshals content as null, not [] (H9)", async () => {
    let capturedBody = "";
    const srv = await antServer((req, res) => {
      void readBody(req).then((bodyText) => {
        capturedBody = bodyText;
        sendJSON(res, 200, okBody("end_turn"));
      });
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [{ type: "provider_state", providerData: s("{}") }] }];
      await srv.model.generate(new AbortController().signal, "sys", messages, []);
      const parsed = JSON.parse(capturedBody) as { messages: { content: unknown }[] };
      assert.equal(parsed.messages[0]?.content, null);
    } finally {
      await srv.close();
    }
  });

  test("a non-error tool_result never sends is_error:false, only true or nothing", async () => {
    let capturedBody = "";
    const srv = await antServer((req, res) => {
      void readBody(req).then((bodyText) => {
        capturedBody = bodyText;
        sendJSON(res, 200, okBody("end_turn"));
      });
    });
    try {
      const toolResult: ToolResultBlock = { type: "tool_result", toolUseId: "t1", toolResult: "ok", toolError: false };
      const messages: Message[] = [{ role: RoleUser, content: [toolResult] }];
      await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.ok(!capturedBody.includes("is_error"), `is_error key present for a non-error result:\n${capturedBody}`);
    } finally {
      await srv.close();
    }
  });
});
