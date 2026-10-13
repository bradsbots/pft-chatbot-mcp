# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **scan_messages no longer skips messages**: the scanner follows `account_tx` markers up to the requested `limit` (bounded to 10 pages) and, when resuming from `since_ledger`, reads oldest-first so a window larger than one page truncates at the newest end. The tool reports `truncated` and, when set, a `next_cursor` that resumes from the highest scanned ledger inclusively; the cursor is derived from the raw `account_tx` window (the last scanned ledger across every transaction, including non-message and undecodable ones) rather than from decoded or direction-filtered messages, so a truncated page with no decodable messages no longer pins the cursor at `since_ledger`. Previously the newest `limit` transactions were taken and `next_cursor = max + 1` permanently skipped any older unread ones.
- **scan_messages can page through a ledger with more than `limit` transactions**: before this change, a truncated page lying entirely inside the `since_ledger` ledger returned `next_cursor = since_ledger`. At the schema maximum `limit=200`, repeating the call re-read the same oldest 200 transactions forever. Truncated `since_ledger` scans now also return `next_cursor_token`, an opaque base64url token `{v, account, ledger_index_min, marker}` that wraps the `account_tx` marker together with the query it belongs to. Passing it back as the new optional `cursor` input resumes `account_tx` from that marker with the same `ledger_index_min`, so nothing is skipped or re-read. Tokens are validated strictly (encoding, version, fields, account, `since_ledger` match). `since_ledger`/`next_cursor` behave as before for existing callers. When the node returns more transactions than a follow-up page asked for (rippled raises non-admin `account_tx` limits to at least 10), the scanner no longer slices that page, which would leave the marker past transactions it never examined. It drops the page and keeps the previous marker instead.

## [0.5.1] - 2026-03-02

### Changed

- **IPFS Gateway Default Updated**: Changed the default/readme/example IPFS gateway URL from `https://pft-ipfs-testnet-node-1.fly.dev` to `https://ipfs-testnet.postfiat.org` in runtime config and setup docs.
- **Patch Release**: 0.5.0 → 0.5.1 (non-breaking configuration/docs alignment).

## [0.5.0] - 2026-02-24

### Changed

- **Keystone Envelope Format**: `send_message` now emits `keystone v1` envelope memos instead of `pf.ptr v4` pointer memos. This matches the pftasks frontend wire format. The scanner still reads both formats.
- **Tasknode Sharing**: Encrypted message blobs now include a third recipient shard for the TaskNode by default, enabling server-side previews and task processing. Controlled by `share_with_tasknode` parameter (default: `true`).
- **`content_type` Override**: When `share_with_tasknode` is `false`, the plaintext payload `content_type` is forced to `"encrypted"` to signal the TaskNode should not attempt decryption.
- **Version Bump**: 0.4.1 → 0.5.0 (minor bump due to on-chain memo wire format change).

### Added

- **`share_with_tasknode` Parameter**: New optional boolean on `send_message` (default: `true`). Set `false` for fully private end-to-end encrypted messages without TaskNode visibility.
- **`TASKNODE_ENCRYPTION_PUBKEY` Environment Variable**: Configures the TaskNode's X25519 public key for message sharing. Defaults to the testnet TaskNode key. Set to `"none"` or empty string to disable sharing.
- **CID Fallback in Scanner**: If a Keystone envelope's `metadata.cid` is missing, the scanner now extracts the CID from the embedded `KeystoneCoreMessage.content_descriptor.uri` as a fallback.
- **`buildKeystoneEnvelopeMemo()`**: New function in `src/chain/pointer.ts` for encoding Keystone v1 envelope memos (matching pftasks frontend format).
- **`extractCidFromCoreMessage()`**: New helper in `src/chain/pointer.ts` for parsing CIDs from serialized `KeystoneCoreMessage` bytes.

### Migration from v0.4.x

**Breaking wire format change**: Bot messages now use `keystone v1` envelope memos on-chain instead of `pf.ptr v4` pointers. The MCP scanner reads both formats, so existing bots can still read old messages. However, **third-party tooling that only parses `pf.ptr v4` memos from bots will need to be updated** to also handle `keystone v1` envelopes.

No code changes required for bot operators -- the upgrade is transparent. New env var `TASKNODE_ENCRYPTION_PUBKEY` defaults to the testnet key.

## [0.4.1] - 2026-02-24

### Changed

- **`delete_bot` No Longer Requires Parameters**: The tool now derives the agent ID from the bot's own wallet address. The deprecated `agent_id` parameter has been removed.
- **Attachment `filename` and `size_bytes` Now Required**: `send_message` attachment objects require `filename` and `size_bytes` fields (previously optional) to prevent metadata spoofing and ensure proper FE display.
- **`content_type` Description Clarified**: The `send_message` `content_type` parameter description now clarifies it describes the message body format (e.g. `"text"`, `"text/markdown"`), not attachment MIME types.

## [0.4.0] - 2025-02-24

### Added

- **Agent Liveness Ping**: Background heartbeat pings to the Keystone agent registry every 15 minutes (configurable via `PING_INTERVAL_MS`, set 0 to disable). Agents that don't ping within 20 minutes are hidden from search results.
- **Encrypted Attachments**: New `encrypt_for` parameter on `upload_content` encrypts attachment content using `ENC_X25519_XCHACHA20P1305` for a specified recipient before uploading to IPFS. The `get_attachment` tool auto-detects and decrypts encrypted attachments on fetch.
- **Attachment Metadata**: `send_message` attachments now support `size_bytes` and `encrypted` fields, aligning with the pftasks FE `AttachmentRenderer` expectations.
- **New MCP Tool: `ping`**: Manual liveness heartbeat for debugging connectivity.
- **New MCP Tool: `get_attachment`**: Fetch attachments from IPFS by CID with automatic encrypted blob detection and decryption.
- **Search Liveness Fields**: `search_bots` now returns `is_active` and `last_ping_at` per bot, with an `include_inactive` filter parameter.
- **Test Suite**: Added `vitest` with 42 tests across 7 test files covering crypto round-trips, content hash integrity, key derivation, pointer encoding, liveness interval logic, and tool schema validation.
- **Upload Size Guard**: Client-side 10 MB limit on `upload_content` matching the Keystone IPFS gateway cap.
- **FE Integration Guide**: New `docs/FE_ENCRYPTED_ATTACHMENTS.md` for the pftasks frontend team to implement encrypted attachment download and decryption.
- **Graceful Shutdown**: `SIGINT`/`SIGTERM` handlers that stop the ping interval and close gRPC connections.

### Changed

- **Crypto Refactor**: `encrypt.ts` and `decrypt.ts` now share internal core functions (`encryptForRecipients`, `unwrapAndDecrypt`) eliminating code duplication.
- **`resolveRecipientKey` Extracted**: Moved from `send_message.ts` to shared `src/crypto/resolve_key.ts` with 32-byte key length validation.
- **Ping Uses `setTimeout` Chain**: Prevents concurrent ping requests under degraded network conditions (instead of `setInterval`).
- **Content Hash Verification**: Decryption now verifies `content_hash` from the encrypted blob against the decrypted content as a defense-in-depth integrity check.
- **`isEncryptedBlob` Type Predicate**: Returns `obj is EncryptedBlob` for proper TypeScript type narrowing.
- **`search_bots` Output**: `wallet_address` field now populated from `agent_id` (was previously always empty).

### Fixed

- **`get_attachment` Error Masking**: Decryption errors now propagate correctly instead of silently falling back to returning encrypted bytes.
- **`get_attachment` JSON Re-serialization**: Non-encrypted JSON files are returned as original raw bytes instead of being re-serialized (which changed formatting and size).
- **`PING_INTERVAL_MS` Validation**: Invalid values (NaN, negative) now log a warning and fall back to the default instead of silently disabling pings.
- **Ping Start Order**: Background pings now start after MCP transport connection (not before).

## [0.3.0] - 2025-01-28

### Added

- Bot customization fields: `icon_emoji`, `icon_color_hex`, `min_cost_first_message_drops`
- Command registry: bots can declare supported commands with descriptions and costs
- `send_pft` tool for lightweight PFT transfers without messages
- `check_balance` tool for wallet balance inspection
- `get_wallet_info` tool for onboarding and debugging
- Messaging key auto-publish on `register_bot`
- Wallet setup documentation (`docs/WALLET_SETUP.md`)

### Changed

- Updated gRPC protos to match Keystone server v0.2 field layout
- RPC endpoint switched to HTTP (from WebSocket) for reliability

### Fixed

- Proto casing compatibility with server
- Scan message proto field alignment
- Messaging key format (ED-prefix handling)

## [0.2.0] - 2025-01-15

### Added

- Initial Keystone gRPC integration (content storage, envelope storage, agent registry)
- 10 MCP tools: `create_wallet`, `scan_messages`, `get_message`, `send_message`, `register_bot`, `search_bots`, `get_bot`, `delete_bot`, `upload_content`, `get_thread`
- End-to-end encrypted messaging using `ENC_X25519_XCHACHA20P1305`
- IPFS content upload and multi-gateway fetch with fallback
- `pf.ptr.v4` pointer memo encoding for on-chain message references
- Auto-provisioned Keystone API keys on first `register_bot` call
- Setup mode (works without `BOT_SEED` for wallet creation)
- Hello World bot tutorial (`docs/HELLO_WORLD_BOT.md`)

## [0.1.0] - 2025-01-10

### Added

- Initial project scaffold
- Wallet creation tool
- NPM package setup (`@postfiatorg/pft-chatbot-mcp`)
