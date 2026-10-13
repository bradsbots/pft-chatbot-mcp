import * as grpc from "@grpc/grpc-js";

/**
 * Retry policy for Keystone gRPC unary calls.
 *
 * Only transient failures are retried (see {@link isTransientGrpcError}).
 * Delays grow exponentially from `baseDelayMs` and are capped at
 * `maxDelayMs`. `maxAttempts` counts the first attempt, so `3` means one
 * call plus up to two retries.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

const ENV_ATTEMPTS = "KEYSTONE_GRPC_RETRY_ATTEMPTS";
const ENV_BASE_MS = "KEYSTONE_GRPC_RETRY_BASE_MS";
const ENV_MAX_MS = "KEYSTONE_GRPC_RETRY_MAX_MS";

function readBoundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Load the retry policy from the environment.
 *
 * - `KEYSTONE_GRPC_RETRY_ATTEMPTS` (1–10, default 3). `1` disables retries.
 * - `KEYSTONE_GRPC_RETRY_BASE_MS` (1–60000, default 250).
 * - `KEYSTONE_GRPC_RETRY_MAX_MS` (1–300000, default 5000).
 *
 * Invalid values throw so misconfiguration is caught at startup rather than
 * silently changing retry behaviour on the first outage.
 */
export function loadRetryPolicy(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const maxAttempts = readBoundedInt(env, ENV_ATTEMPTS, DEFAULT_RETRY_POLICY.maxAttempts, 1, 10);
  const baseDelayMs = readBoundedInt(env, ENV_BASE_MS, DEFAULT_RETRY_POLICY.baseDelayMs, 1, 60_000);
  const maxDelayMs = readBoundedInt(env, ENV_MAX_MS, DEFAULT_RETRY_POLICY.maxDelayMs, 1, 300_000);
  if (maxDelayMs < baseDelayMs) {
    throw new Error(`${ENV_MAX_MS} must be greater than or equal to ${ENV_BASE_MS}`);
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

const TRANSIENT_STATUS_CODES: ReadonlySet<grpc.status> = new Set([
  grpc.status.UNAVAILABLE,
  grpc.status.DEADLINE_EXCEEDED,
  grpc.status.RESOURCE_EXHAUSTED,
]);

const CONNECTION_RESET_PATTERN =
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|connection reset|connection dropped|GOAWAY/i;

/**
 * True for failures that are worth retrying: the service is temporarily
 * unavailable, the call hit its deadline, the server is shedding load, or the
 * underlying connection was reset. Anything else (bad arguments, auth,
 * not-found, internal) is treated as permanent and surfaced immediately.
 */
export function isTransientGrpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as Partial<grpc.ServiceError> & { message?: string };
  if (typeof err.code === "number" && TRANSIENT_STATUS_CODES.has(err.code)) {
    return true;
  }
  const text = `${err.message ?? ""} ${err.details ?? ""}`;
  return CONNECTION_RESET_PATTERN.test(text);
}

/** Delay before retry number `attempt` (1-based: first retry = 1). */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

export interface RetryHooks {
  /**
   * Called after every attempt that fails with a transient error, including
   * the terminal attempt and calls whose policy allows only one attempt.
   * `willRetry` reports the separate retry decision: true when another
   * attempt follows, false when the error is about to be thrown. Permanent
   * failures never reach this hook.
   */
  onTransientFailure?: (error: unknown, attempt: number, willRetry: boolean) => void;
  /** Called once the call finally succeeds. */
  onSuccess?: () => void;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation` with exponential-backoff retry on transient gRPC errors.
 *
 * `operation` receives the 1-based attempt number so callers can rebuild
 * state (for example, re-resolve a recreated gRPC client) on each attempt.
 *
 * Accounting and retrying are separate decisions: every transient failure is
 * reported to `onTransientFailure` (so failure counters see the terminal
 * attempt and single-attempt calls too), while only a transient failure with
 * attempts remaining is retried.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: RetryHooks = {}
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await operation(attempt);
      hooks.onSuccess?.();
      return result;
    } catch (error) {
      if (!isTransientGrpcError(error)) throw error;
      const willRetry = attempt < policy.maxAttempts;
      hooks.onTransientFailure?.(error, attempt, willRetry);
      if (!willRetry) throw error;
      await sleep(backoffDelayMs(policy, attempt));
    }
  }
}
