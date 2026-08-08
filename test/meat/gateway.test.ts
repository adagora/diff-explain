import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { discoverExeGatewayBase, gatewayConfig } from "../../src/meat/gateway.ts";

// Ported from meat/gateway_test.go's discoverExeGatewayBase coverage
// (TestDiscoverExeGatewayBase*). The credential-resolution tests in the same
// Go file (TestNewAnthropicFromEnv*, TestNewOpenAIFromEnv*, TestNewModelFromEnv*)
// belong to anthropic.ts/openai.ts (items 4n/4o), not here.

async function withMarker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "meat-gateway-"));
  const markerPath = join(dir, "exe.dev");
  await writeFile(markerPath, "x");
  return markerPath;
}

function startReflectionServer(body: string, status = 200): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("discoverExeGatewayBase", () => {
  const originalMarkerPath = gatewayConfig.exeDevMarkerPath;
  const originalReflectionURL = gatewayConfig.reflectionIntegrationsURL;
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    gatewayConfig.exeDevMarkerPath = originalMarkerPath;
    gatewayConfig.reflectionIntegrationsURL = originalReflectionURL;
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    await Promise.all(servers.splice(0).map(closeServer));
  });

  test("marker present, llm integration found, non-team host", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(
      JSON.stringify({
        integrations: [
          { name: "discord", type: "discord" },
          { name: "llm", type: "llm" },
        ],
      }),
    );
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "https://llm.int.exe.xyz");
  });

  test("marker absent short-circuits before any network attempt", async () => {
    gatewayConfig.exeDevMarkerPath = join(tmpdir(), "meat-gateway-does-not-exist", "exe.dev");
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const got = await discoverExeGatewayBase(new AbortController().signal);
      assert.equal(got, "");
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("no llm integration in the list returns empty", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "discord", type: "discord" }] }));
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "");
  });

  test("team integration builds the .team.exe.xyz host", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "acme", type: "llm", team: true }] }));
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "https://acme.team.exe.xyz");
  });

  test("absent team field reads identically to false (H15)", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: "acme", type: "llm" }] }));
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "https://acme.int.exe.xyz");
  });

  test("scans in server-returned order, not sorted or deduped", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(
      JSON.stringify({
        integrations: [
          { name: "second", type: "llm" },
          { name: "first", type: "llm" },
        ],
      }),
    );
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "https://second.int.exe.xyz");
  });

  test("empty name is skipped even when type is llm", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(
      JSON.stringify({
        integrations: [
          { name: "", type: "llm" },
          { name: "later", type: "llm" },
        ],
      }),
    );
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "https://later.int.exe.xyz");
  });

  test("non-200 status returns empty with no retry", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer("not found", 404);
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "");
  });

  test("malformed JSON returns empty", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer("{not json");
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "");
  });

  test("a known field with the wrong JSON type fails the whole decode", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    const { server, url } = await startReflectionServer(JSON.stringify({ integrations: [{ name: 42, type: "llm" }] }));
    servers.push(server);
    gatewayConfig.reflectionIntegrationsURL = url;

    const got = await discoverExeGatewayBase(new AbortController().signal);
    assert.equal(got, "");
  });

  test("caller cancellation aborts and returns empty, not a throw", async () => {
    const markerPath = await withMarker();
    tempDirs.push(join(markerPath, ".."));
    gatewayConfig.exeDevMarkerPath = markerPath;
    // A server that never responds, so the caller's own cancellation is what fires.
    const server = createServer(() => {
      /* never respond */
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
    gatewayConfig.reflectionIntegrationsURL = `http://127.0.0.1:${address.port}`;

    const controller = new AbortController();
    const promise = discoverExeGatewayBase(controller.signal, { timeoutMs: 60_000 });
    controller.abort();
    const got = await promise;
    assert.equal(got, "");
  });
});
