// Port of meat/openai_test.go (TestAbridge_OpenAIEditPlanEndToEndPreservesReasoning,
// TestOpenAIGenerate_StreamingText, TestOpenAIGenerate_IncompleteIsError,
// TestOpenAIResponsesURL) and the two OpenAI-specific credential-resolution
// tests from meat/gateway_test.go (TestNewOpenAIFromEnv_PrefersExplicitKey/
// NoCredentials — the gateway-discovery-only tests stay in gateway.test.ts,
// item 4c, and the two NewModelFromEnv tests moved to provider.test.ts,
// item 4p's own "follow-up owed to item 4b"). Plus direct tests (no Go
// precedent) for the SSE mechanics this port had to build from scratch:
// H4's raw-item preservation through a stream, H12's 16 MiB line cap, and
// H13's explicit-sort-over-Map-insertion-order contract.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenAIModel,
  DefaultOpenAIModel,
  DefaultReasoningEffort,
  maxOpenAIOutputTokens,
  newOpenAIModel,
  NewOpenAIFromEnv,
  toOpenAIInput,
  openAIResponsesURL,
} from "../../src/meat/openai.ts";
import { retryConfig } from "../../src/meat/anthropic.ts";
import { RoleUser, RoleAssistant, textBlock, type Message, type ToolUseBlock, type ProviderStateBlock } from "../../src/meat/model.ts";
import { Abridge } from "../../src/meat/meat.ts";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { gatewayConfig } from "../../src/meat/gateway.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);
const d = (b: Uint8Array): string => decodeUTF8(b);

// ---------------------------------------------------------------------------
// Test infrastructure — Go's `writeOpenAIEvent`/`openAICompleted`/
// `outputItemDone` (meat/openai_test.go:14-43).
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeSSEEvent(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function openAICompleted(id: string, inputTokens: number, outputTokens: number): unknown {
  return {
    type: "response.completed",
    response: { id, status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  };
}

function outputItemDone(index: number, item: unknown): unknown {
  return { type: "response.output_item.done", output_index: index, item };
}

interface OAITestServer {
  model: OpenAIModel;
  requests: () => IncomingMessage[];
  close: () => Promise<void>;
}

async function oaiServer(handler: (req: IncomingMessage, res: ServerResponse, callNumber: number) => void): Promise<OAITestServer> {
  let calls = 0;
  const requests: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    calls++;
    requests.push(req);
    handler(req, res, calls);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
  const model = newOpenAIModel({ apiKey: "test-key", baseURL: `http://127.0.0.1:${address.port}`, clientTimeoutMs: 0 });
  return { model, requests: () => requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const originalBaseDelayMs = retryConfig.baseDelayMs;
afterEach(() => {
  retryConfig.baseDelayMs = originalBaseDelayMs;
});

// ---------------------------------------------------------------------------
// Guarantees (meat/openai_test.go)
// ---------------------------------------------------------------------------

describe("OpenAIModel.generate (meat/openai_test.go)", () => {
  test("a full plan-correction exchange preserves reasoning/function-call replay across turns (G19-G23, TestAbridge_OpenAIEditPlanEndToEndPreservesReasoning)", async () => {
    const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n";
    const srv = await oaiServer((req, res, call) => {
      void readBody(req).then((bodyText) => {
        assert.equal(req.url, "/v1/responses");
        assert.equal(req.headers["authorization"], "Bearer test-key");
        const parsed = JSON.parse(bodyText) as {
          model: string;
          reasoning: { effort: string };
          stream: boolean;
          store: boolean;
          max_output_tokens: number;
          include: string[];
          instructions: string;
          tools: { type: string; name: string }[];
          input: unknown[];
        };
        assert.equal(parsed.model, DefaultOpenAIModel);
        assert.equal(parsed.reasoning.effort, DefaultReasoningEffort);
        assert.equal(parsed.stream, true);
        assert.equal(parsed.store, false);
        assert.equal(parsed.max_output_tokens, maxOpenAIOutputTokens);
        assert.deepEqual(parsed.include, ["reasoning.encrypted_content"]);
        assert.ok(parsed.instructions.includes("edit plan"));
        assert.equal(parsed.tools.length, 2);
        assert.equal(parsed.tools[0]?.type, "function");
        assert.equal(parsed.tools[0]?.name, "preview_plan");
        assert.equal(parsed.tools[1]?.name, "submit");

        if (call === 1) {
          assert.equal(parsed.input.length, 1);
          assert.ok(JSON.stringify(parsed.input[0]).includes("1|diff --git"));
        } else if (call === 2) {
          assert.equal(parsed.input.length, 4, `second input has ${parsed.input.length} items, want user + reasoning + call + output`);
          const reasoning = parsed.input[1] as Record<string, unknown>;
          const functionCall = parsed.input[2] as Record<string, unknown>;
          const functionOutput = parsed.input[3] as Record<string, unknown>;
          assert.equal(reasoning["type"], "reasoning");
          assert.equal(reasoning["encrypted_content"], "encrypted-turn-1");
          assert.equal(reasoning["id"], "rs_1");
          assert.equal(functionCall["type"], "function_call");
          assert.equal(functionCall["call_id"], "call_1");
          assert.equal(functionCall["id"], "fc_1");
          assert.equal(functionOutput["type"], "function_call_output");
          assert.equal(functionOutput["call_id"], "call_1");
          assert.ok(String(functionOutput["output"]).includes("outside the diff"));
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
          writeSSEEvent(res, outputItemDone(0, { id: "rs_1", type: "reasoning", encrypted_content: "encrypted-turn-1", summary: [] }));
          writeSSEEvent(
            res,
            outputItemDone(1, {
              id: "fc_1",
              type: "function_call",
              status: "completed",
              call_id: "call_1",
              name: "submit",
              arguments: JSON.stringify({ remove: [], replace: [{ line: 99, old: "new", new: "..." }], fold: [], summary: "Changes the value." }),
            }),
          );
          writeSSEEvent(res, openAICompleted("resp_1", 10, 5));
          res.end();
          return;
        }
        writeSSEEvent(
          res,
          outputItemDone(0, {
            id: "fc_2",
            type: "function_call",
            status: "completed",
            call_id: "call_2",
            name: "submit",
            arguments: JSON.stringify({
              remove: [{ start_line: 3, end_line: 3 }],
              replace: [{ line: 4, old: "new", new: "n..." }],
              fold: [],
              summary: "Changes the value.",
            }),
          }),
        );
        writeSSEEvent(res, openAICompleted("resp_2", 10, 5));
        res.end();
      });
    });
    try {
      const result = await Abridge(new AbortController().signal, srv.model, { unifiedDiff: s(diff) });
      assert.equal(srv.requests().length, 2, "HTTP model calls, want invalid plan plus corrected plan");
      const smartDiff = d(result.smartDiff);
      assert.ok(!smartDiff.includes("-old"));
      assert.ok(smartDiff.includes("+n..."));
      assert.equal(result.inputTokens, 20);
      assert.equal(result.outputTokens, 10);
    } finally {
      await srv.close();
    }
  });

  test("streamed text is reassembled from output_item.done events and the message item is preserved as provider state (G22-G23, TestOpenAIGenerate_StreamingText)", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSSEEvent(
        res,
        outputItemDone(0, { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "hello" }] }),
      );
      writeSSEEvent(res, openAICompleted("resp_text", 7, 3));
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(resp.content.length, 1);
      const block = resp.content[0];
      assert.ok(block !== undefined && block.type === "text" && block.text === "hello");
      assert.equal((block as { provider?: string }).provider, "openai");
      assert.ok(d((block as { providerData: Uint8Array }).providerData).includes('"id":"msg_1"'));
    } finally {
      await srv.close();
    }
  });

  test("a response.incomplete event is a hard error naming the truncation reason (G, TestOpenAIGenerate_IncompleteIsError)", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSSEEvent(res, {
        type: "response.incomplete",
        response: { id: "resp_cut", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } },
      });
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      await assert.rejects(() => srv.model.generate(new AbortController().signal, "sys", messages, []), /max_output_tokens/);
    } finally {
      await srv.close();
    }
  });
});

describe("openAIResponsesURL (meat/openai_test.go:219-228, TestOpenAIResponsesURL)", () => {
  test("appends /v1/responses, or /responses when the base already ends in /v1", () => {
    const cases: [string, string][] = [
      ["https://api.openai.com", "https://api.openai.com/v1/responses"],
      ["https://proxy.example/v1/", "https://proxy.example/v1/responses"],
    ];
    for (const [base, want] of cases) {
      assert.equal(openAIResponsesURL(base), want, `openAIResponsesURL(${JSON.stringify(base)})`);
    }
  });

  test("the actual request path matches openAIResponsesURL's contract, end to end", async () => {
    const srv = await oaiServer((req, res) => {
      assert.equal(req.url, "/v1/responses");
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSSEEvent(res, openAICompleted("r", 0, 0));
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      await srv.model.generate(new AbortController().signal, "sys", messages, []);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Credential resolution (meat/gateway_test.go's TestNewOpenAIFromEnv_*, G16/G18)
// ---------------------------------------------------------------------------

async function withMarker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "meat-openai-"));
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

describe("NewOpenAIFromEnv (meat/gateway_test.go, G16/G18)", () => {
  const originalMarkerPath = gatewayConfig.exeDevMarkerPath;
  const originalReflectionURL = gatewayConfig.reflectionIntegrationsURL;
  const envKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MEAT_MODEL"] as const;
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

  test("an explicit OPENAI_API_KEY wins outright, gateway discovery unused (G16)", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-explicit";
    delete process.env["OPENAI_BASE_URL"];
    process.env["MEAT_MODEL"] = "";
    const markerPath = await withMarker();
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "llm", type: "llm" }] }));
    gatewayConfig.reflectionIntegrationsURL = url;
    try {
      const m = await NewOpenAIFromEnv(new AbortController().signal, "");
      assert.equal(m.apiKey, "sk-openai-explicit");
      assert.equal(m.baseURL, "");
      assert.equal(m.model, DefaultOpenAIModel);
      assert.equal(m.reasoningEffort, DefaultReasoningEffort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("no explicit credential and no gateway marker throws (G18)", async () => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    gatewayConfig.exeDevMarkerPath = join(await mkdtemp(join(tmpdir(), "meat-openai-")), "nope");
    await assert.rejects(() => NewOpenAIFromEnv(new AbortController().signal, ""));
  });
});

// ---------------------------------------------------------------------------
// Direct tests, no Go precedent: SSE mechanics this port built from scratch.
// ---------------------------------------------------------------------------

describe("SSE stream mechanics (H4/H12/H13, no Go precedent)", () => {
  test("a reasoning item's raw bytes, including a duplicate key and a reformattable decimal, survive an SSE round trip", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Hand-write the item's raw JSON (not via JSON.stringify) so a
      // duplicate key and 1.50 are actually present on the wire.
      const rawItem = '{"id":"rs_1","type":"reasoning","encrypted_content":"AAAA","weird":1.50,"dup":1,"dup":2}';
      res.write(`data: {"type":"response.output_item.done","output_index":0,"item":${rawItem}}\n\n`);
      writeSSEEvent(res, openAICompleted("resp", 1, 1));
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(resp.content.length, 1);
      const block = resp.content[0] as ProviderStateBlock;
      assert.equal(block.type, "provider_state");
      assert.equal(d(block.providerData ?? new Uint8Array(0)), '{"id":"rs_1","type":"reasoning","encrypted_content":"AAAA","weird":1.50,"dup":1,"dup":2}');
    } finally {
      await srv.close();
    }
  });

  test("output items reassemble in ascending output_index order regardless of SSE arrival order (H13)", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Arrive out of order: index 1 before index 0.
      writeSSEEvent(res, outputItemDone(1, { type: "message", status: "completed", content: [{ type: "output_text", text: "second" }] }));
      writeSSEEvent(res, outputItemDone(0, { type: "message", status: "completed", content: [{ type: "output_text", text: "first" }] }));
      writeSSEEvent(res, openAICompleted("resp", 1, 1));
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(resp.content.length, 2);
      const first = resp.content[0];
      const second = resp.content[1];
      assert.ok(first !== undefined && first.type === "text" && first.text === "first");
      assert.ok(second !== undefined && second.type === "text" && second.text === "second");
    } finally {
      await srv.close();
    }
  });

  test("an output_item.done event with no output_index defaults to 0, matching a lone item", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_item.done","item":{"type":"message","status":"completed","content":[{"type":"output_text","text":"only"}]}}\n\n');
      writeSSEEvent(res, openAICompleted("resp", 1, 1));
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(resp.content.length, 1);
      const block = resp.content[0];
      assert.ok(block !== undefined && block.type === "text" && block.text === "only");
    } finally {
      await srv.close();
    }
  });

  test("an error-typed event aborts the decode even if a completed event also arrived", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSSEEvent(res, openAICompleted("resp", 1, 1));
      writeSSEEvent(res, { type: "error", code: "server_error", message: "boom" });
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      await assert.rejects(() => srv.model.generate(new AbortController().signal, "sys", messages, []), /openai stream error server_error: boom/);
    } finally {
      await srv.close();
    }
  });

  test("a stream with no terminal event at all is an error", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSSEEvent(res, outputItemDone(0, { type: "message", status: "completed", content: [{ type: "output_text", text: "x" }] }));
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      await assert.rejects(
        () => srv.model.generate(new AbortController().signal, "sys", messages, []),
        /openai stream ended without a final response event/,
      );
    } finally {
      await srv.close();
    }
  });

  test("a single SSE data line over 16 MiB is a hard error, not a silent truncation (H12)", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const huge = "x".repeat(17 * 1024 * 1024);
      res.write(`data: {"padding":"${huge}"}\n\n`);
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      await assert.rejects(() => srv.model.generate(new AbortController().signal, "sys", messages, []), /token too long/);
    } finally {
      await srv.close();
    }
  });

  test("a [DONE] sentinel line is swallowed without error", async () => {
    const srv = await oaiServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSSEEvent(res, openAICompleted("resp", 2, 1));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    try {
      const messages: Message[] = [{ role: RoleUser, content: [textBlock("hi")] }];
      const resp = await srv.model.generate(new AbortController().signal, "sys", messages, []);
      assert.equal(resp.inputTokens, 2);
    } finally {
      await srv.close();
    }
  });
});

describe("toOpenAIInput opaque replay (H4, no Go precedent)", () => {
  test("a replayed provider_state block's raw bytes are spliced into the request verbatim, never re-parsed", () => {
    const raw = s('{"type":"reasoning","id":"rs_1","encrypted_content":"AAAA","n":1.50}');
    const messages: Message[] = [{ role: RoleAssistant, content: [{ type: "provider_state", provider: "openai", providerData: raw }] }];
    const items = toOpenAIInput(messages);
    assert.equal(items.length, 1);
    const item = items[0];
    assert.ok(item !== undefined);
    const text = typeof item === "string" ? item : d(item);
    assert.equal(text, d(raw));
  });

  test("a fresh tool_use block (no provider data) goes through the normal function_call encoding", () => {
    const toolUse: ToolUseBlock = { type: "tool_use", id: "call_1", toolName: "read_file", toolInput: s('{"path":"a/b.go"}') };
    const messages: Message[] = [{ role: RoleAssistant, content: [toolUse] }];
    const items = toOpenAIInput(messages);
    assert.equal(items.length, 1);
    const item = items[0];
    const text = typeof item === "string" ? item : d(item as Uint8Array);
    assert.equal(text, '{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a/b.go\\"}"}');
  });

  test("an empty tool_use input substitutes the literal {}", () => {
    const toolUse: ToolUseBlock = { type: "tool_use", id: "call_1", toolName: "submit", toolInput: s("   ") };
    const messages: Message[] = [{ role: RoleAssistant, content: [toolUse] }];
    const items = toOpenAIInput(messages);
    const text = typeof items[0] === "string" ? (items[0] as string) : "";
    assert.ok(text.includes('"arguments":"{}"'));
  });

  test("a provider_state block that fails the opaque-replay precondition throws", () => {
    const messages: Message[] = [{ role: RoleAssistant, content: [{ type: "provider_state" }] }];
    assert.throws(() => toOpenAIInput(messages), /missing opaque response data/);
  });

  test("invalid JSON provider data throws", () => {
    const messages: Message[] = [{ role: RoleAssistant, content: [{ type: "provider_state", provider: "openai", providerData: s("{not json") }] }];
    assert.throws(() => toOpenAIInput(messages), /not valid JSON/);
  });
});
