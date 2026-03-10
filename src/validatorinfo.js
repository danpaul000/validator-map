'use strict';

// Fetches validator metadata (name, website, icon) from the Solana Config program.
// Validators publish this via `solana validator-info publish`.
// Stored as ConfigState accounts: [ValidatorInfoKey, identityPubkey] + JSON data.

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const CONFIG_PROGRAM  = 'Config1111111111111111111111111111111111111';
const VALIDATOR_INFO_KEY = 'Va1idator1nfo111111111111111111111111111111';

const TIMEOUT_MS = 30_000;

// ── Tiny base58 encoder + decoder (no deps) ────────────────────────────────
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  if (!buf || buf.length === 0) return '';
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { const r = Number(n % 58n); s = B58_ALPHA[r] + s; n = n / 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}
function base58Decode(str) {
  let n = 0n;
  for (const c of str) { n = n * 58n + BigInt(B58_ALPHA.indexOf(c)); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c !== '1') break; bytes.unshift(0); }
  while (bytes.length < 32) bytes.unshift(0);
  return Buffer.from(bytes);
}
const VALIDATOR_INFO_KEY_BYTES = base58Decode(VALIDATOR_INFO_KEY);

async function rpcCall(method, params = [], retries = 3, retryDelayMs = 12000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        const delay = retryDelayMs * (attempt + 1);  // 12s, 24s, 36s
        console.warn(`[validatorinfo] Rate-limited (429). Retrying in ${delay / 1000}s…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error('Max retries exceeded (rate limited)');
}

// ── Parse a single Config account ─────────────────────────────────────────
// Actual on-chain layout (verified by byte-level inspection):
//   byte  0      : compact-u16 key_count = 0x02 (1 byte, value = 2)
//   bytes 1–32   : ValidatorInfoKey pubkey (32 bytes)
//   byte  33     : signer bool = false (0x00)
//   bytes 34–65  : identity pubkey (32 bytes)  ← idStart = 34
//   byte  66     : signer bool = true  (0x01)
//   bytes 67–74  : u64 LE JSON string length   (bincode String encoding)
//   bytes 75+    : JSON bytes                  ← jsonStart = 75
//
// This is NOT bincode u64 key_count (which would put identity at 41) or
// borsh u32 key_count (identity at 37).  The key count uses a 1-byte
// compact encoding since it fits in 7 bits.
function parseValidatorInfoAccount(dataB64) {
  const buf = Buffer.from(dataB64, 'base64');
  if (buf.length < 76) return null;

  // Validate: byte 0 must be 2 (key count) and bytes 1–32 must be ValidatorInfoKey
  if (buf[0] !== 2) return null;
  if (!buf.slice(1, 33).equals(VALIDATOR_INFO_KEY_BYTES)) return null;

  try {
    const identityPubkey = base58Encode(buf.slice(34, 66));
    if (identityPubkey.length < 40) return null; // sanity: valid pubkey = 43–44 chars

    const jsonLen   = Number(buf.readBigUInt64LE(67));
    const jsonEnd   = 75 + jsonLen;
    if (jsonLen === 0 || jsonEnd > buf.length) return null;

    const info = JSON.parse(buf.slice(75, jsonEnd).toString('utf8'));
    if (!info.name && !info.website && !info.iconUrl) return null;

    return {
      identityPubkey,
      name:            info.name             || null,
      website:         info.website          || info.www || null,
      iconUrl:         info.iconUrl          || null,
      keybaseUsername: info.keybaseUsername  || null,
      details:         info.details          || null,
    };
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────
async function fetchValidatorInfo() {
  console.log('[validatorinfo] Fetching on-chain validator metadata…');

  // Try bincode filter first (most common), then no-filter fallback.
  // The borsh u32 variant is rare and omitted to reduce RPC calls.
  const filterSets = [
    [{ memcmp: { offset: 1, bytes: VALIDATOR_INFO_KEY } }],  // compact-u16 key count (1 byte)
    [],                                                        // no filter (last resort)
  ];

  for (const filters of filterSets) {
    try {
      const accounts = await rpcCall('getProgramAccounts', [
        CONFIG_PROGRAM,
        { encoding: 'base64', filters },
      ]);

      if (!accounts || accounts.length === 0) continue;

      const infoMap = new Map();
      for (const { account } of accounts) {
        const info = parseValidatorInfoAccount(account.data[0]);
        if (info?.identityPubkey) infoMap.set(info.identityPubkey, info);
      }

      if (infoMap.size === 0) continue;

      console.log(`[validatorinfo] Loaded ${infoMap.size} validator info records`);
      return infoMap;
    } catch (err) {
      console.warn(`[validatorinfo] Filter attempt failed: ${err.message}`);
    }
  }

  console.warn('[validatorinfo] Could not load validator info');
  return new Map();
}

module.exports = { fetchValidatorInfo };
