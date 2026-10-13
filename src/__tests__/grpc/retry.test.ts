import * as grpc from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  isTransientGrpcError,
  loadRetryPolicy,
  withRetry,
} from "../../grpc/retry.js";

function serviceError(code: grpc.status, message = "boom"): grpc.ServiceError {
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

const noSleep = vi.fn(async () => {});

describe("isTransientGrpcError", () => {
  it("treats UNAVAILABLE, DEADLINE_EXCEEDED and RESOURCE_EXHAUSTED as transient", () => {
    for (const code of [
      grpc.status.UNAVAILABLE,
      grpc.status.DEADLINE_EXCEEDED,
      grpc.status.RESOURCE_EXHAUSTED,
    ]) {
      expect(isTransientGrpcError(serviceError(code))).toBe(true);
    }
  });

  it("treats connection resets as transient even without a gRPC status", () => {
    expect(isTransientGrpcError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientGrpcError(new Error("socket hang up"))).toBe(true);
    expect(isTransientGrpcError(serviceError(grpc.status.INTERNAL, "Connection reset by peer"))).toBe(true);
  });

  it("treats permanent failures as non-transient", () => {
    for (const code of [
      grpc.status.INVALID_ARGUMENT,
      grpc.status.PERMISSION_DENIED,
      grpc.status.UNAUTHENTICATED,
      grpc.status.NOT_FOUND,
      grpc.status.INTERNAL,
    ]) {
      expect(isTransientGrpcError(serviceError(code))).toBe(false);
    }
    expect(isTransientGrpcError(null)).toBe(false);
    expect(isTransientGrpcError("string error")).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("doubles from the base delay and caps at the max", () => {
    const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(backoffDelayMs(policy, 1)).toBe(100);
    expect(backoffDelayMs(policy, 2)).toBe(200);
    expect(backoffDelayMs(policy, 3)).toBe(400);
    expect(backoffDelayMs(policy, 4)).toBe(800);
    expect(backoffDelayMs(policy, 5)).toBe(1_000);
    expect(backoffDelayMs(policy, 9)).toBe(1_000);
  });
});

describe("loadRetryPolicy", () => {
  it("returns the defaults when nothing is configured", () => {
    expect(loadRetryPolicy({})).toEqual(DEFAULT_RETRY_POLICY);
    expect(DEFAULT_RETRY_POLICY).toEqual({ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 });
  });

  it("reads the three env vars", () => {
    expect(
      loadRetryPolicy({
        KEYSTONE_GRPC_RETRY_ATTEMPTS: "5",
        KEYSTONE_GRPC_RETRY_BASE_MS: "50",
        KEYSTONE_GRPC_RETRY_MAX_MS: "800",
      })
    ).toEqual({ maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 800 });
  });

  it("rejects out-of-range or non-integer values", () => {
    expect(() => loadRetryPolicy({ KEYSTONE_GRPC_RETRY_ATTEMPTS: "0" })).toThrow(/1 to 10/);
    expect(() => loadRetryPolicy({ KEYSTONE_GRPC_RETRY_ATTEMPTS: "11" })).toThrow(/1 to 10/);
    expect(() => loadRetryPolicy({ KEYSTONE_GRPC_RETRY_BASE_MS: "abc" })).toThrow(/1 to 60000/);
    expect(() => loadRetryPolicy({ KEYSTONE_GRPC_RETRY_MAX_MS: "1.5" })).toThrow(/1 to 300000/);
    expect(() =>
      loadRetryPolicy({ KEYSTONE_GRPC_RETRY_BASE_MS: "1000", KEYSTONE_GRPC_RETRY_MAX_MS: "500" })
    ).toThrow(/greater than or equal/);
  });
});

describe("withRetry", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(serviceError(grpc.status.UNAVAILABLE))
      .mockRejectedValueOnce(serviceError(grpc.status.DEADLINE_EXCEEDED))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const onTransientFailure = vi.fn();
    const onSuccess = vi.fn();

    const result = await withRetry(
      operation,
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      { sleep, onTransientFailure, onSuccess }
    );

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    expect(onTransientFailure).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not retry a permanent failure", async () => {
    const error = serviceError(grpc.status.INVALID_ARGUMENT, "bad request");
    const operation = vi.fn(async () => {
      throw error;
    });
    const onTransientFailure = vi.fn();

    await expect(
      withRetry(operation, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 }, { sleep: noSleep, onTransientFailure })
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onTransientFailure).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and rethrows the last transient error", async () => {
    const last = serviceError(grpc.status.UNAVAILABLE, "still down");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(serviceError(grpc.status.UNAVAILABLE, "down 1"))
      .mockRejectedValueOnce(serviceError(grpc.status.UNAVAILABLE, "down 2"))
      .mockRejectedValueOnce(last);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    await expect(
      withRetry(operation, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 }, { sleep })
    ).rejects.toBe(last);
    expect(operation).toHaveBeenCalledTimes(3);
    // Two retries, so two sleeps; no sleep after the final failure.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports every transient failure, including the terminal one, with the retry decision", async () => {
    const operation = vi.fn().mockRejectedValue(serviceError(grpc.status.UNAVAILABLE));
    const onTransientFailure = vi.fn();

    await expect(
      withRetry(operation, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, { sleep: noSleep, onTransientFailure })
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onTransientFailure.mock.calls.map(([, attempt, willRetry]) => [attempt, willRetry])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it("reports a transient failure on a single-attempt policy without retrying", async () => {
    const operation = vi.fn().mockRejectedValue(serviceError(grpc.status.DEADLINE_EXCEEDED));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const onTransientFailure = vi.fn();

    await expect(
      withRetry(operation, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, { sleep, onTransientFailure })
    ).rejects.toMatchObject({ code: grpc.status.DEADLINE_EXCEEDED });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onTransientFailure).toHaveBeenCalledTimes(1);
    expect(onTransientFailure.mock.calls[0].slice(1)).toEqual([1, false]);
  });

  it("makes exactly one attempt when maxAttempts is 1", async () => {
    const operation = vi.fn().mockRejectedValue(serviceError(grpc.status.UNAVAILABLE));
    await expect(
      withRetry(operation, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, { sleep: noSleep })
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
