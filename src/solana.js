'use strict';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TIMEOUT_MS = 20000;

async function rpcCall(method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNodeData() {
  const [clusterNodes, voteAccounts] = await Promise.all([
    rpcCall('getClusterNodes'),
    rpcCall('getVoteAccounts'),
  ]);

  // Build map from nodePubkey → vote account data
  const voteMap = new Map();
  for (const v of (voteAccounts.current || [])) {
    voteMap.set(v.nodePubkey, { ...v, status: 'active' });
  }
  for (const v of (voteAccounts.delinquent || [])) {
    voteMap.set(v.nodePubkey, { ...v, status: 'delinquent' });
  }

  return { clusterNodes, voteMap };
}

module.exports = { fetchNodeData };
