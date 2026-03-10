'use strict';

// Fetches stake distribution for major Solana liquid staking pools.
//
// SPL-compatible pools (jitoSOL, bSOL, laineSOL):
//   1. Read StakePool account → ValidatorList pubkey is at byte offset 98
//   2. Read ValidatorList account → parse borsh: 9-byte header + N×73-byte entries
//      Each entry: active_stake_lamports (u64) at +0, vote_account (Pubkey) at +41
//
// Marinade (mSOL) — custom Anchor program:
//   State account at MARINADE_STATE_ADDR
//   ValidatorList pubkey lives at byte offset 272 in the state account data
//   (after 8-byte Anchor discriminator + all preceding fields)
//   Each ValidatorRecord: vote_account (Pubkey) at +0, active_balance (u64) at +32
//
// Lido (stSOL) — ValidatorList account address is hardcoded (stable).

const RPC_URL  = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TIMEOUT_MS = 30_000;

// ── Tiny base58 encoder ───────────────────────────────────────────────────
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

async function rpcCall(method, params = []) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getAccountData(result) {
  return result?.value?.data?.[0] ?? null;
}

// Sanity-check a vote pubkey: should be ~43-44 base58 chars, non-empty
function isValidPubkey(s) {
  return typeof s === 'string' && s.length >= 32 && s.length <= 44;
}

// ── SPL Stake Pool ────────────────────────────────────────────────────────
// StakePool account: ValidatorList pubkey at bytes [98..130]
function splGetValidatorListAddress(dataB64) {
  const buf = Buffer.from(dataB64, 'base64');
  if (buf.length < 130) return null;
  return base58Encode(buf.slice(98, 130));
}

// ValidatorList account layout (borsh):
//   [0]     account_type  u8
//   [1..5]  max_validators u32 LE
//   [5..9]  Vec length     u32 LE   ← count
//   [9 + i*73 ..]  ValidatorStakeInfo (73 bytes each):
//     +0   active_stake_lamports  u64 LE  (8 bytes)
//     +8   transient_stake_lamports u64 LE (8 bytes)
//     +16  last_update_epoch      u64 LE  (8 bytes)
//     +24  transient_seed_suffix  u64 LE  (8 bytes)
//     +32  unused                 u32 LE  (4 bytes)
//     +36  validator_seed_suffix  u32 LE  (4 bytes)
//     +40  status                 u8      (1 byte)
//     +41  vote_account_address   Pubkey  (32 bytes)
function parseSplValidatorList(dataB64) {
  const buf = Buffer.from(dataB64, 'base64');
  if (buf.length < 9) return [];
  const count = buf.readUInt32LE(5);
  const results = [];
  for (let i = 0; i < count; i++) {
    const base = 9 + i * 73;
    if (base + 73 > buf.length) break;
    const lamports = buf.readBigUInt64LE(base);
    if (lamports === 0n) continue;
    const vote = base58Encode(buf.slice(base + 41, base + 73));
    if (isValidPubkey(vote)) {
      results.push({ votePubkey: vote, stakeSol: Number(lamports) / 1e9 });
    }
  }
  return results;
}

async function fetchSplPool(pool) {
  try {
    const poolAcct = await rpcCall('getAccountInfo', [pool.poolAddress, { encoding: 'base64' }]);
    const poolData = getAccountData(poolAcct);
    if (!poolData) { console.warn(`[stakepools] ${pool.symbol}: pool account not found`); return null; }

    const validatorListAddr = splGetValidatorListAddress(poolData);
    if (!validatorListAddr) { console.warn(`[stakepools] ${pool.symbol}: cannot read ValidatorList address`); return null; }

    const listAcct = await rpcCall('getAccountInfo', [validatorListAddr, { encoding: 'base64' }]);
    const listData = getAccountData(listAcct);
    if (!listData) { console.warn(`[stakepools] ${pool.symbol}: ValidatorList not found`); return null; }

    const validators = parseSplValidatorList(listData);
    const totalStakeSol = validators.reduce((s, v) => s + v.stakeSol, 0);
    console.log(`[stakepools] ${pool.symbol}: ${validators.length} validators, ${Math.round(totalStakeSol).toLocaleString()} SOL`);
    return { ...pool, validators, totalStakeSol };
  } catch (err) {
    console.error(`[stakepools] ${pool.symbol} failed: ${err.message}`);
    return null;
  }
}

// ── Marinade (mSOL) ───────────────────────────────────────────────────────
// Primary: Marinade public REST API (simpler and avoids binary format churn)
// Fallback: binary parsing of Marinade Anchor state + ValidatorList account

// Try multiple Marinade API endpoint candidates and return normalised validators.
async function fetchMarinadeViaAPI() {
  const ENDPOINTS = [
    'https://api.marinade.finance/validators',
    'https://validators.marinade.finance/validators',
    'https://api.marinade.finance/staking/validators',
  ];
  for (const url of ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      let res;
      try { res = await fetch(url, { signal: ctrl.signal }); }
      finally { clearTimeout(t); }
      if (!res.ok) continue;
      const data = await res.json();
      // Normalise: accept Array or {validators:[...]} or {data:[...]}
      const arr = Array.isArray(data) ? data
                : Array.isArray(data?.validators) ? data.validators
                : Array.isArray(data?.data) ? data.data
                : [];
      const validators = [];
      for (const v of arr) {
        const vote = v.vote_account ?? v.voteAccount ?? v.vote_address ?? v.voteAddress;
        const sol  = v.marinade_stake_sol ?? v.marinadeStakeSol
                  ?? v.active_balance ?? v.activeBalance
                  ?? v.stake_sol ?? v.stakeSol
                  ?? (v.marinade_stake   ? v.marinade_stake / 1e9 : null)
                  ?? (v.activated_stake ? v.activated_stake / 1e9 : null);
        if (isValidPubkey(vote) && sol > 0) validators.push({ votePubkey: vote, stakeSol: Number(sol) });
      }
      if (validators.length >= 50) {
        console.log(`[stakepools] mSOL API (${url}): ${validators.length} validators`);
        return validators;
      }
    } catch { /* try next */ }
  }
  return null;
}

// Binary fallback: parse Marinade Anchor state → ValidatorList account.
// item_size is read from state; active_balance is at record offset +32.
const MARINADE_STATE_ADDR = '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC';

function parseMarinadeValidatorList(dataB64, itemSize, count) {
  const buf = Buffer.from(dataB64, 'base64');
  const results = [];
  // Skip 8-byte Anchor discriminator header
  const startOffset = (buf.length >= count * itemSize + 8) ? 8 : 0;
  for (let i = 0; i < count; i++) {
    const base = startOffset + i * itemSize;
    if (base + 40 > buf.length) break;
    const vote    = base58Encode(buf.slice(base, base + 32));
    const lamports = buf.readBigUInt64LE(base + 32);
    if (isValidPubkey(vote) && lamports > 0n && lamports < 500_000_000_000_000_000n) {
      results.push({ votePubkey: vote, stakeSol: Number(lamports) / 1e9 });
    }
  }
  return results;
}

async function fetchMarinade() {
  try {
    // ── 1. Try REST API first ─────────────────────────────────────────────
    const apiValidators = await fetchMarinadeViaAPI();
    if (apiValidators) {
      const totalStakeSol = apiValidators.reduce((s, v) => s + v.stakeSol, 0);
      console.log(`[stakepools] mSOL: ${apiValidators.length} validators, ${Math.round(totalStakeSol).toLocaleString()} SOL (API)`);
      return { id: 'msol', name: 'Marinade', symbol: 'mSOL', color: '#ff7700', validators: apiValidators, totalStakeSol };
    }

    // ── 2. Binary fallback ────────────────────────────────────────────────
    console.log('[stakepools] mSOL: API unavailable, falling back to binary parsing');
    const stateAcct = await rpcCall('getAccountInfo', [MARINADE_STATE_ADDR, { encoding: 'base64' }]);
    const stateData = getAccountData(stateAcct);
    if (!stateData) { console.warn('[stakepools] mSOL: state account not found'); return null; }

    const buf = Buffer.from(stateData, 'base64');

    // validator_system.validator_list is at offset 264 inside the Marinade state:
    //   stake_system ends at 264 (8-byte discriminator + all preceding fields)
    //   validator_list.account  Pubkey at +264
    //   validator_list.item_size u32   at +296 (+32)
    //   validator_list.count     u32   at +300 (+36)
    let validatorListAddr = null;
    let itemSize = 84, count = 0;

    for (const offset of [264, 268, 272, 276, 280]) {
      if (buf.length < offset + 80) continue;
      const addr = base58Encode(buf.slice(offset, offset + 32));
      const iSz  = buf.readUInt32LE(offset + 32);
      const cnt  = buf.readUInt32LE(offset + 36);
      if (!isValidPubkey(addr) || iSz < 40 || iSz > 256 || cnt < 10 || cnt > 5000) continue;
      try {
        const probe = await rpcCall('getAccountInfo', [addr, { encoding: 'base64' }]);
        if (probe?.value) { validatorListAddr = addr; itemSize = iSz; count = cnt; break; }
      } catch { /* try next offset */ }
    }

    if (!validatorListAddr) { console.warn('[stakepools] mSOL: could not locate ValidatorList'); return null; }

    const listAcct = await rpcCall('getAccountInfo', [validatorListAddr, { encoding: 'base64' }]);
    const listData = getAccountData(listAcct);
    if (!listData) { console.warn('[stakepools] mSOL: ValidatorList not found'); return null; }

    const validators = parseMarinadeValidatorList(listData, itemSize, count);
    const totalStakeSol = validators.reduce((s, v) => s + v.stakeSol, 0);
    console.log(`[stakepools] mSOL: ${validators.length} validators, ${Math.round(totalStakeSol).toLocaleString()} SOL (binary)`);
    return { id: 'msol', name: 'Marinade', symbol: 'mSOL', color: '#ff7700', validators, totalStakeSol };
  } catch (err) {
    console.error(`[stakepools] mSOL failed: ${err.message}`);
    return null;
  }
}

// ── Pool definitions ───────────────────────────────────────────────────────
const SPL_POOLS = [
  { id: 'jitosol', name: 'Jito',       symbol: 'jitoSOL', color: '#e84142', poolAddress: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb' },
  { id: 'bsol',    name: 'BlazeStake', symbol: 'bSOL',    color: '#4d9de0', poolAddress: 'stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi' },
  { id: 'lainesol',name: 'Laine',      symbol: 'laineSOL',color: '#c2f24d', poolAddress: '2qyEeSAWKfU18AFthrF7JA8z8ZCi1yt76Tqs917vwQTV' },
];

// ── Main export ────────────────────────────────────────────────────────────
async function fetchAllStakePools() {
  console.log('[stakepools] Fetching stake pool distributions…');
  const [marinadeResult, ...splResults] = await Promise.allSettled([
    fetchMarinade(),
    ...SPL_POOLS.map(fetchSplPool),
  ]);

  const pools = [];
  if (marinadeResult.status === 'fulfilled' && marinadeResult.value) pools.push(marinadeResult.value);
  for (const r of splResults) {
    if (r.status === 'fulfilled' && r.value) pools.push(r.value);
  }
  console.log(`[stakepools] Loaded ${pools.length}/${SPL_POOLS.length + 1} pools`);
  return pools;
}

module.exports = { fetchAllStakePools };
