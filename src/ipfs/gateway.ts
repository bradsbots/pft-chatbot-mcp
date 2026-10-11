import { DEFAULT_IPFS_MAX_FETCH_BYTES, type Config } from "../config.js";

// Public IPFS gateways for fallback reads
const FALLBACK_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
];

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Strip the ipfs:// prefix from a URI and return the bare CID.
 */
function extractCid(uriOrCid: string): string {
  if (uriOrCid.startsWith("ipfs://")) {
    return uriOrCid.slice(7);
  }
  return uriOrCid;
}

/**
 * Build the list of gateway URLs to try, in priority order.
 */
function buildGatewayUrls(config: Config, cid: string): string[] {
  const urls: string[] = [];

  // Primary gateway from config
  if (config.ipfsGatewayUrl) {
    const base = config.ipfsGatewayUrl.replace(/\/$/, "");
    urls.push(`${base}/ipfs/${cid}`);
  }

  // Public fallbacks
  for (const gw of FALLBACK_GATEWAYS) {
    urls.push(`${gw}${cid}`);
  }

  return urls;
}

/**
 * Fetch with a timeout.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thrown when a CID's content exceeds the configured fetch bound. It is a
 * property of the content, not of the gateway that served it, so callers do
 * not fall back to another gateway for it.
 */
export class IpfsContentTooLargeError extends Error {
  constructor(
    public readonly cid: string,
    public readonly maxBytes: number,
    public readonly observedBytes: number | null
  ) {
    super(
      observedBytes == null
        ? `Content for CID ${cid} exceeds the ${maxBytes}-byte fetch bound`
        : `Content for CID ${cid} is ${observedBytes} bytes, over the ${maxBytes}-byte fetch bound`
    );
    this.name = "IpfsContentTooLargeError";
  }
}

function maxFetchBytes(config: Config): number {
  const value = config.ipfsMaxFetchBytes;
  // A non-finite or non-integer bound (Infinity, NaN) would let every body
  // length compare below it; only a positive safe integer is a usable bound.
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_IPFS_MAX_FETCH_BYTES;
}

/**
 * Read a response body with a hard byte bound. A declared Content-Length
 * above the bound is rejected before any body bytes are read; otherwise the
 * body is consumed as a stream and the read is aborted as soon as the bound
 * is exceeded, so a gateway that lies about (or omits) Content-Length cannot
 * make the process buffer an unbounded body.
 */
async function readBodyBounded(
  response: Response,
  cid: string,
  maxBytes: number
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared != null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new IpfsContentTooLargeError(cid, maxBytes, length);
    }
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new IpfsContentTooLargeError(cid, maxBytes, buffer.length);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new IpfsContentTooLargeError(cid, maxBytes, null);
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

/**
 * Try each gateway in order; `decode` runs on the bounded body inside the
 * per-gateway scope, so a gateway that answers 200 with a body the caller
 * cannot use (malformed JSON) is treated like any other gateway failure and
 * the next gateway is tried. Only IpfsContentTooLargeError is final.
 */
async function fetchBoundedFromGateways<T>(
  config: Config,
  cidOrUri: string,
  decode: (bytes: Buffer) => T
): Promise<T> {
  const cid = extractCid(cidOrUri);
  const urls = buildGatewayUrls(config, cid);
  const bound = maxFetchBytes(config);
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        errors.push(`${url}: ${response.status}`);
        continue;
      }
      const bytes = await readBodyBounded(response, cid, bound);
      return decode(bytes);
    } catch (err: any) {
      if (err instanceof IpfsContentTooLargeError) {
        // Final: the content itself is over the bound.
        throw err;
      }
      errors.push(`${url}: ${err.message}`);
      continue;
    }
  }

  throw new Error(
    `Failed to fetch CID ${cid} from all gateways:\n${errors.join("\n")}`
  );
}

/**
 * Fetch JSON content from IPFS by CID, trying multiple gateways.
 * This is the same pattern used by the pftasks frontend.
 */
export async function fetchIpfsJson(
  config: Config,
  cidOrUri: string
): Promise<any> {
  return fetchBoundedFromGateways(config, cidOrUri, (bytes) =>
    JSON.parse(bytes.toString("utf8"))
  );
}

/**
 * Fetch raw bytes from IPFS by CID, trying multiple gateways.
 */
export async function fetchIpfsBytes(
  config: Config,
  cidOrUri: string
): Promise<Buffer> {
  return fetchBoundedFromGateways(config, cidOrUri, (bytes) => bytes);
}
