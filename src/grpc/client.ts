import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import {
  loadRetryPolicy,
  withRetry,
  type RetryPolicy,
} from "./retry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, "protos");

// Load options for proto-loader
const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

export interface ContentDescriptor {
  uri: string;
  contentType: string;
  contentLength: string; // long as string
  contentHash: Buffer;
}

export interface StoreContentResponse {
  descriptor: ContentDescriptor;
}

export interface StoreEnvelopeResponse {
  envelopeId: string;
  storageBackend: string;
  metadata: Record<string, string>;
}

export interface CommandDescriptor {
  command: string;
  example: string;
  description: string;
  minCostDrops: string; // uint64 as string (0 = no minimum beyond chain floor of 1 drop)
}

export interface BotProfileData {
  iconEmoji: string;
  iconColorHex: string;
  minCostFirstMessageDrops: string; // uint64 as string
}

export interface AgentProviderData {
  url: string;
  organization: string;
}

export interface AgentCardData {
  name: string;
  description: string;
  url: string;
  provider: AgentProviderData;
  version: string;
}

export interface AgentCapabilitiesData {
  publicEncryptionKey: Buffer;
  supportedSemanticCapabilities: string[];
}

export interface ProtoTimestamp {
  seconds: string;
  nanos: number;
}

export interface AgentSearchResult {
  agentId: string;
  agentCard: AgentCardData;
  keystoneCapabilities: AgentCapabilitiesData;
  relevanceScore: number;
  supportedCommands: CommandDescriptor[];
  iconEmoji: string;
  iconColorHex: string;
  minCostFirstMessageDrops: string;
  isActive: boolean;
  lastPingAt: ProtoTimestamp | null;
}

export interface PingAgentResponse {
  lastPingAt: ProtoTimestamp;
}

export interface SearchAgentsResponse {
  results: AgentSearchResult[];
  totalCount: number;
}

export interface StoreAgentCardResponse {
  agentCard: AgentCardData;
  supportedCommands: CommandDescriptor[];
  iconEmoji: string;
  iconColorHex: string;
  minCostFirstMessageDrops: string;
  agentId: string; // wallet address used as agent_id (server-derived)
}

export interface GetAgentCardResponse {
  agentCard: AgentCardData;
  supportedCommands: CommandDescriptor[];
  iconEmoji: string;
  iconColorHex: string;
  minCostFirstMessageDrops: string;
}

export interface VerifyAndIssueKeyResponse {
  apiKey: string;
  walletAddress: string;
  writeLimitPerHour: number;
  readLimitPerHour: number;
}

export interface RequestApiKeyResponse {
  challengeNonce: string;
  expiresAtUnix: string; // long as string
}

// Promisify a gRPC unary call
function promisify<TReq, TRes>(
  client: grpc.Client,
  method: (
    req: TReq,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res: TRes) => void
  ) => void
): (req: TReq, metadata?: grpc.Metadata) => Promise<TRes> {
  return (req: TReq, metadata?: grpc.Metadata) =>
    new Promise((resolve, reject) => {
      method.call(
        client,
        req,
        metadata || new grpc.Metadata(),
        (err: grpc.ServiceError | null, res: TRes) => {
          if (err) reject(err);
          else resolve(res);
        }
      );
    });
}

type ServiceName =
  | "contentStorage"
  | "envelopeStorage"
  | "agentRegistry"
  | "authService";

/**
 * Methods whose effects are not safe to repeat if the first attempt actually
 * reached the server but the response was lost (for example a deadline hit
 * after the write committed). These are never retried; transient failures
 * surface to the caller, who holds the context to decide.
 *
 * Everything else is idempotent on the Keystone side: storeContent is
 * content-addressed (same bytes -> same CID), storeAgentCard is an upsert
 * keyed on the authenticated wallet, pings and reads have no side effects,
 * and requestApiKey only issues a fresh challenge nonce.
 */
const NON_IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "verifyAndIssueKey",
  "storeEnvelope",
  "deleteAgentCard",
]);

const DEFAULT_RECREATE_AFTER_FAILURES = 3;
const ENV_RECREATE_AFTER = "KEYSTONE_GRPC_RECREATE_AFTER_FAILURES";

function recreateAfterFailures(): number {
  const raw = process.env[ENV_RECREATE_AFTER];
  if (raw === undefined || raw === "") return DEFAULT_RECREATE_AFTER_FAILURES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(`${ENV_RECREATE_AFTER} must be an integer from 1 to 100`);
  }
  return value;
}

export class KeystoneClient {
  private contentStorage!: grpc.Client;
  private envelopeStorage!: grpc.Client;
  private agentRegistry!: grpc.Client;
  private authService!: grpc.Client;
  private apiKey: string | null;
  private readonly target: string;
  private readonly credentials: grpc.ChannelCredentials;
  private readonly retryPolicy: RetryPolicy;
  private readonly recreateAfter: number;
  private consecutiveTransientFailures = 0;

  constructor(config: Config) {
    this.apiKey = config.keystoneApiKey;
    this.retryPolicy = loadRetryPolicy();
    this.recreateAfter = recreateAfterFailures();

    const target = config.keystoneGrpcUrl;
    // Default to TLS. Only use insecure for localhost/dev when explicitly opted in.
    const isInsecure =
      process.env.KEYSTONE_GRPC_INSECURE === "true" ||
      target.startsWith("localhost") ||
      target.startsWith("127.0.0.1") ||
      target.startsWith("[::1]");
    const credentials = isInsecure
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl();
    this.target = target;
    this.credentials = credentials;
    this.buildServices();
  }

  /** Construct (or reconstruct) the four gRPC service stubs. */
  private buildServices(): void {
    const target = this.target;
    const credentials = this.credentials;

    // Load storage proto
    const storagePkg = protoLoader.loadSync(
      "keystone/v1/storage/storage.proto",
      LOADER_OPTIONS
    );
    const storageProto = grpc.loadPackageDefinition(storagePkg) as any;

    this.contentStorage =
      new storageProto.keystone.v1.storage.KeystoneContentStorageService(
        target,
        credentials
      );
    this.envelopeStorage =
      new storageProto.keystone.v1.storage.KeystoneEnvelopeStorageService(
        target,
        credentials
      );

    // Load registry proto
    const registryPkg = protoLoader.loadSync(
      "keystone/v1/registry/registry.proto",
      LOADER_OPTIONS
    );
    const registryProto = grpc.loadPackageDefinition(registryPkg) as any;

    this.agentRegistry =
      new registryProto.keystone.v1.registry.KeystoneAgentRegistryService(
        target,
        credentials
      );

    // Load auth proto
    const authPkg = protoLoader.loadSync(
      "keystone/v1/auth/auth.proto",
      LOADER_OPTIONS
    );
    const authProto = grpc.loadPackageDefinition(authPkg) as any;

    this.authService = new authProto.keystone.v1.auth.KeystoneAuthService(
      target,
      credentials
    );
  }

  /**
   * Drop the current channels and build fresh stubs. Called automatically
   * after `KEYSTONE_GRPC_RECREATE_AFTER_FAILURES` consecutive transient
   * failures so a wedged HTTP/2 connection cannot poison every later call.
   * Every transient failure counts, including the final attempt of an
   * exhausted retry sequence and the single attempt of a non-idempotent
   * call. Rebuilding resets the streak, so one threshold crossing triggers
   * exactly one rebuild; any successful call also resets it.
   */
  recreateChannels(): void {
    this.close();
    this.buildServices();
    this.consecutiveTransientFailures = 0;
  }

  /** Current count of consecutive transient failures (resets on success). */
  get transientFailureStreak(): number {
    return this.consecutiveTransientFailures;
  }

  /**
   * Invoke one unary RPC with retry on transient failure. The stub is
   * re-resolved on every attempt so a channel recreation between attempts
   * takes effect immediately.
   */
  private unary<TRes>(
    service: ServiceName,
    methodName: string,
    request: unknown,
    metadata?: grpc.Metadata
  ): Promise<TRes> {
    const policy: RetryPolicy = NON_IDEMPOTENT_METHODS.has(methodName)
      ? { ...this.retryPolicy, maxAttempts: 1 }
      : this.retryPolicy;
    return withRetry<TRes>(
      () => {
        const stub = this[service];
        const method = (stub as any)[methodName];
        const call = promisify<unknown, TRes>(stub, method);
        return call(request, metadata ?? new grpc.Metadata());
      },
      policy,
      {
        onSuccess: () => {
          this.consecutiveTransientFailures = 0;
        },
        // Every transient failure counts toward the recreation threshold,
        // including the terminal attempt and single-attempt (non-idempotent)
        // calls. Whether to retry is decided separately by withRetry.
        onTransientFailure: (error, attempt, willRetry) => {
          this.consecutiveTransientFailures += 1;
          const code = (error as Partial<grpc.ServiceError>).code;
          process.stderr.write(
            `[grpc] WARN - ${methodName} attempt ${attempt} failed (code ${code ?? "n/a"}); ${willRetry ? "retrying" : "not retrying"}\n`
          );
          if (this.consecutiveTransientFailures >= this.recreateAfter) {
            process.stderr.write(
              `[grpc] WARN - ${this.consecutiveTransientFailures} consecutive transient failures; recreating Keystone channels\n`
            );
            this.recreateChannels();
          }
        },
      }
    );
  }

  private authMetadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.apiKey) {
      md.set("x-api-key", this.apiKey);
    }
    return md;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  // --- Auth Service ---

  async requestApiKey(walletAddress: string): Promise<RequestApiKeyResponse> {
    return this.unary<RequestApiKeyResponse>("authService", "requestApiKey", {
      walletAddress,
    });
  }

  async verifyAndIssueKey(
    walletAddress: string,
    challengeNonce: string,
    signatureHex: string,
    label: string
  ): Promise<VerifyAndIssueKeyResponse> {
    return this.unary<VerifyAndIssueKeyResponse>(
      "authService",
      "verifyAndIssueKey",
      { walletAddress, challengeNonce, signatureHex, label }
    );
  }

  // --- Content Storage ---

  async storeContent(
    content: Buffer,
    contentType: string
  ): Promise<StoreContentResponse> {
    return this.unary<StoreContentResponse>(
      "contentStorage",
      "storeContent",
      { content, contentType },
      this.authMetadata()
    );
  }

  // --- Envelope Storage ---

  async storeEnvelope(envelope: any): Promise<StoreEnvelopeResponse> {
    return this.unary<StoreEnvelopeResponse>(
      "envelopeStorage",
      "storeEnvelope",
      { envelope },
      this.authMetadata()
    );
  }

  async listEnvelopesBySender(
    sender: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ envelopes: any[]; totalCount: number }> {
    return this.unary<any>(
      "envelopeStorage",
      "listEnvelopesBySender",
      { sender, limit, offset },
      this.authMetadata()
    );
  }

  // --- Agent Registry ---

  async storeAgentCard(
    agentCard: {
      name: string;
      description: string;
      url?: string;
      version?: string;
      organization?: string;
    },
    capabilities: {
      publicEncryptionKey: Buffer;
      supportedSemanticCapabilities: string[];
    },
    commands?: Array<{
      command: string;
      example: string;
      description: string;
      minCostDrops?: string;
    }>,
    profile?: {
      iconEmoji?: string;
      iconColorHex?: string;
      minCostFirstMessageDrops?: string;
    }
  ): Promise<StoreAgentCardResponse> {
    // agent_id is not sent -- the server derives it from the authenticated
    // wallet address (one wallet = one bot).
    return this.unary<StoreAgentCardResponse>(
      "agentRegistry",
      "storeAgentCard",
      {
        agentCard: {
          name: agentCard.name,
          description: agentCard.description,
          url: agentCard.url || "",
          provider: {
            organization: agentCard.organization || "",
          },
          version: agentCard.version || "1.0.0",
        },
        keystoneCapabilities: {
          envelopeProcessing: true,
          ledgerPersistence: true,
          publicEncryptionKey: capabilities.publicEncryptionKey,
          publicKeyAlgorithm: "PUBLIC_KEY_ALGORITHM_CURVE25519",
          supportedSemanticCapabilities:
            capabilities.supportedSemanticCapabilities,
          supportedEncryptionModes: ["ENCRYPTION_MODE_PUBLIC_KEY"],
        },
        supportedCommands: (commands || []).map((cmd) => ({
          command: cmd.command,
          example: cmd.example,
          description: cmd.description,
          minCostDrops: cmd.minCostDrops || "0",
        })),
        iconEmoji: profile?.iconEmoji || "",
        iconColorHex: profile?.iconColorHex || "",
        minCostFirstMessageDrops: profile?.minCostFirstMessageDrops || "0",
      },
      this.authMetadata()
    );
  }

  async searchAgents(
    query?: string,
    capabilities?: string[],
    limit: number = 20,
    includeInactive?: boolean
  ): Promise<SearchAgentsResponse> {
    return this.unary<SearchAgentsResponse>(
      "agentRegistry",
      "searchAgents",
      {
        query: query || "",
        capabilities: capabilities || [],
        limit,
        offset: 0,
        includeInactive: includeInactive || false,
      },
      this.authMetadata()
    );
  }

  async getAgentCard(agentId: string): Promise<GetAgentCardResponse> {
    return this.unary<GetAgentCardResponse>(
      "agentRegistry",
      "getAgentCard",
      { agentId },
      this.authMetadata()
    );
  }

  async deleteAgentCard(agentId: string): Promise<Record<string, never>> {
    return this.unary<Record<string, never>>(
      "agentRegistry",
      "deleteAgentCard",
      { agentId },
      this.authMetadata()
    );
  }

  async pingAgent(): Promise<PingAgentResponse> {
    return this.unary<PingAgentResponse>("agentRegistry", "pingAgent", {}, this.authMetadata());
  }

  close(): void {
    (this.contentStorage as any).close?.();
    (this.envelopeStorage as any).close?.();
    (this.agentRegistry as any).close?.();
    (this.authService as any).close?.();
  }
}
