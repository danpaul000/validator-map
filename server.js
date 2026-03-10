'use strict';

const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const { getCache, getStakePoolCache, startRefreshScheduler } = require('./src/cache');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(compression()); // must be before routes + static
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/nodes ─────────────────────────────────────────────────────────
app.get('/api/nodes', (req, res) => {
  const { nodes, lastUpdated, isLoading, error } = getCache();

  if (nodes.length === 0) {
    return res.status(isLoading ? 202 : 503).json({
      nodes: [], loading: isLoading,
      error: isLoading ? null : (error || 'No data available'),
      lastUpdated: null, count: 0,
    });
  }

  let result = nodes;
  if      (req.query.type === 'validators') result = nodes.filter(n => n.isValidator);
  else if (req.query.type === 'rpc')        result = nodes.filter(n => n.hasRpc);

  res.json({ nodes: result, lastUpdated, count: result.length });
});

// ── GET /api/stats ─────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const { stats, lastUpdated, error } = getCache();
  res.json({ stats, lastUpdated, error });
});

// ── GET /api/stakepools ────────────────────────────────────────────────────
// Returns stake distribution for all tracked liquid-staking pools.
// Each pool: { id, name, symbol, color, totalStakeSol, validators: [{votePubkey, stakeSol}] }
app.get('/api/stakepools', (req, res) => {
  const { pools, lastUpdated, isLoading, error } = getStakePoolCache();
  res.json({ pools, lastUpdated, isLoading, error });
});

// ── GET /api/health ────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const { lastUpdated, isLoading, error, nodes } = getCache();
  const sp = getStakePoolCache();
  res.json({
    status:          'ok',
    nodeCount:       nodes.length,
    nodeLastUpdated: lastUpdated,
    nodeError:       error,
    isLoading,
    stakePools:      sp.pools.length,
    stakePoolsLastUpdated: sp.lastUpdated,
  });
});

startRefreshScheduler();

app.listen(PORT, () => {
  console.log(`Validator map running at http://localhost:${PORT}`);
});
