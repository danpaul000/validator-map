'use strict';

function computeStats(nodes) {
  let totalValidators = 0;
  let totalDelinquent = 0;
  let totalRpcNodes = 0;
  let totalWithGeo = 0;
  let totalStakeSol = 0;
  const countryCounts = {};
  const versionCounts = {};

  for (const node of nodes) {
    if (node.isValidator) totalValidators++;
    if (node.isDelinquent) totalDelinquent++;
    if (node.hasRpc) totalRpcNodes++;
    if (node.lat !== null) totalWithGeo++;
    if (node.stakeSol) totalStakeSol += node.stakeSol;

    const country = node.country || 'Unknown';
    countryCounts[country] = (countryCounts[country] || 0) + 1;

    const version = node.version || 'unknown';
    versionCounts[version] = (versionCounts[version] || 0) + 1;
  }

  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country, count]) => ({ country, count }));

  const versionDistribution = Object.entries(versionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([version, count]) => ({ version, count }));

  return {
    totalNodes: nodes.length,
    totalValidators,
    totalDelinquent,
    totalRpcNodes,
    totalWithGeo,
    totalStakeSol: Math.round(totalStakeSol),
    topCountries,
    versionDistribution,
  };
}

module.exports = { computeStats };
