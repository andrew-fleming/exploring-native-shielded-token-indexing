#!/usr/bin/env bash
# Compile the ShieldedFungibleToken contract from source with the normal
# `compact compile` command.
#
# The committed sources in contracts/ are stored flat, but their imports assume a
# structured closure:
#   ShieldedFungibleToken.compact  ->  ../openzeppelin/ShieldedERC20
#   ShieldedERC20.compact          ->  ./Utils
# so we stage them into that layout under build/src, then run compact on it.
#
# Usage:
#   bash scripts/compile.sh                 # full build (TS + zkir + proving keys; minutes)
#   bash scripts/compile.sh --skip-zk       # fast: TS + zkir only, no proving keys
#   COMPILER_VERSION=0.31.0 bash scripts/compile.sh
#
# Output goes to build/ShieldedFungibleToken (git-ignored). To use a rebuild at
# runtime, point ZK_CONFIG_PATH (in src/reproduce.ts / src/hidden-burn.ts) at it,
# or copy it over artifacts/shielded-token/ShieldedFungibleToken.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

COMPILER_VERSION="${COMPILER_VERSION:-0.31.0}" # matches the vendored artifacts
STAGE="build/src"
TARGET="build/ShieldedFungibleToken"

echo "[compile] staging flat contracts/ into the structured closure under $STAGE ..."
mkdir -p "$STAGE/shielded-token" "$STAGE/openzeppelin"
cp contracts/ShieldedFungibleToken.compact "$STAGE/shielded-token/"
cp contracts/ShieldedERC20.compact "$STAGE/openzeppelin/"
cp contracts/Utils.compact "$STAGE/openzeppelin/"

# Drop a literal "--" that `pnpm compile -- <flags>` forwards, so flags like
# --skip-zk reach compact directly.
flags=()
for a in "$@"; do [ "$a" = "--" ] || flags+=("$a"); done

set -x
compact compile "+$COMPILER_VERSION" ${flags[@]+"${flags[@]}"} \
  "$STAGE/shielded-token/ShieldedFungibleToken.compact" \
  "$TARGET"
{ set +x; } 2>/dev/null

echo "[compile] done -> $TARGET"
echo "[compile] to use it: point ZK_CONFIG_PATH at $TARGET, or copy it over"
echo "[compile]            artifacts/shielded-token/ShieldedFungibleToken"
