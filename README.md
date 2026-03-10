# Solana Validator Map

A live world map dashboard showing all Solana mainnet validator and RPC nodes, their geographic distribution, stake, and liquid staking pool memberships.

![Solana Validator Map](https://img.shields.io/badge/Solana-mainnet-9945FF?logo=solana)
![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js)

## Features

- **Live network data** — polls `getClusterNodes` + `getVoteAccounts` every 5 minutes (~5100+ nodes)
- **World map** — Leaflet.js with MarkerCluster, dark-themed OpenStreetMap tiles
- **Node filters** — All Nodes / Validators Only / RPC Only
- **Validator metadata** — names, icons, and websites from the on-chain Solana Config program
- **Stake pool overlay** — shows jitoSOL, bSOL, laineSOL, and mSOL delegations as log-scale circles on the map
- **Node detail panel** — click any node to see pubkey, stake, commission, version, location, IP, and pool memberships
- **Stats sidebar** — top countries, client version breakdown, total/validator/RPC/delinquent counts
- **99.9% geo coverage** — ~5160 of 5163 nodes successfully geolocated

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express (no build step) |
| GeoIP | `geoip-lite` 1.4.10 (pinned for Node 22 compatibility) |
| Map | Leaflet.js 1.9.4 + MarkerCluster 1.5.3 (CDN) |
| Tiles | OpenStreetMap |
| Frontend | Vanilla HTML/CSS/JS |

## Getting Started

```bash
git clone git@github.com:danpaul000/validator-map.git
cd validator-map
npm install
node server.js
```

Then open http://localhost:3000

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |

Using a private RPC endpoint is recommended — the public endpoint rate-limits `getProgramAccounts` (used to fetch validator metadata).

```bash
SOLANA_RPC_URL=https://your-rpc-endpoint.com node server.js
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/nodes` | All nodes with geo, stake, and validator info |
| `GET /api/nodes?type=validators` | Validators only |
| `GET /api/nodes?type=rpc` | RPC nodes only |
| `GET /api/stakepools` | Stake pool validator lists and delegations |
| `GET /api/stats` | Aggregate stats (countries, versions, totals) |
| `GET /api/health` | Cache status and uptime |

## Project Structure

```
validator-map/
├── server.js               # Express server + API routes
├── src/
│   ├── solana.js           # getClusterNodes + getVoteAccounts
│   ├── geoip.js            # IP extraction + geoip-lite lookup
│   ├── stats.js            # Country/version aggregation
│   ├── cache.js            # In-memory cache + refresh scheduler
│   ├── validatorinfo.js    # Validator metadata from Config program
│   └── stakepools.js       # jitoSOL/bSOL/laineSOL/mSOL parsing
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Cache Refresh Intervals

| Data | Interval | Notes |
|------|----------|-------|
| Node list | 5 min | Fast — two RPC calls |
| Validator info | 30 min | Slow — `getProgramAccounts` on Config program |
| Stake pools | 15 min | Fetches 4 pool accounts |

## Implementation Notes

- Validator info accounts use a 1-byte compact key count prefix (not bincode u64 or borsh u32), with the identity pubkey at byte offset 34 and JSON starting at byte 75
- Stake in lamports from RPC is divided by 1e9 before storing
- Dark map tile effect uses a CSS filter on `.leaflet-layer` only (not `#map`, which would darken markers)
- MarkerCluster uses `addLayers(batch)` with `chunkedLoading: true` for performance
