# DMAF documentation

| Guide | For |
|---|---|
| [EDITING-TEXT.md](EDITING-TEXT.md) | Changing any wording in the app: where each screen's text lives, how to edit it safely, when it shows up |
| [DATABASE.md](DATABASE.md) | PostgreSQL setup, what needs signing in, sign-in (email/password and MetaMask), My Library's IPFS files, tables and API |
| [STEMS-AND-IMAF.md](STEMS-AND-IMAF.md) | The Studio's stem route: ffmpeg / MP4Box packaging, the IMAF boxes, the asset page's stem visualiser |
| [../README.md](../README.md) | Running the proof of concept: chain, IPFS, MetaMask, payments, contracts |
| [../mpeg21/CONFORMANCE.md](../mpeg21/CONFORMANCE.md) | ISO/IEC 21000-23 conformance: how DMAF matches and differs from the reference software |

## Everything you run

| Command | What it does |
|---|---|
| `./dmaf.sh` | Starts PostgreSQL, IPFS, the chain (+ deploy) and the app in one terminal; Ctrl-C stops them (`status`, `stop`, `--open`) |
| `npm install` | Installs the packages (Hardhat, ethers, the PostgreSQL driver, the MCO parser's libraries) |
| `npm run chain` | Local Ethereum (Hardhat) on :8545 |
| `npm run deploy` | Deploys the contracts, writes `js/chain-config.js` |
| `ipfs daemon` (or IPFS Desktop) | IPFS node on :5001 / :8080 |
| `npm run serve` | The app on http://localhost:5173 + the dev server's APIs; prints a ✓/✕ line per service |
| `npm run verify:payouts` | Checks on-chain that every paid play moved the right ETH to each wallet (`-- 3` for one asset, `-- 0x…` for one transaction) |
| `npm run db:migrate` | Creates/upgrades the PostgreSQL tables and reports them (needs `DATABASE_URL`) |
| `npm run templates` | Regenerates the Studio's use-case templates (`js/mco-templates.js`) |
| `npm test` | Contracts, ISO/IEC 21000-23 conformance, IMAF and sign-in tests |
| `npm run cel` | MPEG-21 CEL Server (optional, first `npm run cel:setup`) |

Optional tools on your Mac: `brew install ffmpeg` (needed for the stem route), `brew install gpac` (MP4Box),
`brew install postgresql@16` (accounts and My Library's IPFS files).
