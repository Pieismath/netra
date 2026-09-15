#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Netra — pf firewall setup  (run once, needs sudo)
#
# What this does:
#   1. Detects the Mac's Internet Sharing bridge interface (bridge100)
#   2. Writes pf anchor rules that:
#        • Redirect DNS  (:53  → :5300) so all domain lookups hit our DNS server
#        • Redirect HTTP (:80  → :8888) so all HTTP hits our payment portal
#        • Block all other outbound traffic from hotspot clients by default
#        • Allow paid clients (table <allowed_clients>) full internet access
#   3. Loads the rules into pf
#
# Usage:
#   sudo ./setup-pf.sh
#
# After running this, start the portal server with:
#   node server.js      (no sudo needed)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root (sudo ./setup-pf.sh)"
  exit 1
fi

SOLANA_RPC_URL="${SOLANA_RPC:-https://api.devnet.solana.com}"
RPC_HOST="$(printf '%s\n' "$SOLANA_RPC_URL" | sed -E 's#^[a-zA-Z]+://([^/:]+).*#\1#')"
PHANTOM_HOST="phantom.app"
EXTRA_ALLOW_HOSTS="${EXTRA_PREPAY_ALLOW_HOSTS:-}"
ALLOW_HOSTS="${RPC_HOST:-api.devnet.solana.com},${PHANTOM_HOST}${EXTRA_ALLOW_HOSTS:+,${EXTRA_ALLOW_HOSTS}}"
ALLOW_IPS=""

echo "Resolving wallet/RPC allowlist..."
for host in $(printf '%s\n' "$ALLOW_HOSTS" | tr ',' ' '); do
  [ -n "$host" ] || continue
  echo "  allow $host"
  resolved=$(dscacheutil -q host -a name "$host" 2>/dev/null | awk '/ip_address:/{print $2}' | sort -u || true)
  if [ -z "$resolved" ]; then
    resolved=$(dig +short "$host" A 2>/dev/null | sort -u || true)
  fi
  if [ -n "$resolved" ]; then
    while IFS= read -r ip; do
      [ -n "$ip" ] || continue
      ALLOW_IPS="${ALLOW_IPS}${ALLOW_IPS:+, }$ip"
    done <<EOF
$resolved
EOF
  fi
done

# ── Detect interface and IP ───────────────────────────────────────────────────

BRIDGE=""
PORTAL_IP=""

bridge_info() {
  ifconfig "$1" 2>/dev/null || true
}

bridge_ip() {
  printf '%s\n' "$1" | awk '/inet /{print $2; exit}'
}

bridge_status() {
  printf '%s\n' "$1" | awk '/status:/{print $2; exit}'
}

bridge_members() {
  printf '%s\n' "$1" | awk -F': ' '/member:/ {print $2}' | awk '{print $1}' | tr '\n' ',' | sed 's/,$//'
}

probe_ip() {
  # Quick ping (1 packet, 1s timeout) to confirm the IP is bound and the
  # interface is actually up on this host. macOS ping(8): -W is in ms, -t in s.
  ping -c 1 -W 1000 -t 2 "$1" >/dev/null 2>&1
}

# Allow operator to short-circuit auto-detection when there are multiple
# bridges or when the heuristic guesses wrong on a particular Mac.
if [ -n "${BRIDGE_IF_OVERRIDE:-}" ]; then
  info=$(bridge_info "$BRIDGE_IF_OVERRIDE")
  if [ -z "$info" ]; then
    echo "ERROR: BRIDGE_IF_OVERRIDE='$BRIDGE_IF_OVERRIDE' — interface does not exist."
    exit 1
  fi
  ip=$(bridge_ip "$info")
  if [ -z "$ip" ]; then
    echo "ERROR: BRIDGE_IF_OVERRIDE='$BRIDGE_IF_OVERRIDE' has no IPv4 address."
    exit 1
  fi
  BRIDGE="$BRIDGE_IF_OVERRIDE"
  PORTAL_IP="$ip"
  echo "Using BRIDGE_IF_OVERRIDE=$BRIDGE → $PORTAL_IP"
else
  echo "Scanning network interfaces..."

  CAND_IFACES=()
  CAND_IPS=()
  CAND_MEMBERS=()

  for iface in $(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep '^bridge' | sort -u); do
    [ -n "$iface" ] || continue
    info=$(bridge_info "$iface")
    [ -n "$info" ] || continue

    ip=$(bridge_ip "$info")
    status=$(bridge_status "$info")
    members=$(bridge_members "$info")

    echo "  $iface → ${ip:-no IP} (${status:-unknown}) members=[${members:-none}]"

    [ -n "$ip" ] || continue
    [ "$status" = "active" ] || continue

    if probe_ip "$ip"; then
      CAND_IFACES+=("$iface")
      CAND_IPS+=("$ip")
      CAND_MEMBERS+=("${members:-none}")
    else
      echo "    skipped: ping to $ip failed (interface not carrying traffic)"
    fi
  done

  case "${#CAND_IFACES[@]}" in
    0)
      echo ""
      echo "ERROR: No active bridge interface with a reachable IP found."
      echo ""
      echo "All interfaces on this machine:"
      ifconfig -l | tr ' ' '\n'
      echo ""
      echo "Troubleshooting:"
      echo "  1. Make sure Internet Sharing is ON in System Settings → General → Sharing"
      echo "  2. Make sure Wi-Fi is checked in 'To devices using'"
      echo "  3. Try toggling Internet Sharing OFF then ON again"
      echo "  4. If you see a bridge interface above with no IP, run:"
      echo "       sudo ifconfig <bridgeX> 192.168.3.1 netmask 255.255.255.0 up"
      echo "     then re-run this script."
      echo "  5. If detection is wrong, force a specific bridge with:"
      echo "       sudo BRIDGE_IF_OVERRIDE=bridgeX ./setup-pf.sh"
      echo ""
      exit 1
      ;;
    1)
      BRIDGE="${CAND_IFACES[0]}"
      PORTAL_IP="${CAND_IPS[0]}"
      ;;
    *)
      echo ""
      echo "ERROR: Multiple active bridge interfaces — cannot disambiguate:"
      for i in "${!CAND_IFACES[@]}"; do
        echo "  ${CAND_IFACES[$i]} → ${CAND_IPS[$i]}  members=[${CAND_MEMBERS[$i]}]"
      done
      echo ""
      echo "Re-run with an explicit choice:"
      echo "  sudo BRIDGE_IF_OVERRIDE=<iface> ./setup-pf.sh"
      echo ""
      exit 1
      ;;
  esac
fi

echo "Bridge interface : $BRIDGE"
echo "Portal IP        : $PORTAL_IP"
HOTSPOT_SUBNET="${PORTAL_IP%.*}.0/24"
echo "Hotspot subnet   : $HOTSPOT_SUBNET"

# ── Write NAT anchor (redirect rules) ─────────────────────────────────────────

NAT_ANCHOR="/etc/pf.anchors/hotspotdex-nat"
ALLOW_HTTPS_BYPASS=""
if [ -n "$ALLOW_IPS" ]; then
  ALLOW_HTTPS_BYPASS="no rdr on $BRIDGE proto tcp from any to { $ALLOW_IPS } port 443"
fi

cat > "$NAT_ANCHOR" << EOF
# Netra NAT anchor — redirect rules

# Paid clients: bypass ALL redirects so they can browse freely.
# Uses a separate table name (paid_bypass) to avoid pf namespace collision
# with the <allowed_clients> table already defined in the filter anchor.
# The portal server adds/removes IPs here via:
#   pfctl -a hotspotdex-nat -t paid_bypass -T add <ip>
table <paid_bypass> persist
no rdr on $BRIDGE from <paid_bypass>

$([ -n "$ALLOW_HTTPS_BYPASS" ] && printf '%s\n' "# Keep Phantom + Solana RPC reachable before payment so wallet handoff and transaction broadcast are not captive-trapped.")
$ALLOW_HTTPS_BYPASS

# Redirect DNS queries from hotspot clients to our DNS server (no-root port)
rdr pass on $BRIDGE proto udp from any to any port 53 -> $PORTAL_IP port 5300

# Redirect ALL HTTP (port 80) to our portal server.
# This must include traffic destined for PORTAL_IP itself because our DNS
# resolves every domain to PORTAL_IP — so the iPhone's HTTP request to
# captive.apple.com already has destination PORTAL_IP:80.
rdr pass on $BRIDGE proto tcp from any to any port 80 -> $PORTAL_IP port 8888

# Redirect ALL HTTPS (port 443) to our HTTPS portal server.
# iOS 14+ and macOS probe https://captive.apple.com — without this redirect
# the TLS handshake times out and the device may suppress the captive portal popup.
rdr pass on $BRIDGE proto tcp from any to any port 443 -> $PORTAL_IP port 8443
EOF

echo "Written: $NAT_ANCHOR"

# ── Write filter anchor ────────────────────────────────────────────────────────

FILTER_ANCHOR="/etc/pf.anchors/hotspotdex"

WALLET_TABLE=""
WALLET_RULES=""
if [ -n "$ALLOW_IPS" ]; then
  WALLET_TABLE="table <wallet_allow_hosts> const { $ALLOW_IPS }"
WALLET_RULES=$(cat <<EOF
# Allow only Phantom + Solana payment connectivity for unpaid users.
pass quick inet proto tcp from <hotspot_net> to <wallet_allow_hosts> port 443 keep state
pass quick inet proto udp from <hotspot_net> to <wallet_allow_hosts> port 443 keep state
EOF
)
fi

cat > "$FILTER_ANCHOR" << EOF
# Netra filter anchor
#
# Table of devices that have paid — populated dynamically by the portal server
# via: pfctl -a hotspotdex -t allowed_clients -T add <ip>
table <allowed_clients> persist
table <portal_host>     const { $PORTAL_IP }
table <hotspot_net>     const { $HOTSPOT_SUBNET }
$WALLET_TABLE

# Allow DHCP so devices can get an IP address
pass in quick on $BRIDGE proto udp from <hotspot_net> port 68 to any port 67 keep state

# Unpaid devices must stay on IPv4 so they cannot bypass the captive redirects.
block drop quick inet6 from <hotspot_net> to any
block drop quick inet6 from any to <hotspot_net>

# Allow traffic to the portal server itself (payment page + control API).
# These rules are the only unpaid paths out of the hotspot network.
pass quick inet proto tcp from <hotspot_net> to <portal_host> port { 8443, 8888, 3001, 3000 } keep state
pass quick inet proto udp from <hotspot_net> to <portal_host> port 5300 keep state
$WALLET_RULES

# Allow paid clients full outbound internet
pass quick inet from <allowed_clients> to any keep state
pass quick inet from any to <allowed_clients> keep state

# Block everything else from unpaid hotspot clients everywhere, not just on
# bridge0. This prevents a joined device from roaming freely before payment.
block return quick inet from <hotspot_net> to any
block drop   quick inet from any to <hotspot_net>
EOF

echo "Written: $FILTER_ANCHOR"

# ── Patch /etc/pf.conf ────────────────────────────────────────────────────────

PF_CONF="/etc/pf.conf"
PF_CONF_NEW="/etc/pf.conf.new"
NETRA_BACKUP="/etc/pf.conf.netra-backup-$(date +%s)"
PF_VALIDATE_ERR="/tmp/netra-pfctl-validate.err"

if grep -q "hotspotdex" "$PF_CONF" 2>/dev/null; then
  echo "pf.conf already contains Netra anchors — rewriting with validation"
fi

# Always create a timestamped backup before touching anything. Keep the
# legacy backup name as well so teardown-pf.sh continues to work.
if [ -f "$PF_CONF" ]; then
  cp "$PF_CONF" "$NETRA_BACKUP"
  echo "Backup: $NETRA_BACKUP"
  cp "$PF_CONF" "${PF_CONF}.hotspotdex.bak"
fi

# Stage a clean, known-good pf.conf with Netra anchors in the correct
# position (rdr-anchor after nat-anchor "com.apple/*", filter anchor after
# the com.apple anchor block). Write to a sibling file first so we can
# validate before swapping — if validation fails the live pf.conf is
# untouched and the staged file is left for inspection.
cat > "$PF_CONF_NEW" << PFEOF
#
# Default PF configuration file.
#
# This file contains the main ruleset, which gets automatically loaded
# at startup.  PF will not be automatically enabled, however.  Instead,
# each component which utilizes PF is responsible for enabling and disabling
# PF via -E and -X as documented in pfctl(8).  That will ensure that PF
# is disabled only when the last enable reference is released.
#
# Care must be taken to ensure that the main ruleset does not get flushed,
# as the nested anchors rely on the anchor point defined here. In addition,
# to the anchors loaded by this file, some system services would dynamically
# insert anchors into the main ruleset. These anchors will be added only when
# the system service is used and would removed on termination of the service.
#
# See pf.conf(5) for syntax.
#

#
# com.apple anchor point
#
scrub-anchor "com.apple/*"
nat-anchor "com.apple/*"
rdr-anchor "com.apple/*"
rdr-anchor "hotspotdex-nat"
load anchor "hotspotdex-nat" from "$NAT_ANCHOR"
dummynet-anchor "com.apple/*"
anchor "com.apple/*"
load anchor "com.apple" from "/etc/pf.anchors/com.apple"
anchor "hotspotdex"
load anchor "hotspotdex" from "$FILTER_ANCHOR"
PFEOF

# Parse-only validation. pfctl -nf checks syntax and rule semantics
# without loading anything into the kernel. If this fails, /etc/pf.conf
# is still the previous (working) version.
if ! pfctl -nf "$PF_CONF_NEW" 2>"$PF_VALIDATE_ERR"; then
  echo ""
  echo "ERROR: pf.conf validation failed. /etc/pf.conf is unchanged."
  echo "Staged file left at $PF_CONF_NEW for inspection."
  echo "pfctl errors:"
  sed 's/^/  /' "$PF_VALIDATE_ERR"
  exit 1
fi
rm -f "$PF_VALIDATE_ERR"

# Atomic swap on the same filesystem.
mv "$PF_CONF_NEW" "$PF_CONF"
echo "Written: $PF_CONF (validated)"

# ── Enable pf and reload rules ────────────────────────────────────────────────

pfctl -e 2>/dev/null && echo "pf enabled" || echo "pf was already enabled"
PF_LOAD_ERR="/tmp/netra-pfctl-load.err"
if pfctl -f "$PF_CONF" 2>"$PF_LOAD_ERR"; then
  echo "pf rules loaded"
  rm -f "$PF_LOAD_ERR"
else
  echo ""
  echo "ERROR: pf rules failed to load (file passed validation but kernel rejected them):"
  sed 's/^/  /' "$PF_LOAD_ERR"
  exit 1
fi

# ── Verify ────────────────────────────────────────────────────────────────────

echo ""
echo "Current Netra anchor rules:"
pfctl -a hotspotdex -sr 2>/dev/null || echo "(anchor not yet populated — starts when portal server runs)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  pf setup complete!"
echo "  Bridge : $BRIDGE  ($PORTAL_IP)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next: run the portal server (no sudo needed):"
echo "  cd captive-portal && node server.js"
echo ""
