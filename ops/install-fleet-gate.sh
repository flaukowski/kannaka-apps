#!/bin/sh
# install-fleet-gate.sh — migrate a fleet node's daily memory gate from the
# hand-rolled kannaka-hdl memory-gate.sh cron to the store's preflight app.
#
# Idempotent: clones or fast-forwards /home/opc/kannaka-apps, then rewrites
# the 04:45 gate cron line to run the preflight app via the khdl-app runner
# (which pins recall env itself). The old kannaka-hdl-gate files are left in
# place for rollback.
#
#   KANNAKA_HDL_BIN   kannaka-hdl binary   (default: /usr/local/bin/kannaka-hdl)
#   KANNAKA_BIN       kannaka binary       (REQUIRED — node-specific, e.g.
#                                           /usr/local/bin/kannaka on O2,
#                                           /home/opc/.local/bin/kannaka on O1/O3)
#   APPS_DIR          store checkout       (default: /home/opc/kannaka-apps)
#   CRON_TIME         cron schedule        (default: "45 4 * * *")

set -eu

HDL="${KANNAKA_HDL_BIN:-/usr/local/bin/kannaka-hdl}"
KAN="${KANNAKA_BIN:?set KANNAKA_BIN to this node's kannaka binary}"
DIR="${APPS_DIR:-/home/opc/kannaka-apps}"
WHEN="${CRON_TIME:-45 4 * * *}"

command -v node >/dev/null || { echo "node is required (>=20.11)"; exit 1; }

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone https://github.com/flaukowski/kannaka-apps.git "$DIR"
fi

LINE="$WHEN KANNAKA_HDL_BIN=$HDL KANNAKA_BIN=$KAN node $DIR/runtime/khdl-app.mjs run $DIR/apps/preflight >> \$HOME/.kannaka/khdl-app-cron.log 2>&1"

# Replace the old memory-gate cron (and any prior preflight line) with the new one.
( crontab -l 2>/dev/null | grep -v -e "memory-gate.sh" -e "khdl-app.mjs run .*preflight" ; echo "$LINE" ) | crontab -

echo "installed: $LINE"
echo "verify now with:"
echo "  KANNAKA_HDL_BIN=$HDL KANNAKA_BIN=$KAN node $DIR/runtime/khdl-app.mjs run $DIR/apps/preflight"
