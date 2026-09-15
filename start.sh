#!/usr/bin/env bash
# Netra — start the Solana-first hotspot demo stack
# Usage: ./start.sh [--no-captive]

set -e

NVM_NODE="$HOME/.nvm/versions/node/v24.13.1/bin"
if [ -d "$NVM_NODE" ]; then
  export PATH="$NVM_NODE:$PATH"
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found. Install Node.js >= 18 first."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROXY="$ROOT/proxy-server"
FRONTEND="$ROOT/frontend"
PORTAL="$ROOT/captive-portal"

CAPTIVE_MODE=true
for arg in "$@"; do
  [ "$arg" = "--no-captive" ] && CAPTIVE_MODE=false
done

# ── Run-scoped paths ─────────────────────────────────────────────────────────

NETRA_TS="$(date +%s)"
PROXY_PID_FILE="/tmp/netra-proxy.pid"
PORTAL_PID_FILE="/tmp/netra-portal.pid"
FRONTEND_PID_FILE="/tmp/netra-frontend.pid"
PROXY_LOG="/tmp/netra-proxy-${NETRA_TS}.log"
PORTAL_LOG="/tmp/netra-portal-${NETRA_TS}.log"
FRONTEND_LOG="/tmp/netra-frontend-${NETRA_TS}.log"

# ── Stale PID cleanup ────────────────────────────────────────────────────────

# A PID file from a previous run may still exist. If the process behind it
# is alive, refuse to start (would clobber the running instance). If it's
# gone, just remove the stale file.
check_stale_pid() {
  local label="$1"
  local pidfile="$2"
  [ -f "$pidfile" ] || return 0
  local pid
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "ERROR: $label is already running (pid $pid, $pidfile)."
    echo "  Stop the previous run first, or remove $pidfile if it is stale."
    exit 1
  fi
  rm -f "$pidfile"
}

check_stale_pid "proxy"    "$PROXY_PID_FILE"
check_stale_pid "frontend" "$FRONTEND_PID_FILE"
check_stale_pid "portal"   "$PORTAL_PID_FILE"

# ── Graceful shutdown ────────────────────────────────────────────────────────

PF_LOADED=false
SHUTTING_DOWN=false
TAIL_PID=""

cleanup() {
  $SHUTTING_DOWN && return 0
  SHUTTING_DOWN=true

  # Don't let an inner failure short-circuit the rest of cleanup.
  set +e

  echo ""
  echo "Shutting down..."

  # 1. Send SIGTERM to spawned services.
  for pidfile in "$PROXY_PID_FILE" "$PORTAL_PID_FILE" "$FRONTEND_PID_FILE"; do
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile" 2>/dev/null || true)
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done

  # 2. Wait up to 10s for them to flush.
  for _ in $(seq 1 20); do
    any_alive=false
    for pidfile in "$PROXY_PID_FILE" "$PORTAL_PID_FILE" "$FRONTEND_PID_FILE"; do
      [ -f "$pidfile" ] || continue
      pid=$(cat "$pidfile" 2>/dev/null || true)
      [ -n "$pid" ] || continue
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=true
        break
      fi
    done
    $any_alive || break
    sleep 0.5
  done

  # 3. Force-kill anything still alive and remove PID files.
  for pidfile in "$PROXY_PID_FILE" "$PORTAL_PID_FILE" "$FRONTEND_PID_FILE"; do
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done

  # 4. Clear our pf anchors and restore /etc/pf.conf so we don't leave
  #    stale rules behind (unpaid clients getting free internet, or worse,
  #    the host's own traffic getting blackholed).
  if $PF_LOADED; then
    echo "Flushing Netra pf anchors..."
    sudo pfctl -a hotspotdex     -F all 2>/dev/null || true
    sudo pfctl -a hotspotdex-nat -F all 2>/dev/null || true

    LATEST_BACKUP=$(ls -t /etc/pf.conf.netra-backup-* 2>/dev/null | head -n 1)
    if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
      echo "Restoring /etc/pf.conf from $LATEST_BACKUP"
      sudo cp "$LATEST_BACKUP" /etc/pf.conf 2>/dev/null || true
      sudo pfctl -f /etc/pf.conf 2>/dev/null || true
    fi
  fi

  # 5. Stop the log tailer if it's still around.
  if [ -n "$TAIL_PID" ]; then
    kill "$TAIL_PID" 2>/dev/null || true
  fi

  echo "Done."
}
trap cleanup INT TERM HUP EXIT

# ── Dependency install ───────────────────────────────────────────────────────

DIRS="$PROXY $FRONTEND"
$CAPTIVE_MODE && DIRS="$DIRS $PORTAL"

for dir in $DIRS; do
  if [ ! -d "$dir/node_modules" ]; then
    echo "Installing deps in $dir..."
    (cd "$dir" && npm install --silent)
  fi
done

# ── Environment ──────────────────────────────────────────────────────────────

export HOTSPOT_NAME="${HOTSPOT_NAME:-Netra Test Account}"
export HOTSPOT_SSID="${HOTSPOT_SSID:-⚡Netra-Guest}"
export HOTSPOT_LISTING_ID="${HOTSPOT_LISTING_ID:-local-hotspot}"
export RATE_PER_MIN="${RATE_PER_MIN:-0.001}"
export HOTSPOT_DOWN="${HOTSPOT_DOWN:-100}"
export HOTSPOT_UP="${HOTSPOT_UP:-50}"
export HOTSPOT_SIGNAL="${HOTSPOT_SIGNAL:-4}"
export HOTSPOT_LOCATION="${HOTSPOT_LOCATION:-Philadelphia, PA · Demo hotspot}"
export HOST_HANDLE="${HOST_HANDLE:-Netra Test Account}"

export SOLANA_WALLET="${SOLANA_WALLET:-}"
export SOLANA_RPC="${SOLANA_RPC:-https://api.devnet.solana.com}"
export SECURE_PORTAL_ORIGIN="${SECURE_PORTAL_ORIGIN:-https://captive.apple.com}"
# Demo burner wallet — server signs + broadcasts the Solana tx automatically.
# Fund this address with devnet SOL before the demo.
# Burner pubkey: 6Hvij4HAnHJuSR6tg52mBWzJiFGFEd5rD2cpYFUf86gu
export DEMO_BUYER_PRIVKEY="${DEMO_BUYER_PRIVKEY:-5QiujvJwA4htB1eUqYYmbeKu42fScJ6JSAnKimTzLPkbSNDFpdYK7RrWJPWnGeKnEFWuVpPCCmBUbaFHrA1cWUpm}"
# Default the refund signer to the funded demo burner so early-disconnect
# refunds actually broadcast on devnet (self-transfer is valid on Solana).
export SOLANA_REFUND_SECRET_KEY="${SOLANA_REFUND_SECRET_KEY:-$DEMO_BUYER_PRIVKEY}"
export EXTRA_PREPAY_ALLOW_HOSTS="${EXTRA_PREPAY_ALLOW_HOSTS:-}"

export FILECOIN_NETWORK="${FILECOIN_NETWORK:-calibration}"
export FILECOIN_RPC_URL="${FILECOIN_RPC_URL:-}"
export FILECOIN_PRIVATE_KEY="${FILECOIN_PRIVATE_KEY:-}"
export FILECOIN_WITH_CDN="${FILECOIN_WITH_CDN:-false}"
export FILECOIN_SOURCE="${FILECOIN_SOURCE:-netra}"

# ── Launch services ──────────────────────────────────────────────────────────

echo "[1/3] Starting proxy server on :8080 (control API :3001)..."
echo "      log: $PROXY_LOG"
(cd "$PROXY" && \
  HOTSPOT_NAME="$HOTSPOT_NAME" \
  HOTSPOT_SSID="$HOTSPOT_SSID" \
  HOTSPOT_LISTING_ID="$HOTSPOT_LISTING_ID" \
  RATE_PER_MIN="$RATE_PER_MIN" \
  HOTSPOT_DOWN="$HOTSPOT_DOWN" \
  HOTSPOT_UP="$HOTSPOT_UP" \
  HOTSPOT_SIGNAL="$HOTSPOT_SIGNAL" \
  HOTSPOT_LOCATION="$HOTSPOT_LOCATION" \
  HOST_HANDLE="$HOST_HANDLE" \
  SOLANA_WALLET="$SOLANA_WALLET" \
  SOLANA_RPC="$SOLANA_RPC" \
  SOLANA_REFUND_SECRET_KEY="$SOLANA_REFUND_SECRET_KEY" \
  FILECOIN_NETWORK="$FILECOIN_NETWORK" \
  FILECOIN_RPC_URL="$FILECOIN_RPC_URL" \
  FILECOIN_PRIVATE_KEY="$FILECOIN_PRIVATE_KEY" \
  FILECOIN_WITH_CDN="$FILECOIN_WITH_CDN" \
  FILECOIN_SOURCE="$FILECOIN_SOURCE" \
  node server.js) > "$PROXY_LOG" 2>&1 &
PROXY_PID=$!
echo "$PROXY_PID" > "$PROXY_PID_FILE"

echo "[2/3] Starting Next.js frontend on :3000..."
echo "      log: $FRONTEND_LOG"
(cd "$FRONTEND" && npm run dev) > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$FRONTEND_PID_FILE"

PORTAL_PID=""
if $CAPTIVE_MODE; then
  echo "[3/3] Loading pf firewall rules (sudo required)..."
  # pf load failure must be fatal — if pf silently fails, unpaid clients
  # get free internet. Capture stderr instead of dropping it.
  PF_ERR="/tmp/netra-pfctl-${NETRA_TS}.err"

  sudo pfctl -e 2>/dev/null || true
  if ! sudo pfctl -f /etc/pf.conf 2>"$PF_ERR"; then
    echo "ERROR: failed to reload /etc/pf.conf:"
    sed 's/^/  /' "$PF_ERR"
    echo ""
    echo "Did you run 'sudo ./captive-portal/setup-pf.sh' first?"
    exit 1
  fi

  if ! sudo pfctl -a hotspotdex-nat -f /etc/pf.anchors/hotspotdex-nat 2>"$PF_ERR"; then
    echo "ERROR: failed to load NAT redirect anchor (/etc/pf.anchors/hotspotdex-nat):"
    sed 's/^/  /' "$PF_ERR"
    exit 1
  fi
  echo "pf NAT redirect rules loaded."

  if ! sudo pfctl -a hotspotdex -f /etc/pf.anchors/hotspotdex 2>"$PF_ERR"; then
    echo "ERROR: failed to load filter anchor (/etc/pf.anchors/hotspotdex):"
    sed 's/^/  /' "$PF_ERR"
    exit 1
  fi
  echo "pf filter rules loaded."
  rm -f "$PF_ERR"

  PF_LOADED=true

  echo "Starting captive portal (DNS :5300, HTTP :8888)..."
  echo "      log: $PORTAL_LOG"
  (cd "$PORTAL" && \
    HOTSPOT_NAME="$HOTSPOT_NAME" \
    HOTSPOT_SSID="$HOTSPOT_SSID" \
    HOTSPOT_LISTING_ID="$HOTSPOT_LISTING_ID" \
    RATE_PER_MIN="$RATE_PER_MIN" \
    HOTSPOT_DOWN="$HOTSPOT_DOWN" \
    HOTSPOT_UP="$HOTSPOT_UP" \
    HOTSPOT_SIGNAL="$HOTSPOT_SIGNAL" \
    HOTSPOT_LOCATION="$HOTSPOT_LOCATION" \
    SOLANA_WALLET="$SOLANA_WALLET" \
    SOLANA_RPC="$SOLANA_RPC" \
    SECURE_PORTAL_ORIGIN="$SECURE_PORTAL_ORIGIN" \
    EXTRA_PREPAY_ALLOW_HOSTS="$EXTRA_PREPAY_ALLOW_HOSTS" \
    DEMO_BUYER_PRIVKEY="$DEMO_BUYER_PRIVKEY" \
    CONTROL_API="http://localhost:3001" \
    node server.js) > "$PORTAL_LOG" 2>&1 &
  PORTAL_PID=$!
  echo "$PORTAL_PID" > "$PORTAL_PID_FILE"
fi

# ── Health checks ────────────────────────────────────────────────────────────

# Poll each service's health endpoint up to 30s. We declare ready only when
# every expected service responds 2xx — otherwise list what's missing and
# exit so the operator doesn't think things are running when they aren't.
HC_NAMES=("proxy"    "frontend")
HC_URLS=( "http://localhost:3001/health" "http://localhost:3000/" )
HC_PIDS=( "$PROXY_PID" "$FRONTEND_PID" )
if $CAPTIVE_MODE; then
  HC_NAMES+=("portal")
  HC_URLS+=("http://localhost:8888/config")
  HC_PIDS+=("$PORTAL_PID")
fi

echo ""
echo "Waiting for services to come up (up to 30s)..."

ALL_OK=false
FAILED_NAMES=""
for _ in $(seq 1 60); do
  ALL_OK=true
  FAILED_NAMES=""
  for i in "${!HC_NAMES[@]}"; do
    name="${HC_NAMES[$i]}"
    url="${HC_URLS[$i]}"
    pid="${HC_PIDS[$i]}"
    # If a service has already died, no point polling further.
    if ! kill -0 "$pid" 2>/dev/null; then
      ALL_OK=false
      FAILED_NAMES="$FAILED_NAMES $name(exited)"
      continue
    fi
    if ! curl -sf -o /dev/null --max-time 2 "$url"; then
      ALL_OK=false
      FAILED_NAMES="$FAILED_NAMES $name"
    fi
  done
  $ALL_OK && break
  sleep 0.5
done

if ! $ALL_OK; then
  echo ""
  echo "ERROR: services failed to come up within 30s. Not ready:$FAILED_NAMES"
  echo "Logs:"
  echo "  proxy    $PROXY_LOG"
  echo "  frontend $FRONTEND_LOG"
  $CAPTIVE_MODE && echo "  portal   $PORTAL_LOG"
  exit 1
fi

# ── Status banner ────────────────────────────────────────────────────────────

LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Netra ready"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Marketplace   →  http://localhost:3000/marketplace"
echo "  Host setup    →  http://localhost:3000/host"
echo "  Dashboard     →  http://localhost:3000/dashboard"
echo "  Control API   →  http://localhost:3001/health"
echo "  x402 spec     →  http://localhost:3001/x402/spec"
echo "  Proxy gate    →  http://localhost:8080"
if $CAPTIVE_MODE; then
  PORTAL_IP=$(
    for iface in bridge100 bridge101 bridge0; do
      info=$(ifconfig "$iface" 2>/dev/null || true)
      ip=$(printf '%s\n' "$info" | awk '/inet /{print $2; exit}')
      status=$(printf '%s\n' "$info" | awk '/status:/{print $2; exit}')
      if [ -n "$ip" ] && [ "$status" = "active" ]; then
        printf '%s\n' "$ip"
        break
      fi
    done
  )
  PORTAL_IP="${PORTAL_IP:-192.168.3.1}"
  echo "  ──────────────────────────────────────────"
  echo "  SSID          →  $HOTSPOT_SSID"
  echo "  Portal URL    →  http://$PORTAL_IP:8888"
  if [ "$SECURE_PORTAL_ORIGIN" != "https://captive.apple.com" ]; then
    echo "  Secure checkout →  $SECURE_PORTAL_ORIGIN"
    if [ -n "$EXTRA_PREPAY_ALLOW_HOSTS" ]; then
      echo "  Prepay allowlist →  $EXTRA_PREPAY_ALLOW_HOSTS"
    fi
  fi
  echo "  Solana RPC    →  $SOLANA_RPC"
  if [ -n "$SOLANA_WALLET" ]; then
    echo "  Solana wallet →  ${SOLANA_WALLET:0:8}…"
  else
    echo "  Solana wallet →  (not set — run: SOLANA_WALLET=<address> ./start.sh)"
  fi
  if [ -n "$DEMO_BUYER_PRIVKEY" ]; then
    echo "  Demo auto-pay →  ENABLED (burner: 6Hvij4HAnHJuSR6tg52mBWzJiFGFEd5rD2cpYFUf86gu)"
  fi
  if [ -n "$SOLANA_REFUND_SECRET_KEY" ]; then
    echo "  Refund signer →  custom"
  else
    echo "  Refund signer →  Netra demo treasury (devnet auto-top-up)"
  fi
  if [ -n "$FILECOIN_PRIVATE_KEY" ]; then
    echo "  Filecoin      →  Synapse enabled on $FILECOIN_NETWORK"
  else
    echo "  Filecoin      →  local CID mode (set FILECOIN_PRIVATE_KEY for Synapse uploads)"
  fi
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  SETUP (one-time):"
echo "  1. Mac: System Settings → Sharing → Internet Sharing"
echo "  2. Configure WiFi name to: $HOTSPOT_SSID"
echo "  3. Run: sudo ./captive-portal/setup-pf.sh"
echo ""
echo "  Optional agent demo:"
echo "    cd proxy-server && SOLANA_SECRET_KEY='[...]' node scripts/x402-demo.js"
echo ""
echo "  Press Ctrl+C to stop everything"
echo ""

LOG_FILES="$PROXY_LOG $FRONTEND_LOG"
$CAPTIVE_MODE && LOG_FILES="$LOG_FILES $PORTAL_LOG"
tail -f $LOG_FILES &
TAIL_PID=$!

WAIT_PIDS="$PROXY_PID $FRONTEND_PID"
$CAPTIVE_MODE && WAIT_PIDS="$WAIT_PIDS $PORTAL_PID"
wait $WAIT_PIDS
