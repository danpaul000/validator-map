(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────
  const COLORS = {
    validator:  '#14f195',
    delinquent: '#ff6b6b',
    rpc:        '#9945ff',
    other:      '#8b949e',
  };
  const REFRESH_MS = 5 * 60 * 1000;

  // ── State ──────────────────────────────────────────────
  let map            = null;
  let clusterGroup   = null;
  let stakeLayer     = null;   // L.layerGroup for stake-pool circles
  let currentFilter  = 'all';
  let currentPool    = 'off';  // 'off' | 'all' | pool.id
  let currentNodes   = [];     // last-loaded nodes (used by overlay)
  let stakePoolData  = [];     // from /api/stakepools

  // ── Map init ───────────────────────────────────────────
  function initMap() {
    map = L.map('map', {
      center: [20, 10], zoom: 2, minZoom: 2, maxZoom: 12,
      zoomControl: true, preferCanvas: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
      chunkedLoading:      true,
      maxClusterRadius:    55,
      spiderfyOnMaxZoom:   true,
      showCoverageOnHover: false,
      iconCreateFunction:  createClusterIcon,
    });
    map.addLayer(clusterGroup);

    // ── Spiderfication fix ─────────────────────────────
    // When the node-detail panel is open and the user clicks the MAP BACKGROUND
    // (not a marker), we want to:
    //   1. Close the detail panel
    //   2. NOT collapse the spiderfy (the spider stays open)
    //
    // Strategy: use DOM capture phase on the map container so we intercept the
    // click BEFORE Leaflet's bubble-phase listeners (including MarkerCluster's
    // "click background → unspiderfy" handler).  If the panel is open and the
    // click target is background, we stop propagation — MarkerCluster never
    // sees the click, so the spider remains open.
    document.getElementById('map').addEventListener('click', (e) => {
      const panel = document.getElementById('node-detail');
      if (!panel.classList.contains('hidden')) {
        const onDot     = !!e.target.closest('.node-dot');
        const onCluster = !!e.target.closest('.cluster-icon');
        if (!onDot && !onCluster) {
          panel.classList.add('hidden');
          e.stopPropagation(); // ← prevents MarkerCluster from seeing this click
        }
      }
    }, true /* capture phase — runs before Leaflet's bubble handlers */);
  }

  // ── Cluster icon ───────────────────────────────────────
  function createClusterIcon(cluster) {
    const count = cluster.getChildCount();
    const size  = count > 200 ? 'large' : count > 30 ? 'medium' : 'small';
    const dim   = size === 'large' ? 50 : size === 'medium' ? 40 : 32;
    return L.divIcon({
      html: `<div class="cluster-icon cluster-${size}"><span>${count > 999 ? Math.round(count/1000)+'k' : count}</span></div>`,
      className: '', iconSize: L.point(dim, dim), iconAnchor: L.point(dim/2, dim/2),
    });
  }

  // ── Marker helpers ─────────────────────────────────────
  function getColor(node) {
    if (node.isDelinquent) return COLORS.delinquent;
    if (node.isValidator)  return COLORS.validator;
    if (node.hasRpc)       return COLORS.rpc;
    return COLORS.other;
  }

  function createMarker(node) {
    const color = getColor(node);
    const icon  = L.divIcon({
      html: `<div class="node-dot" style="background:${color};box-shadow:0 0 5px ${color}99"></div>`,
      className: '', iconSize: [8,8], iconAnchor: [4,4],
    });
    const marker = L.marker([node.lat, node.lon], { icon });
    marker.on('click', () => showNodeDetail(node));
    return marker;
  }

  // ── Render map ─────────────────────────────────────────
  function renderMap(nodes) {
    clusterGroup.clearLayers();
    const geo     = nodes.filter(n => n.lat !== null && n.lon !== null);
    const markers = geo.map(createMarker);
    clusterGroup.addLayers(markers);
  }

  // ── Node detail panel ──────────────────────────────────
  function showNodeDetail(node) {
    const panel   = document.getElementById('node-detail');
    const content = document.getElementById('node-detail-content');

    // Header: icon + name + website
    const iconWrap = document.getElementById('node-detail-icon-wrap');
    const nameEl   = document.getElementById('node-detail-name');
    const websiteEl= document.getElementById('node-detail-website');

    iconWrap.innerHTML = '';
    if (node.validatorIcon) {
      const img = document.createElement('img');
      img.src   = node.validatorIcon;
      img.alt   = node.validatorName || 'Validator icon';
      img.onerror = () => { iconWrap.innerHTML = ''; };
      iconWrap.appendChild(img);
    }

    nameEl.textContent = node.validatorName || 'Node Details';

    if (node.validatorWebsite) {
      websiteEl.href        = node.validatorWebsite.startsWith('http') ? node.validatorWebsite : 'https://' + node.validatorWebsite;
      websiteEl.textContent = node.validatorWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '') + ' ↗';
      websiteEl.classList.remove('hidden');
    } else {
      websiteEl.classList.add('hidden');
    }

    // Badge
    let badgeClass = 'node', badgeText = 'Node';
    if (node.isDelinquent)       { badgeClass = 'delinquent'; badgeText = 'Delinquent Validator'; }
    else if (node.isValidator)   { badgeClass = 'validator';  badgeText = 'Active Validator'; }
    else if (node.hasRpc)        { badgeClass = 'rpc';        badgeText = 'RPC Node'; }

    const location = [node.city, node.region, node.country].filter(Boolean).join(', ') || 'Unknown';

    const stakeHtml = node.stakeSol
      ? `<span class="detail-value stake">${formatSol(node.stakeSol)}</span>`
      : `<span class="detail-value" style="color:var(--text-muted)">No stake</span>`;

    // Stake pool delegations for this validator
    const poolDelegations = getPoolDelegationsForNode(node.votePubkey);
    const poolHtml = poolDelegations.length > 0
      ? `<div class="detail-row">
           <span class="detail-label">Pool Delegations</span>
           <div class="pool-delegations">
             ${poolDelegations.map(d => `
               <div class="pool-delegation-row">
                 <div class="pool-color-dot" style="background:${esc(d.color)}"></div>
                 <span class="pool-delegation-name">${esc(d.symbol)}</span>
                 <span class="pool-delegation-stake">${formatSol(d.stakeSol)}</span>
               </div>
             `).join('')}
           </div>
         </div>`
      : '';

    content.innerHTML = `
      <div class="detail-badge ${badgeClass}">${badgeText}</div>

      <div class="detail-row">
        <span class="detail-label">Node Pubkey</span>
        <span class="detail-value pubkey" title="${esc(node.pubkey)}">${abbrev(node.pubkey)}</span>
      </div>

      ${node.votePubkey ? `
      <div class="detail-row">
        <span class="detail-label">Vote Account</span>
        <span class="detail-value pubkey" title="${esc(node.votePubkey)}">${abbrev(node.votePubkey)}</span>
      </div>` : ''}

      <div class="detail-row">
        <span class="detail-label">Stake</span>
        ${stakeHtml}
      </div>

      ${node.commission !== null ? `
      <div class="detail-row">
        <span class="detail-label">Commission</span>
        <span class="detail-value">${node.commission}%</span>
      </div>` : ''}

      ${node.epochCredits !== null ? `
      <div class="detail-row">
        <span class="detail-label">Last Epoch Credits</span>
        <span class="detail-value">${node.epochCredits?.toLocaleString() ?? '—'}</span>
      </div>` : ''}

      <div class="detail-row">
        <span class="detail-label">Version</span>
        <span class="detail-value">${esc(node.version || 'unknown')}</span>
      </div>

      <div class="detail-row">
        <span class="detail-label">Location</span>
        <span class="detail-value">${esc(location)}</span>
      </div>

      ${node.ip ? `
      <div class="detail-row">
        <span class="detail-label">IP Address</span>
        <span class="detail-value pubkey">${esc(node.ip)}</span>
      </div>` : ''}

      ${node.rpc ? `
      <div class="detail-row">
        <span class="detail-label">RPC Endpoint</span>
        <span class="detail-value" style="word-break:break-all;font-size:12px">${esc(node.rpc)}</span>
      </div>` : ''}

      ${poolHtml}
    `;

    panel.classList.remove('hidden');
  }

  // Look up which pools delegate to a given vote pubkey
  function getPoolDelegationsForNode(votePubkey) {
    if (!votePubkey || !stakePoolData.length) return [];
    const results = [];
    for (const pool of stakePoolData) {
      const v = pool.validators?.find(vv => vv.votePubkey === votePubkey);
      if (v) results.push({ ...pool, stakeSol: v.stakeSol });
    }
    results.sort((a, b) => b.stakeSol - a.stakeSol);
    return results;
  }

  // ── Sidebar stats ──────────────────────────────────────
  function renderStats(stats) {
    if (!stats) return;
    setText('stat-total',      stats.totalNodes?.toLocaleString()      ?? '—');
    setText('stat-validators', stats.totalValidators?.toLocaleString() ?? '—');
    setText('stat-rpc',        stats.totalRpcNodes?.toLocaleString()   ?? '—');
    setText('stat-delinquent', stats.totalDelinquent?.toLocaleString() ?? '—');
  }

  function renderCountries(countries) {
    if (!countries?.length) return;
    const max  = countries[0].count;
    const list = document.getElementById('countries-list');
    list.innerHTML = countries.map(({ country, count }) => `
      <div class="bar-row">
        <span class="bar-label">${esc(country)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(count/max*100)}%"></div></div>
        <span class="bar-count">${count}</span>
      </div>
    `).join('');
  }

  function renderVersions(versions) {
    if (!versions?.length) return;
    const max  = versions[0].count;
    const list = document.getElementById('versions-list');
    list.innerHTML = versions.map(({ version, count }) => `
      <div class="bar-row">
        <span class="bar-label" title="${esc(version)}" style="width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(version)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(count/max*100)}%;background:#14f195"></div></div>
        <span class="bar-count">${count}</span>
      </div>
    `).join('');
  }

  function updateLastUpdated(iso) {
    if (!iso) return;
    document.getElementById('last-updated').textContent =
      `Updated ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  // ── Node data loading ──────────────────────────────────
  async function loadData(filter) {
    try {
      const param = filter && filter !== 'all' ? `?type=${filter}` : '';
      const [nodesRes, statsRes] = await Promise.all([
        fetch(`/api/nodes${param}`), fetch('/api/stats'),
      ]);
      const nodesJson = await nodesRes.json();
      const statsJson = await statsRes.json();

      if (nodesJson.loading) { setTimeout(() => loadData(filter), 2000); return; }

      currentNodes = nodesJson.nodes || [];
      renderMap(currentNodes);
      renderStats(statsJson.stats);
      renderCountries(statsJson.stats?.topCountries);
      renderVersions(statsJson.stats?.versionDistribution);
      updateLastUpdated(nodesJson.lastUpdated);

      // Re-render overlay with refreshed node positions
      if (currentPool !== 'off') renderStakeOverlay(currentPool);

      hideLoading();
    } catch (err) {
      console.error('Failed to load data:', err);
      document.getElementById('loading-text').textContent = 'Failed to load data. Retrying…';
      setTimeout(() => loadData(filter), 5000);
    }
  }

  // ── Stake pool data + overlay ──────────────────────────
  async function loadStakePools() {
    try {
      const res  = await fetch('/api/stakepools');
      const json = await res.json();
      // If server hasn't finished building the cache yet, retry after a short delay
      if ((json.pools?.length ?? 0) === 0 && !json.lastUpdated) {
        setTimeout(loadStakePools, 3000);
        return;
      }
      stakePoolData = json.pools || [];
      document.getElementById('stakepool-loading').classList.add('hidden');
      renderStakePoolButtons();
    } catch (err) {
      console.error('Failed to load stake pool data:', err);
      document.getElementById('stakepool-loading').textContent = 'error';
    }
  }

  function renderStakePoolButtons() {
    const container = document.getElementById('stakepool-buttons');
    // Keep the "Off" button, replace the rest
    container.innerHTML = `<button class="pool-btn active" data-pool="off">Off</button>`;

    if (stakePoolData.length > 0) {
      // "All Pools" combined view
      const allBtn = document.createElement('button');
      allBtn.className   = 'pool-btn';
      allBtn.dataset.pool = 'all';
      allBtn.innerHTML   = `<div class="pool-dot" style="background:linear-gradient(135deg,#e84142,#ff7700,#4d9de0)"></div> All`;
      container.appendChild(allBtn);

      for (const pool of stakePoolData) {
        const btn = document.createElement('button');
        btn.className    = 'pool-btn';
        btn.dataset.pool  = pool.id;
        btn.style.setProperty('--pool-color', pool.color);
        btn.innerHTML    = `<div class="pool-dot" style="background:${pool.color}"></div> ${esc(pool.symbol)}`;
        container.appendChild(btn);
      }
    }

    // Bind clicks
    container.querySelectorAll('.pool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.pool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPool = btn.dataset.pool;
        renderStakeOverlay(currentPool);
        const legend = document.getElementById('stakepool-legend');
        legend.classList.toggle('hidden', currentPool === 'off');
      });
    });
  }

  function renderStakeOverlay(poolId) {
    // Remove existing overlay
    if (stakeLayer) { map.removeLayer(stakeLayer); stakeLayer = null; }
    if (poolId === 'off' || !stakePoolData.length) return;

    // Build vote→{lat,lon} from currently loaded nodes
    const voteToGeo = new Map();
    for (const node of currentNodes) {
      if (node.votePubkey && node.lat !== null) {
        voteToGeo.set(node.votePubkey, { lat: node.lat, lon: node.lon });
      }
    }

    // Build vote→stakeEntry map
    let stakeByVote; // Map<votePubkey, { totalStake, pools:[] }>
    if (poolId === 'all') {
      stakeByVote = new Map();
      for (const pool of stakePoolData) {
        for (const v of (pool.validators || [])) {
          if (!stakeByVote.has(v.votePubkey)) stakeByVote.set(v.votePubkey, { totalStake: 0, pools: [] });
          const e = stakeByVote.get(v.votePubkey);
          e.totalStake += v.stakeSol;
          e.pools.push({ name: pool.name, symbol: pool.symbol, color: pool.color, stakeSol: v.stakeSol });
        }
      }
    } else {
      const pool = stakePoolData.find(p => p.id === poolId);
      if (!pool) return;
      stakeByVote = new Map();
      for (const v of (pool.validators || [])) {
        stakeByVote.set(v.votePubkey, {
          totalStake: v.stakeSol,
          pools: [{ name: pool.name, symbol: pool.symbol, color: pool.color, stakeSol: v.stakeSol }],
        });
      }
    }

    // Compute log-scale radius bounds
    let maxStake = 0;
    for (const e of stakeByVote.values()) maxStake = Math.max(maxStake, e.totalStake);
    if (maxStake === 0) return;

    const MIN_R = 4, MAX_R = 32;
    const logMax = Math.log10(maxStake + 1);

    stakeLayer = L.layerGroup();

    for (const [votePubkey, entry] of stakeByVote.entries()) {
      const geo = voteToGeo.get(votePubkey);
      if (!geo) continue;

      const r     = MIN_R + (MAX_R - MIN_R) * (Math.log10(entry.totalStake + 1) / logMax);
      // For single pool: use pool color. For "all": pick dominant pool color
      const color = entry.pools.length === 1
        ? entry.pools[0].color
        : entry.pools.sort((a,b) => b.stakeSol - a.stakeSol)[0].color;

      const circle = L.circleMarker([geo.lat, geo.lon], {
        radius:      r,
        fillColor:   color,
        color:       color,
        weight:      1.5,
        opacity:     0.8,
        fillOpacity: 0.45,
        interactive: true,
      });

      // Tooltip: show per-pool breakdown
      const tipLines = entry.pools
        .sort((a,b) => b.stakeSol - a.stakeSol)
        .map(p => `${p.symbol}: ${formatSol(p.stakeSol)}`)
        .join('<br>');
      circle.bindTooltip(
        `<strong style="color:${color}">${formatSol(entry.totalStake)}</strong><br>${tipLines}`,
        { direction: 'top', offset: [0, -4] }
      );

      stakeLayer.addLayer(circle);
    }

    stakeLayer.addTo(map);
  }

  // ── Filters ────────────────────────────────────────────
  function setupFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        showLoading('Filtering…');
        loadData(currentFilter);
      });
    });
  }

  // ── Loading ────────────────────────────────────────────
  function showLoading(msg) {
    const overlay = document.getElementById('loading-overlay');
    document.getElementById('loading-text').textContent = msg || 'Loading…';
    overlay.classList.remove('hidden');
  }
  function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  // ── Helpers ────────────────────────────────────────────
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function abbrev(pubkey) {
    if (!pubkey || pubkey.length < 16) return pubkey || '';
    return pubkey.slice(0, 8) + '…' + pubkey.slice(-8);
  }

  function formatSol(sol) {
    if (!sol && sol !== 0) return '—';
    if (sol >= 1_000_000) return (sol / 1_000_000).toFixed(2) + 'M SOL';
    if (sol >= 1_000)     return (sol / 1_000).toFixed(1)     + 'K SOL';
    return sol.toFixed(0) + ' SOL';
  }

  // ── Bootstrap ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupFilters();

    // ✕ close button — panel is outside the map div, so closing it
    // does NOT trigger a map click → spider stays open naturally.
    document.getElementById('node-detail-close').addEventListener('click', () => {
      document.getElementById('node-detail').classList.add('hidden');
    });

    loadData('all');
    loadStakePools();

    setInterval(() => loadData(currentFilter), REFRESH_MS);
    setInterval(loadStakePools, 15 * 60 * 1000);
  });

})();
