import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { fetchIpfsBytes, fetchIpfsJson, IpfsContentTooLargeError } from "../../ipfs/gateway.js";

function config(maxBytes: number): Config {
  return { ipfsGatewayUrl: "https://primary.invalid", ipfsMaxFetchBytes: maxBytes } as unknown as Config;
}

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200, headers });
  return { response, wasCancelled: () => cancelled };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded IPFS reads", () => {
  it("returns content within the bound and reports no error", async () => {
    const { response } = streamed([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const bytes = await fetchIpfsBytes(config(5), "bafy-ok");
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects a declared Content-Length over the bound before reading the body", async () => {
    const { response, wasCancelled } = streamed([new Uint8Array(10)], { "content-length": "1000" });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchIpfsBytes(config(100), "bafy-big")).rejects.toBeInstanceOf(IpfsContentTooLargeError);
    expect(wasCancelled()).toBe(true);
    // Final: no fallback to the public gateways.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a streamed body the moment it exceeds the bound, even without Content-Length", async () => {
    const chunks = [new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)];
    const { response, wasCancelled } = streamed(chunks);
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const failure = await fetchIpfsBytes(config(100), "bafy-lying").catch((e) => e);
    expect(failure).toBeInstanceOf(IpfsContentTooLargeError);
    expect(failure.message).toContain("exceeds the 100-byte fetch bound");
    expect(wasCancelled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([Infinity, NaN, 1.5, -1, 0])(
    "keeps a usable bound when the configured bound is %s",
    async (bound) => {
      // 17 MiB declared: over the 16 MiB default, so a usable bound must reject it.
      const { response, wasCancelled } = streamed([new Uint8Array(10)], {
        "content-length": String(17 * 1024 * 1024),
      });
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await expect(fetchIpfsBytes(config(bound), "bafy-unbounded")).rejects.toBeInstanceOf(
        IpfsContentTooLargeError
      );
      expect(wasCancelled()).toBe(true);
    }
  );

  it("accepts a body exactly at the bound", async () => {
    const { response } = streamed([new Uint8Array(100)]);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const bytes = await fetchIpfsBytes(config(100), "bafy-exact");
    expect(bytes.length).toBe(100);
  });

  it("still falls back across gateways for ordinary failures", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (calls.length === 1) return new Response("nope", { status: 502 });
        return streamed([new TextEncoder().encode('{"ok":true}')]).response;
      })
    );
    const json = await fetchIpfsJson(config(1024), "bafy-json");
    expect(json).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("falls back to the next gateway when one answers 200 with malformed JSON", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (calls.length === 1) return streamed([new TextEncoder().encode("{not-json")]).response;
        return streamed([new TextEncoder().encode('{"ok":true}')]).response;
      })
    );
    const json = await fetchIpfsJson(config(1024), "bafy-json-fallback");
    expect(json).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("reports the parse failure of every gateway when none returns usable JSON", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return streamed([new TextEncoder().encode("{not-json")]).response;
      })
    );
    const failure = await fetchIpfsJson(config(1024), "bafy-json-broken").catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(IpfsContentTooLargeError);
    expect(failure.message).toContain("Failed to fetch CID bafy-json-broken from all gateways");
    // One line per gateway, each carrying the JSON.parse message.
    expect(calls).toHaveLength(4);
    expect(failure.message.split("\n").slice(1)).toHaveLength(4);
  });

  it("keeps an over-bound JSON body final even when a later gateway would parse", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (calls.length === 1) return streamed([new TextEncoder().encode("[" + "1,".repeat(200) + "1]")]).response;
        return streamed([new TextEncoder().encode('{"ok":true}')]).response;
      })
    );
    await expect(fetchIpfsJson(config(50), "bafy-json-big-first")).rejects.toBeInstanceOf(IpfsContentTooLargeError);
    expect(calls).toHaveLength(1);
  });

  it("bounds JSON reads too", async () => {
    const { response } = streamed([new TextEncoder().encode("[" + "1,".repeat(200) + "1]")]);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchIpfsJson(config(50), "bafy-json-big")).rejects.toBeInstanceOf(IpfsContentTooLargeError);
  });

  it("falls back to the default bound when the config carries none", async () => {
    const { response } = streamed([new Uint8Array(10)]);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const legacy = { ipfsGatewayUrl: "https://primary.invalid" } as unknown as Config;
    const bytes = await fetchIpfsBytes(legacy, "bafy-legacy");
    expect(bytes.length).toBe(10);
  });
});
