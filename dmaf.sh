#!/usr/bin/env bash
# =============================================================================
#  dmaf.sh — run the whole DMAF proof of concept from one terminal (macOS + Linux)
#
#    ./dmaf.sh             start everything and follow the logs; Ctrl-C stops it all
#    ./dmaf.sh status      what's running
#    ./dmaf.sh stop        stop what an earlier ./dmaf.sh started (e.g. if its terminal was closed)
#    ./dmaf.sh help
#
#  Each service runs as its own process, with its lines labelled in the terminal:
#    db     PostgreSQL     accounts + My Library   (reused if already running, e.g. brew services)
#    ipfs   IPFS (Kubo)    the files               (reused if IPFS Desktop or a daemon answers on :5001)
#    chain  Hardhat node   local Ethereum on :8545, then `npm run deploy` when its contracts are missing
#    app    dev server     http://localhost:5173   (tools/serve.mjs, same as `npm run serve`)
#  Services that were already running are left running when you stop.
#  Full logs: .data/logs/<service>.log — the terminal hides the chain's routine RPC lines and the read-only
#  eth_call reverts of MetaMask's token/NFT probes (--verbose shows all).
#
#  Options  --no-db     don't use PostgreSQL (demo sign-in)
#           --no-ipfs   don't start IPFS
#           --open      open the app in your browser once it's up
#           --verbose   show every line of every log
#  Env      DATABASE_URL (postgres://localhost:5432/dmaf) · PORT (5173) · RPC_URL (http://127.0.0.1:8545)
#           IPFS_API (http://127.0.0.1:5001) · NO_COLOR=1
#
#  Written for the bash that ships with macOS (3.2) as well as Linux bash 4/5.
# =============================================================================
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"     # started with `sh dmaf.sh` / `zsh dmaf.sh`

ROOT="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$ROOT" || exit 1
RUN="$ROOT/.data/run"
LOGS="$ROOT/.data/logs"

export PORT="${PORT:-5173}"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
export IPFS_API="${IPFS_API:-http://127.0.0.1:5001}"
export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/dmaf}"
OS="$(uname -s)"

CMD=start WITH_DB=1 WITH_IPFS=1 OPEN=0 VERBOSE=0
for a in "$@"; do
  case "$a" in
    start|stop|status|help) CMD=$a ;;
    -h|--help) CMD=help ;;
    --no-db) WITH_DB=0 ;;
    --no-ipfs) WITH_IPFS=0 ;;
    --open) OPEN=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    *) echo "Unknown option: $a — see ./dmaf.sh help"; exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' OFF=$'\033[0m' RED=$'\033[31m' GREEN=$'\033[32m'
  YELLOW=$'\033[33m' BLUE=$'\033[34m' MAGENTA=$'\033[35m' CYAN=$'\033[36m'
else
  BOLD='' DIM='' OFF='' RED='' GREEN='' YELLOW='' BLUE='' MAGENTA='' CYAN=''
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
note() { printf '%s–%s %s\n' "$DIM" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
bad()  { printf '%s✕%s %s\n' "$RED" "$OFF" "$*"; }
colour_of() {
  case "$1" in db) printf %s "$BLUE" ;; ipfs) printf %s "$CYAN" ;; chain) printf %s "$YELLOW" ;;
    deploy) printf %s "$MAGENTA" ;; app) printf %s "$GREEN" ;; esac
}
tag_of() { printf '%s%-6s%s%s│%s' "$(colour_of "$1")" "$1" "$OFF" "$DIM" "$OFF"; }
# mawk (Debian/Ubuntu's default awk) reads pipes in big blocks unless told not to: logs would show up late
AWK='awk'
if awk -W version < /dev/null 2>&1 | grep -qi mawk; then AWK="awk -W interactive"; fi

# ---------------------------------------------------------------- helpers ---
add_path() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) ;; *) PATH="$PATH:$1" ;; esac; }
tool_paths() {   # PostgreSQL / IPFS tools that aren't on PATH yet (appended: your own PATH wins)
  BREW_PREFIX=''
  if command -v brew >/dev/null 2>&1; then
    BREW_PREFIX="$(brew --prefix 2>/dev/null)"
    local v; for v in postgresql@17 postgresql@16 postgresql@15 postgresql@14 postgresql; do add_path "$BREW_PREFIX/opt/$v/bin"; done
    add_path "$BREW_PREFIX/bin"
  fi
  add_path "/Applications/Postgres.app/Contents/Versions/latest/bin"
  local d; for d in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -t/ -k4 -nr); do add_path "$d"; done
  export PATH
}

# probe rpc|ipfs|http|tcp URL — succeeds when something answers (Node does the networking: no curl needed)
probe() {
  node -e '
    const [kind, url] = process.argv.slice(1);
    const done = ok => process.exit(ok ? 0 : 1);
    setTimeout(() => done(false), 2000);
    const signal = AbortSignal.timeout(1800);
    if (kind === "tcp") {
      const u = new URL(url);
      require("net").connect(+u.port || 80, u.hostname.replace(/^\[|\]$/g, "") || "localhost")
        .on("connect", () => done(true)).on("error", () => done(false));
    } else if (kind === "rpc") {
      fetch(url, { method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
        .then(r => r.json()).then(j => done(!!j.result)).catch(() => done(false));
    } else if (kind === "ipfs") {
      fetch(url + "/api/v0/version", { method: "POST", signal }).then(r => done(r.ok)).catch(() => done(false));
    } else {
      fetch(url, { signal }).then(r => done(r.status < 500)).catch(() => done(false));
    }' "$1" "$2" >/dev/null 2>&1
}

# alive PID — running and not a zombie
alive() {
  local s; s="$(ps -p "$1" -o stat= 2>/dev/null)"
  [ -n "$s" ] || return 1
  case "$s" in *Z*) return 1 ;; *) return 0 ;; esac
}
children() { ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$1" '$2 == p { print $1 }'; }
killtree() {     # killtree PID [SIGNAL] — the process and everything it started (npm → sh → node)
  local c; for c in $(children "$1"); do killtree "$c" "$2"; done
  kill -"${2:-TERM}" "$1" 2>/dev/null
}
stop_pid() {     # stop_pid PID INT|TERM — INT for PostgreSQL (fast shutdown), TERM for the rest
  local pid=$1 i=0
  alive "$pid" || return 0
  if [ "$2" = INT ]; then kill -INT "$pid" 2>/dev/null; else killtree "$pid"; fi
  while alive "$pid" && [ $i -lt 60 ]; do sleep 0.25; i=$((i + 1)); done
  alive "$pid" && killtree "$pid" KILL
  return 0
}

# wait_for SECONDS command… — retries every ¼ s; gives up early if the service it waits for has exited
WAIT_PID=''
wait_for() {
  local tries=$(($1 * 4)) i=0; shift
  while [ $i -lt $tries ]; do
    "$@" && return 0
    if [ -n "$WAIT_PID" ] && ! alive "$WAIT_PID"; then return 1; fi
    sleep 0.25; i=$((i + 1))
  done
  return 1
}

# ------------------------------------------------- services and their logs ---
SVC_NAME=()
SVC_PID=()
SVC_SIG=()
TAIL_PIDS=()
KEPT=''

# follow NAME LOGFILE FROM-LINE — show the log in this terminal, labelled
follow() {
  local tag; tag="$(tag_of "$1")"
  ( tail -n +"$3" -F "$2" 2>/dev/null | $AWK -v tag="$tag" -v name="$1" -v verbose="$VERBOSE" -v esc=$'\033' '
      { plain = $0; gsub(esc "\\[[0-9;]*m", "", plain) }    # Hardhat colours its log even in a file
      plain ~ /^[ \t]*$/ { next }
      verbose != 1 && name == "chain" {
        # Hardhat logs every JSON-RPC call; keep transactions and blocks, drop the polling
        if (plain ~ /^(eth|net|web3|evm|hardhat|debug|wallet|personal)_[A-Za-z]+( \([0-9]+\))?$/) {
          rpc = plain; sub(/ \([0-9]+\)$/, "", rpc); buf = ""; shown = 0
          if (rpc !~ /send(Raw)?Transaction/) next
        }
        # a restarted chain that MetaMask has not caught up with (its old nonces / block numbers)
        if (plain ~ /[Ii]nvalid block tag|[Nn]once too (high|low)/ && !hinted++) {
          print tag " " $0
          print tag " → MetaMask still remembers the previous chain: MetaMask ▸ Settings ▸ Advanced ▸ Clear activity tab data"
          fflush(); next
        }
        # Details of eth_call / eth_estimateGas: read-only, nothing is sent or mined. Their reverts are mostly
        # MetaMask probing the contract it is about to call or has stored as an NFT (decimals(), symbol(),
        # tokenURI()…), which "Mpeg21ScmFactory#<unrecognized-selector> … reverted" looks like. Hidden here.
        # A reverting eth_estimateGas is shown: that transaction would fail, so the wallet will not send it.
        if (plain ~ /^[ \t]/ && (rpc == "eth_call" || rpc == "eth_estimateGas")) {
          if (shown) { print tag " " $0; fflush(); next }
          buf = buf tag " " $0 "\n"
          if (plain !~ /Error/) next
          if (rpc == "eth_estimateGas") {
            printf "%s eth_estimateGas — this transaction would revert, so it is not sent:\n%s", tag, buf
            buf = ""; shown = 1; fflush(); next
          }
          buf = ""
          if (!probes++) {
            print tag " (read-only eth_call reverts are hidden: MetaMask probes the contracts you use for tokens/NFTs;"
            print tag "  nothing is sent or mined. Transactions show as eth_sendRawTransaction. All lines: .data/logs/chain.log or --verbose)"
            fflush()
          }
          next
        }
        if (plain ~ /^(Account #|Private Key:|Accounts$|=+$|WARNING: These accounts|Any funds sent to them)/) next
        if (plain ~ /Started HTTP and WebSocket JSON-RPC server/) {
          print tag " " $0
          print tag " (20 funded test accounts — keys in README ▸ MetaMask, or .data/logs/chain.log)"
          fflush(); next
        }
      }
      { print tag " " $0; fflush() }' ) &
  TAIL_PIDS+=("$!")
}

# start_svc NAME INT|TERM command… — start a service in the background, logging to .data/logs/NAME.log
start_svc() {
  local name=$1 sig=$2; shift 2
  local log="$LOGS/$name.log"
  printf '\n===== %s  %s\n' "$(date '+%F %T')" "$*" >> "$log"
  local from=$(($(wc -l < "$log") + 1))
  follow "$name" "$log" "$from"
  "$@" < /dev/null >> "$log" 2>&1 &
  local pid=$!
  SVC_NAME+=("$name"); SVC_PID+=("$pid"); SVC_SIG+=("$sig")
  echo "$pid $sig" > "$RUN/$name.pid"
  WAIT_PID=$pid
}

STOPPING=0
cleanup() {
  [ "$STOPPING" = 1 ] && return
  STOPPING=1
  trap '' INT TERM HUP
  printf '\n%sStopping…%s\n' "$BOLD" "$OFF"
  local i=$((${#SVC_NAME[@]} - 1))
  while [ $i -ge 0 ]; do                       # reverse order: app, chain, ipfs, db
    stop_pid "${SVC_PID[$i]}" "${SVC_SIG[$i]}"
    rm -f "$RUN/${SVC_NAME[$i]}.pid"
    note "${SVC_NAME[$i]} stopped"
    i=$((i - 1))
  done
  sleep 0.3
  local t; for t in "${TAIL_PIDS[@]}"; do killtree "$t"; done
  rm -f "$RUN/dmaf.pid"
  [ -n "$KEPT" ] && note "left running (they were already up before ./dmaf.sh):$KEPT"
  exit "${1:-0}"
}
fatal() {        # fatal NAME MESSAGE — show the end of the service's log and stop everything
  sleep 0.4
  bad "$2 — last lines of .data/logs/$1.log:"
  tail -n 15 "$LOGS/$1.log" 2>/dev/null | sed 's/^/    /'
  cleanup 1
}

# ------------------------------------------------------------- PostgreSQL ---
DB_HOST='' DB_PORT='' DB_NAME='' DB_ADMIN_URL='' DB_PID='' DB_STATE='' DB_EXTERNAL=0 DB_OK=0
parse_db_url() {
  local out
  out="$(node -e '
    const u = new URL(process.argv[1]);
    if (!/^postgres(ql)?:$/.test(u.protocol)) process.exit(1);
    const admin = new URL(u.href); admin.pathname = "/postgres";
    console.log([u.hostname || "localhost", u.port || "5432", decodeURIComponent(u.pathname.slice(1)) || "dmaf", admin.href].join("\n"));
  ' "$DATABASE_URL" 2>/dev/null)" || return 1
  { read -r DB_HOST; read -r DB_PORT; read -r DB_NAME; read -r DB_ADMIN_URL; } <<EOF
$out
EOF
}
db_ready() {
  # pg_isready with the URL's user and the always-present "postgres" database, so the server doesn't log
  # 'database "<you>" does not exist' every time we check
  if command -v pg_isready >/dev/null 2>&1; then pg_isready -q -d "$DB_ADMIN_URL" >/dev/null 2>&1
  else probe tcp "postgres://$DB_HOST:$DB_PORT"; fi
}
pg_hint() {
  if [ "$OS" = Darwin ]; then echo "brew install postgresql@16"
  else echo "sudo apt install postgresql (Debian/Ubuntu) or sudo dnf install postgresql-server (Fedora)"; fi
}
# Which PostgreSQL to start: Homebrew's own data directory (macOS), Postgres.app, or else
# a data directory just for DMAF in .data/postgres with whichever `postgres` is installed.
find_postgres() {
  PG_BIN='' PG_DATA='' PG_HOW=''
  if [ -n "$BREW_PREFIX" ]; then
    local v data
    for v in postgresql@17 postgresql@16 postgresql@15 postgresql@14 postgresql; do
      data="$BREW_PREFIX/var/$v"; [ "$v" = postgresql ] && data="$BREW_PREFIX/var/postgres"
      if [ -x "$BREW_PREFIX/opt/$v/bin/postgres" ] && [ -f "$data/PG_VERSION" ]; then
        PG_BIN="$BREW_PREFIX/opt/$v/bin" PG_DATA="$data" PG_HOW=brew; return 0
      fi
    done
  fi
  if [ "$OS" = Darwin ] && [ -d /Applications/Postgres.app ]; then PG_HOW=app; return 0; fi
  if command -v postgres >/dev/null 2>&1 && command -v initdb >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v postgres)")" PG_DATA="$ROOT/.data/postgres" PG_HOW=project
  fi
}
db_start() {
  if [ "$WITH_DB" != 1 ]; then unset DATABASE_URL; DB_STATE="off (--no-db) — demo sign-in"; return; fi
  if ! parse_db_url; then warn "DATABASE_URL isn't a postgres:// URL ($DATABASE_URL) — demo sign-in"; unset DATABASE_URL; DB_STATE="bad DATABASE_URL"; return; fi
  if db_ready; then DB_STATE="already running at $DB_HOST:$DB_PORT"; KEPT="$KEPT db"; DB_OK=1; return; fi
  case "$DB_HOST" in localhost|127.0.0.1|::1|\[::1\]) ;;
    *) warn "PostgreSQL at $DB_HOST:$DB_PORT isn't answering, and this script only starts a local one — demo sign-in"
       unset DATABASE_URL; DB_STATE="not answering at $DB_HOST:$DB_PORT"; return ;;
  esac
  find_postgres
  if [ "$PG_HOW" = app ]; then
    open -ga Postgres; DB_EXTERNAL=1; KEPT="$KEPT db"; DB_STATE="Postgres.app (opened)"; return
  fi
  if [ -z "$PG_HOW" ]; then
    warn "PostgreSQL isn't installed — $(pg_hint). Using demo sign-in (or run with --no-db)."
    unset DATABASE_URL; DB_STATE="not installed — demo sign-in"; return
  fi
  if [ "$(id -u)" = 0 ]; then
    warn "PostgreSQL won't run as root — run ./dmaf.sh as your normal user, or start PostgreSQL yourself. Using demo sign-in."
    unset DATABASE_URL; DB_STATE="can't start as root — demo sign-in"; return
  fi
  if [ ! -f "$PG_DATA/PG_VERSION" ]; then
    say "Creating a PostgreSQL data directory for DMAF in .data/postgres (once)…"
    mkdir -p "$PG_DATA"
    if ! "$PG_BIN/initdb" -D "$PG_DATA" -U "$(id -un)" --auth=trust -E UTF8 >> "$LOGS/db.log" 2>&1; then
      bad "initdb failed — see .data/logs/db.log. Using demo sign-in."; unset DATABASE_URL; DB_STATE="initdb failed"; return
    fi
  fi
  start_svc db INT "$PG_BIN/postgres" -D "$PG_DATA" -p "$DB_PORT" -k /tmp -c listen_addresses=localhost
  DB_PID=$WAIT_PID
  case "$PG_HOW" in brew) DB_STATE="started (Homebrew's data directory)" ;; *) DB_STATE="started (.data/postgres)" ;; esac
}
db_wait() {
  if [ -n "$DB_PID" ]; then
    WAIT_PID=$DB_PID
    wait_for 30 db_ready || fatal db "PostgreSQL didn't start"
    DB_OK=1
  elif [ "$DB_EXTERNAL" = 1 ]; then
    WAIT_PID=''
    if wait_for 30 db_ready; then DB_OK=1; else warn "Postgres.app didn't answer on $DB_HOST:$DB_PORT — start a server in it"; DB_STATE="Postgres.app isn't answering"; fi
  fi
  [ "$DB_OK" = 1 ] && ensure_database
}
ensure_database() {     # create the database the first time (the dev server creates the tables)
  command -v psql >/dev/null 2>&1 || return 0
  local err
  if ! err="$(psql "$DB_ADMIN_URL" -tAc 'select 1' 2>&1 >/dev/null)"; then
    warn "PostgreSQL is running, but DATABASE_URL can't sign in: ${err%%$'\n'*}"
    if [ "$OS" != Darwin ]; then
      say "    Linux: give your user a role, e.g.  sudo -u postgres createuser --superuser $(id -un)"
      say "    and, for password sign-in, put it in the URL: DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/$DB_NAME"
    else
      say "    Put the user (and password) in the URL: DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/$DB_NAME"
    fi
    DB_STATE="$DB_STATE · can't sign in (see above)"
    return 0
  fi
  case "$DB_NAME" in *[!A-Za-z0-9_-]*) return 0 ;; esac
  if [ "$(psql "$DB_ADMIN_URL" -tAc "select 1 from pg_database where datname = '$DB_NAME'" 2>/dev/null)" != 1 ]; then
    if psql "$DB_ADMIN_URL" -qc "create database \"$DB_NAME\"" >/dev/null 2>&1; then ok "created the database $DB_NAME"
    else warn "couldn't create the database $DB_NAME — run: createdb $DB_NAME"; fi
  fi
}

# ------------------------------------------------------------------- IPFS ---
IPFS_PID='' IPFS_STATE='' IPFS_EXTERNAL=0
ipfs_hint() {
  if [ "$OS" = Darwin ]; then echo "brew install ipfs, or install IPFS Desktop"
  else echo "install Kubo: https://docs.ipfs.tech/install/command-line/"; fi
}
ipfs_start() {
  if [ "$WITH_IPFS" != 1 ]; then IPFS_STATE="not started (--no-ipfs)"; return; fi
  if probe ipfs "$IPFS_API"; then IPFS_STATE="already running at $IPFS_API"; KEPT="$KEPT ipfs"; return; fi
  if command -v ipfs >/dev/null 2>&1; then
    if [ ! -f "${IPFS_PATH:-$HOME/.ipfs}/config" ]; then
      say "Setting up an IPFS repository (ipfs init, once)…"
      ipfs init >> "$LOGS/ipfs.log" 2>&1 || { bad "ipfs init failed — see .data/logs/ipfs.log"; IPFS_STATE="ipfs init failed"; return; }
    fi
    start_svc ipfs TERM ipfs daemon
    IPFS_PID=$WAIT_PID IPFS_STATE="started"
  elif [ "$OS" = Darwin ] && [ -d "/Applications/IPFS Desktop.app" ]; then
    open -ga "IPFS Desktop"; IPFS_EXTERNAL=1; KEPT="$KEPT ipfs"; IPFS_STATE="IPFS Desktop (opened)"
  else
    warn "IPFS isn't running or installed — $(ipfs_hint). Discover and plays work; publishing needs it."
    IPFS_STATE="not installed"
  fi
}
ipfs_wait() {
  if [ -n "$IPFS_PID" ]; then
    WAIT_PID=$IPFS_PID
    wait_for 60 probe ipfs "$IPFS_API" || fatal ipfs "IPFS didn't start"
  elif [ "$IPFS_EXTERNAL" = 1 ]; then
    WAIT_PID=''
    wait_for 60 probe ipfs "$IPFS_API" || { warn "IPFS Desktop didn't answer on $IPFS_API yet"; IPFS_STATE="IPFS Desktop (not answering yet)"; }
  fi
}

# ------------------------------------------------------------ Hardhat chain ---
CHAIN_PID='' CHAIN_STATE=''
chain_start() {
  if probe rpc "$RPC_URL"; then CHAIN_STATE="already running at $RPC_URL"; KEPT="$KEPT chain"; return; fi
  start_svc chain TERM "$ROOT/node_modules/.bin/hardhat" node
  CHAIN_PID=$WAIT_PID CHAIN_STATE="started (a new, empty chain)"
}
contracts_missing() {   # true when js/chain-config.js's registry has no code on the running chain
  node -e '
    const fs = require("fs"); let cfg;
    try { const t = fs.readFileSync("js/chain-config.js", "utf8"); cfg = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); }
    catch { process.exit(0); }
    fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [cfg.address, "latest"] }) })
      .then(r => r.json()).then(j => process.exit(j.result && j.result !== "0x" ? 1 : 0)).catch(() => process.exit(0));
  ' "$RPC_URL" >/dev/null 2>&1
}
chain_wait() {
  if [ -n "$CHAIN_PID" ]; then
    WAIT_PID=$CHAIN_PID
    wait_for 120 probe rpc "$RPC_URL" || fatal chain "The Hardhat chain didn't start"
  fi
  WAIT_PID=''
  if [ -n "$CHAIN_PID" ] || contracts_missing; then
    say "$(tag_of deploy) npm run deploy"
    local tag; tag="$(tag_of deploy)"
    # (compiler warnings from the CEL contracts are only in the log, unless --verbose)
    npm run deploy 2>&1 | tee -a "$LOGS/deploy.log" | $AWK -v tag="$tag" -v verbose="$VERBOSE" '
      /^[ \t]*$/ || /^> / { next }
      verbose != 1 && /: Warning: / { skip = 2; next }
      verbose != 1 && skip > 0 { skip--; next }
      { print tag " " $0; fflush() }'
    [ "${PIPESTATUS[0]}" = 0 ] || { bad "npm run deploy failed (see above, and .data/logs/deploy.log)"; cleanup 1; }
    CHAIN_STATE="$CHAIN_STATE · contracts deployed"
  else
    CHAIN_STATE="$CHAIN_STATE · contracts already deployed"
  fi
}

# -------------------------------------------------------------- dev server ---
app_start() {
  start_svc app TERM node "$ROOT/tools/serve.mjs"
  wait_for 30 probe http "http://127.0.0.1:$PORT/" || fatal app "The dev server didn't start"
  WAIT_PID=''
}

# ------------------------------------------------------------------ start ---
preflight() {
  command -v node >/dev/null 2>&1 || { bad "Node.js isn't installed — https://nodejs.org (version 18 or newer)"; exit 1; }
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  [ "${major:-0}" -ge 18 ] 2>/dev/null || { bad "Node.js $(node -v) is too old — DMAF needs 18 or newer"; exit 1; }
  command -v npm >/dev/null 2>&1 || { bad "npm isn't installed (it comes with Node.js)"; exit 1; }
  if [ ! -x node_modules/.bin/hardhat ] || [ ! -d node_modules/ethers ] || [ ! -d node_modules/pg ]; then
    say "Installing the npm packages (npm install, once)…"
    npm install || { bad "npm install failed"; exit 1; }
  fi
}
start_cmd() {
  mkdir -p "$RUN" "$LOGS"
  if [ -f "$RUN/dmaf.pid" ] && alive "$(cat "$RUN/dmaf.pid")"; then
    bad "./dmaf.sh is already running (pid $(cat "$RUN/dmaf.pid")) — use that terminal, or ./dmaf.sh stop"; exit 1
  fi
  preflight
  tool_paths
  if probe tcp "http://127.0.0.1:$PORT"; then
    bad "Port $PORT is already in use — is \`npm run serve\` still running in another terminal? Stop it (Ctrl-C there), or use another port: PORT=5174 ./dmaf.sh"
    exit 1
  fi
  echo $$ > "$RUN/dmaf.pid"
  trap 'cleanup 0' INT
  trap 'cleanup 143' TERM
  trap 'cleanup 129' HUP

  say "${BOLD}DMAF${OFF} · $ROOT"
  chain_start; db_start; ipfs_start           # start what isn't running, in parallel…
  db_wait; ipfs_wait; chain_wait              # …then wait for each, and deploy if needed
  app_start

  say ""
  say "${BOLD}DMAF is running → http://localhost:$PORT${OFF}"
  say "  $(tag_of db) $DB_STATE"
  say "  $(tag_of ipfs) $IPFS_STATE"
  say "  $(tag_of chain) $CHAIN_STATE"
  say "  $(tag_of app) started · full logs in .data/logs/"
  if [ -n "$CHAIN_PID" ]; then
    warn "New chain: assets and agreements from an earlier chain are gone — reload the app (the Studio starts fresh), then publish again. MetaMask needs no reset: the test accounts start at new nonces."
  fi
  local kept=''; [ -n "$KEPT" ] && kept="; already-running services (${KEPT# }) are left alone"
  say "${DIM}Ctrl-C stops what this script started$kept.${OFF}"
  say ""
  if [ "$OPEN" = 1 ]; then
    if [ "$OS" = Darwin ]; then open "http://localhost:$PORT"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT" >/dev/null 2>&1 & fi
  fi

  while :; do                                 # stop everything if one of our services dies
    local i=0
    while [ $i -lt ${#SVC_NAME[@]} ]; do
      alive "${SVC_PID[$i]}" || fatal "${SVC_NAME[$i]}" "${SVC_NAME[$i]} stopped unexpectedly"
      i=$((i + 1))
    done
    sleep 1
  done
}

# -------------------------------------------------------------- status/stop ---
pattern_of() { case "$1" in db) echo postgres ;; ipfs) echo ipfs ;; chain) echo hardhat ;; app) echo serve.mjs ;; esac; }
started_by_script() {
  local f name pid sig
  for f in "$RUN"/*.pid; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .pid)"; [ "$name" = dmaf ] && continue
    read -r pid sig < "$f"
    if alive "$pid" && ps -p "$pid" -o command= 2>/dev/null | grep -q "$(pattern_of "$name")"; then echo "$name $pid $sig"; fi
  done
}
status_cmd() {
  tool_paths
  parse_db_url >/dev/null 2>&1
  if probe rpc "$RPC_URL"; then
    if contracts_missing; then warn "chain   $RPC_URL — contracts not deployed (npm run deploy)"; else ok "chain   $RPC_URL · contracts deployed"; fi
  else bad "chain   not answering at $RPC_URL"; fi
  if [ -n "$DB_HOST" ] && db_ready; then ok "db      PostgreSQL at $DB_HOST:$DB_PORT"; else bad "db      PostgreSQL not answering${DB_HOST:+ at $DB_HOST:$DB_PORT}"; fi
  if probe ipfs "$IPFS_API"; then ok "ipfs    $IPFS_API"; else bad "ipfs    not answering at $IPFS_API"; fi
  if probe http "http://127.0.0.1:$PORT/"; then ok "app     http://localhost:$PORT"; else bad "app     nothing on port $PORT"; fi
  local mine; mine="$(started_by_script | awk '{ printf " %s", $1 }')"
  if [ -f "$RUN/dmaf.pid" ] && alive "$(cat "$RUN/dmaf.pid")"; then
    note "./dmaf.sh is running (pid $(cat "$RUN/dmaf.pid")) and started:${mine:- nothing}"
  elif [ -n "$mine" ]; then note "left over from an earlier ./dmaf.sh:$mine (./dmaf.sh stop)"; fi
}
stop_cmd() {
  local any=0 sp i=0
  if [ -f "$RUN/dmaf.pid" ] && alive "$(cat "$RUN/dmaf.pid")"; then
    sp="$(cat "$RUN/dmaf.pid")"
    say "Asking ./dmaf.sh (pid $sp) to stop…"
    kill -TERM "$sp" 2>/dev/null
    while alive "$sp" && [ $i -lt 120 ]; do sleep 0.25; i=$((i + 1)); done
    any=1
  fi
  local name pid sig
  while read -r name pid sig; do
    [ -n "$name" ] || continue
    stop_pid "$pid" "$sig"; ok "$name stopped"; any=1
  done <<EOF
$(started_by_script)
EOF
  rm -f "$RUN"/*.pid
  [ "$any" = 1 ] && ok "Stopped." || note "Nothing started by ./dmaf.sh is running."
}

case "$CMD" in
  start) start_cmd ;;
  status) status_cmd ;;
  stop) stop_cmd ;;
  help) sed -n '2,/^# ====/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^====/d' ;;
esac
