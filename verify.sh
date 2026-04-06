#!/bin/bash
#
# verify.sh — Verify that the deployed TX Web Wallet matches this source code.
#
# Usage:
#   git clone https://github.com/EpicLoop365/Ledger-TX-Only.git
#   cd Ledger-TX-Only
#   ./verify.sh
#
# This will build the project and compute a SHA-256 hash of the output.
# Compare the hash to what's shown in the wallet UI footer.

set -e

echo ""
echo "  TX Web Wallet — Build Verification"
echo "  ==================================="
echo ""

# Show commit
COMMIT=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)
echo "  Git commit:  $COMMIT_SHORT ($COMMIT)"
echo ""

# Install deps
echo "  Installing dependencies..."
npm ci --silent

# Build
echo "  Building..."
npx tsc -b && npx vite build 2>/dev/null

# Hash
echo "  Computing build hash..."
node scripts/hash-build.mjs

echo ""
echo "  Compare the hash above with the one shown in the wallet UI."
echo "  If they match, the deployed code is identical to this source."
echo ""
