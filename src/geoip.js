'use strict';

const geoip = require('geoip-lite');

/**
 * Extract IP from gossip address.
 * IPv4: "1.2.3.4:8001" → "1.2.3.4"
 * IPv6: "[fe80::1]:8001" → "fe80::1"
 */
function extractIp(gossip) {
  if (!gossip) return null;
  // IPv6 bracketed
  if (gossip.startsWith('[')) {
    const end = gossip.indexOf(']');
    return end > 0 ? gossip.slice(1, end) : null;
  }
  // IPv4: split on last colon (port is always last segment)
  const lastColon = gossip.lastIndexOf(':');
  return lastColon > 0 ? gossip.slice(0, lastColon) : null;
}

/**
 * Enrich a cluster node with geo data.
 * Returns null geo fields for unresolvable IPs (private, bogon, unlisted).
 */
function enrichWithGeo(clusterNode) {
  const ip = extractIp(clusterNode.gossip);
  if (!ip) {
    return { ip: null, lat: null, lon: null, country: null, city: null, region: null, timezone: null };
  }

  const geo = geoip.lookup(ip);
  if (!geo) {
    return { ip, lat: null, lon: null, country: null, city: null, region: null, timezone: null };
  }

  return {
    ip,
    lat: geo.ll[0],
    lon: geo.ll[1],
    country: geo.country || null,
    region: geo.region || null,
    city: geo.city || null,
    timezone: geo.timezone || null,
  };
}

module.exports = { extractIp, enrichWithGeo };
