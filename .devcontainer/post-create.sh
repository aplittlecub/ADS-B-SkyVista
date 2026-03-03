#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="."
if [[ -f "package.json" ]]; then
  PROJECT_DIR="."
elif [[ -f "Flight-Card/package.json" ]]; then
  PROJECT_DIR="Flight-Card"
else
  echo "No package.json found in workspace root."
  exit 1
fi

cd "${PROJECT_DIR}"

# Prefer lockfile installs; fall back to install if the lockfile is stale/corrupt.
if ! npm ci --include=dev; then
  npm install --include=dev
fi
