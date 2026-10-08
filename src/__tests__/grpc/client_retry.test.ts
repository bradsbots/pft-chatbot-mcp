import * as grpc from "@grpc/grpc-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeystoneClient } from "../../grpc/client.js";

const RETRY_ENV = [
  "KEYSTONE_GRPC_RETRY_ATTEMPTS",
  "KEYSTONE_GRPC_RETRY_BASE_MS",
  "KEYSTONE_GRPC_RETRY_MAX_MS",
  "KEYSTONE_GRPC_RECREATE_AFTER_FAILURES",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of RETRY_ENV) savedEnv[key] = process.env[key];
  // Keep the tests fast: tiny backoff, three attempts, recreate after two.
  process.env.KEYSTONE_GRPC_RETRY_ATTEMPTS = "3";
  process.env.KEYSTONE_GRPC_RETRY_BASE_MS = "1";
  process.env.KEYSTONE_GRPC_RETRY_MAX_MS = "2";
  process.env.KEYSTONE_GRPC_RECREATE_AFTER_FAILURES = "2";
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  for (const key of RETRY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

type UnaryCallback = (error: grpc.ServiceError | null, response: unknown) => void;

function serviceError(code: grpc.status, message = "boom"): grpc.ServiceError {
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

/** A fake unary method that answers from a scripted queue of outcomes. */
function scriptedMethod(outcomes: Array<grpc.ServiceError | { ok: unknown }>) {
  return vi.fn((_req: unknown, _md: grpc.Metadata, ...rest: unknown[]) => {
    // Support both the 3-arg (req, metadata, cb) and 4-arg (req, metadata,
    // options, cb) grpc-js signatures so this test stays valid alongside the
    // per-call deadline change in PR #6.
    const callback = rest[rest.length - 1] as UnaryCallback;
    const next = outcomes.shift();
    if (!next) throw new Error("scripted method called more times than expected");
    queueMicrotask(() => {
      if ("ok" in next) callback(null, next.ok);
      else callback(next, null);
    });
  });
}

/**
 * Build a KeystoneClient without opening real channels. Only the fields the
 * retry path touches are populated; `buildServices` is stubbed so channel
 * recreation can be observed without protobuf loading.
 */
function fakeClient(stubs: { agentRegistry?: object; authService?: object; contentStorage?: object }) {
  const client = Object.create(KeystoneClient.prototype) as KeystoneClient;
  const buildServices = vi.fn(() => {
    Object.assign(client, {
      agentRegistry: stubs.agentRegistry ?? {},
      authService: stubs.authService ?? {},
      contentStorage: stubs.contentStorage ?? {},
      envelopeStorage: {},
    });
  });
  Object.assign(client, {
    apiKey: null,
    target: "fake:0",
    credentials: grpc.credentials.createInsecure(),
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    recreateAfter: 2,
    consecutiveTransientFailures: 0,
    buildServices,
  });
  buildServices();
  return { client, buildServices };
}

describe("KeystoneClient retry", () => {
  it("retries an idempotent call on UNAVAILABLE and returns the eventual response", async () => {
    const pingAgent = scriptedMethod([
      serviceError(grpc.status.UNAVAILABLE),
      { ok: { lastPingAt: { seconds: "1", nanos: 0 } } },
    ]);
    const { client } = fakeClient({ agentRegistry: { pingAgent } });

    const result = await client.pingAgent();

    expect(result).toEqual({ lastPingAt: { seconds: "1", nanos: 0 } });
    expect(pingAgent).toHaveBeenCalledTimes(2);
    expect(client.transientFailureStreak).toBe(0);
  });

  it("retries storeContent on a connection reset", async () => {
    const storeContent = scriptedMethod([
      serviceError(grpc.status.INTERNAL, "read ECONNRESET"),
      { ok: { descriptor: { uri: "ipfs://cid", contentType: "text/plain", contentLength: "1", contentHash: Buffer.alloc(0) } } },
    ]);
    const { client } = fakeClient({ contentStorage: { storeContent } });

    const result = await client.storeContent(Buffer.from("x"), "text/plain");

    expect(result.descriptor.uri).toBe("ipfs://cid");
    expect(storeContent).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent failure", async () => {
    const pingAgent = scriptedMethod([serviceError(grpc.status.PERMISSION_DENIED, "no key")]);
    const { client, buildServices } = fakeClient({ agentRegistry: { pingAgent } });

    await expect(client.pingAgent()).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    expect(pingAgent).toHaveBeenCalledTimes(1);
    expect(buildServices).toHaveBeenCalledTimes(1); // only the initial build
    expect(client.transientFailureStreak).toBe(0);
  });

  it("never retries a non-idempotent call even on a transient failure", async () => {
    const verifyAndIssueKey = scriptedMethod([serviceError(grpc.status.DEADLINE_EXCEEDED)]);
    const { client } = fakeClient({ authService: { verifyAndIssueKey } });

    await expect(client.verifyAndIssueKey("rAddr", "nonce", "sig", "label")).rejects.toMatchObject({
      code: grpc.status.DEADLINE_EXCEEDED,
    });
    expect(verifyAndIssueKey).toHaveBeenCalledTimes(1);
  });

  it("recreates the gRPC channels after consecutive transient failures and uses the new stub", async () => {
    // First stub fails twice (hits recreateAfter=2); the rebuilt stub succeeds.
    const firstPing = scriptedMethod([
      serviceError(grpc.status.UNAVAILABLE, "down 1"),
      serviceError(grpc.status.UNAVAILABLE, "down 2"),
    ]);
    const secondPing = scriptedMethod([{ ok: { lastPingAt: { seconds: "2", nanos: 0 } } }]);
    const client = Object.create(KeystoneClient.prototype) as KeystoneClient;
    let builds = 0;
    const buildServices = vi.fn(() => {
      builds += 1;
      Object.assign(client, {
        agentRegistry: { pingAgent: builds === 1 ? firstPing : secondPing, close: vi.fn() },
        authService: { close: vi.fn() },
        contentStorage: { close: vi.fn() },
        envelopeStorage: { close: vi.fn() },
      });
    });
    Object.assign(client, {
      apiKey: null,
      target: "fake:0",
      credentials: grpc.credentials.createInsecure(),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      recreateAfter: 2,
      consecutiveTransientFailures: 0,
      buildServices,
    });
    buildServices();
    const recreate = vi.spyOn(client, "recreateChannels");

    const result = await client.pingAgent();

    expect(result).toEqual({ lastPingAt: { seconds: "2", nanos: 0 } });
    expect(firstPing).toHaveBeenCalledTimes(2);
    expect(secondPing).toHaveBeenCalledTimes(1);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(buildServices).toHaveBeenCalledTimes(2);
    expect(client.transientFailureStreak).toBe(0);
  });

  it("counts the failure streak across calls and resets it on success", async () => {
    const pingAgent = scriptedMethod([
      serviceError(grpc.status.RESOURCE_EXHAUSTED),
      serviceError(grpc.status.RESOURCE_EXHAUSTED),
      serviceError(grpc.status.RESOURCE_EXHAUSTED),
    ]);
    const { client, buildServices } = fakeClient({ agentRegistry: { pingAgent } });

    await expect(client.pingAgent()).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
    // Three attempts: two retried failures (streak 1, 2 -> recreate at 2, reset to 0)
    // and one final failure that is not retried.
    expect(pingAgent).toHaveBeenCalledTimes(3);
    expect(buildServices).toHaveBeenCalledTimes(2);
    expect(client.transientFailureStreak).toBe(0);
  });

  it("reads the recreate threshold from the environment via the constructor path", () => {
    process.env.KEYSTONE_GRPC_RECREATE_AFTER_FAILURES = "0";
    expect(
      () =>
        new KeystoneClient({
          keystoneGrpcUrl: "localhost:1",
          keystoneApiKey: null,
        } as any)
    ).toThrow(/KEYSTONE_GRPC_RECREATE_AFTER_FAILURES/);
  });
});
