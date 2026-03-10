'use strict';

const { fetchNodeData }      = require('./solana');
const { enrichWithGeo }      = require('./geoip');
const { computeStats }       = require('./stats');
const { fetchValidatorInfo } = require('./validatorinfo');
const { fetchAllStakePools } = require('./stakepools');

const NODE_REFRESH_MS       = 5  * 60 * 1000;  // 5 min
const VALINFO_REFRESH_MS    = 30 * 60 * 1000;  // 30 min (changes rarely)
const STAKEPOOL_REFRESH_MS  = 15 * 60 * 1000;  // 15 min

// ── Node + validator info cache ───────────────────────────────────────────
let nodeCache = {
  nodes: [], stats: {}, lastUpdated: null, isLoading: false, error: null,
};

// Separate validator info map (identity pubkey → metadata)
let validatorInfoMap = new Map();

async function buildValidatorInfoCache() {
  const m = await fetchValidatorInfo();
  if (m.size > 0) {
    validatorInfoMap = m;
    // If nodes were already cached without names, rebuild now to merge them in
    if (nodeCache.nodes.length > 0) {
      console.log('[cache] Validator info loaded — refreshing node cache to merge names…');
      buildNodeCache();
    }
  }
}

async function buildNodeCache() {
  if (nodeCache.isLoading) return;
  nodeCache.isLoading = true;
  console.log('[cache] Refreshing node data…');

  try {
    const { clusterNodes, voteMap } = await fetchNodeData();

    const nodes = clusterNodes.map((node) => {
      const vote = voteMap.get(node.pubkey);
      const geo  = enrichWithGeo(node);
      const info = validatorInfoMap.get(node.pubkey) || {};

      return {
        // Identity
        pubkey:        node.pubkey,
        version:       node.version       || null,
        featureSet:    node.featureSet     || null,
        shredVersion:  node.shredVersion   || null,

        // Network
        gossip:  node.gossip || null,
        rpc:     node.rpc    || null,
        hasRpc:  !!node.rpc,

        // Geo
        ...geo,

        // Vote / stake
        isValidator:  !!vote,
        isDelinquent: vote?.status === 'delinquent',
        votePubkey:   vote?.votePubkey       || null,
        stakeSol:     vote?.activatedStake   ? vote.activatedStake / 1e9 : null,
        commission:   vote?.commission       ?? null,
        lastVote:     vote?.lastVote         || null,
        epochCredits: vote ? extractRecentCredits(vote.epochCredits) : null,

        // Validator info (may be null for nodes that haven't published)
        validatorName:    info.name            || null,
        validatorWebsite: info.website         || null,
        validatorIcon:    info.iconUrl         || null,
        validatorKeybase: info.keybaseUsername  || null,
      };
    });

    const withNames = nodes.filter(n => n.validatorName).length;
    if (validatorInfoMap.size > 0) {
      console.log(`[cache] ${validatorInfoMap.size} validator info entries merged (${withNames} nodes matched)`);
    }

    const stats = computeStats(nodes);

    nodeCache = {
      nodes,
      stats,
      lastUpdated: new Date().toISOString(),
      isLoading:   false,
      error:       null,
    };

    console.log(`[cache] ${nodes.length} nodes | ${stats.totalValidators} validators | ${stats.totalWithGeo} geo`);
  } catch (err) {
    console.error('[cache] Node refresh failed:', err.message);
    nodeCache.isLoading = false;
    nodeCache.error     = err.message;
  }
}

function extractRecentCredits(epochCredits) {
  if (!epochCredits?.length) return null;
  const last = epochCredits[epochCredits.length - 1];
  return last[1] - last[2];
}

// ── Stake pool cache ───────────────────────────────────────────────────────
let stakePoolCache = {
  pools: [], lastUpdated: null, isLoading: false, error: null,
};

async function buildStakePoolCache() {
  if (stakePoolCache.isLoading) return;
  stakePoolCache.isLoading = true;
  try {
    const pools = await fetchAllStakePools();
    stakePoolCache = {
      pools,
      lastUpdated: new Date().toISOString(),
      isLoading:   false,
      error:       null,
    };
  } catch (err) {
    console.error('[cache] Stake pool refresh failed:', err.message);
    stakePoolCache.isLoading = false;
    stakePoolCache.error = err.message;
  }
}

// ── Exports ────────────────────────────────────────────────────────────────
function getCache()          { return nodeCache; }
function getStakePoolCache() { return stakePoolCache; }

function startRefreshScheduler() {
  // Stagger initial loads to avoid rate-limit thundering herd on startup
  buildNodeCache();                              // fire immediately (fast)
  setTimeout(buildStakePoolCache,  3_000);       // 3s after startup
  setTimeout(buildValidatorInfoCache, 15_000);   // 15s after startup (getProgramAccounts is heavy)

  setInterval(buildNodeCache,            NODE_REFRESH_MS);
  setInterval(buildValidatorInfoCache,   VALINFO_REFRESH_MS);
  setInterval(buildStakePoolCache,       STAKEPOOL_REFRESH_MS);
}

module.exports = { getCache, getStakePoolCache, startRefreshScheduler };
