import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  RoleUser,
  RoleAssistant,
  textBlock,
  type Block,
  type Message,
  type Response,
} from "../../src/meat/model.ts";

describe("Role", () => {
  test("named constants have Go's exact wire values", () => {
    assert.equal(RoleUser, "user");
    assert.equal(RoleAssistant, "assistant");
  });
});

describe("textBlock", () => {
  test("builds a text-only block", () => {
    const b = textBlock("hello");
    assert.deepEqual(b, { type: "text", text: "hello" });
  });
  test("carries no provider overlay by default", () => {
    const b = textBlock("hello");
    assert.ok(!("provider" in b));
    assert.ok(!("providerData" in b));
  });
});

describe("Block — Provider/ProviderData overlay on any variant (specs/model.md)", () => {
  test("a tool_use block can simultaneously carry normalized fields and an opaque provider-state overlay", () => {
    // Mirrors meat/openai.go:328-340: a function_call item becomes a
    // tool_use block carrying both ToolName/ToolInput *and*
    // Provider/ProviderData — the overlay is not exclusive to
    // "provider_state" blocks.
    const b: Block = {
      type: "tool_use",
      id: "call_1",
      toolName: "read_file",
      toolInput: new TextEncoder().encode('{"path":"a/b.go"}'),
      provider: "openai",
      providerData: new TextEncoder().encode('{"id":"fc_1"}'),
    };
    assert.equal(b.type, "tool_use");
    assert.equal(b.provider, "openai");
    assert.ok(b.providerData !== undefined && b.providerData.length > 0);
  });

  test("a provider_state block carries only the overlay, no normalized fields", () => {
    const b: Block = {
      type: "provider_state",
      provider: "openai",
      providerData: new TextEncoder().encode('{"type":"reasoning"}'),
    };
    assert.equal(b.type, "provider_state");
  });

  test("presence is a length check, not a nilness check (H9 does not apply here)", () => {
    // A present-but-empty providerData and an absent one must both read as
    // "no opaque state" to downstream code — model.ts itself just needs to
    // make both representable; the length check is the provider's job.
    const withEmpty: Block = { type: "text", text: "hi", providerData: new Uint8Array(0) };
    const withAbsent: Block = { type: "text", text: "hi" };
    const hasState = (b: Block): boolean => (b.providerData?.length ?? 0) > 0;
    assert.equal(hasState(withEmpty), false);
    assert.equal(hasState(withAbsent), false);
  });
});

describe("Message / Response — Content order is significant and never reordered here", () => {
  test("content preserves insertion order", () => {
    const msg: Message = {
      role: RoleUser,
      content: [textBlock("first"), textBlock("second"), textBlock("third")],
    };
    assert.deepEqual(
      msg.content.map((b) => (b.type === "text" ? b.text : "")),
      ["first", "second", "third"],
    );
  });

  test("Response counts are per-call fields, not accumulators", () => {
    const r: Response = { content: [textBlock("ok")], inputTokens: 12, outputTokens: 3 };
    assert.equal(r.inputTokens, 12);
    assert.equal(r.outputTokens, 3);
  });
});
