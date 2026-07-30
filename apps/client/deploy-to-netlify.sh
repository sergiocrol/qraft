#!/bin/bash

# Deploy the built Astro site to Netlify (free static hosting).
#
# One-time setup (interactive, do it once from apps/client/):
#   npx netlify-cli login          # opens a browser to authenticate
#   npx netlify-cli init           # creates/links a site; pick the *.netlify.app name
#
# After that, `make deploy-client-netlify` (or running this script) publishes.
#
# CI / non-interactive: export NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID and the
# CLI will use them instead of the local .netlify/ link + browser login.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
    # Exports PUBLIC_API_URL so the Astro build bakes the prod API URL into the
    # bundle (same mechanism deploy-to-s3.sh relies on).
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

echo "🚀 Building and deploying Astro site to Netlify..."
echo "=================================================="

# Build the project first
echo "🔨 Building the project..."
pnpm run build

echo "✅ Build completed successfully!"

# Check if dist folder exists (should exist after build, but good to verify)
if [ ! -d "./dist" ]; then
    echo "❌ No dist/ folder found after build. Something went wrong."
    exit 1
fi

echo "✅ Found dist/ folder with built files"

# Netlify deploys are atomic and content-addressed, so there is no stale-asset
# problem to work around (unlike the S3 + long-TTL setup) — one command ships
# the whole dist/ and flips the live version once the upload finishes.
echo "📤 Uploading to Netlify (production)..."
# --no-build: this script already built dist/ above; skip Netlify's own build
# pipeline (which, when a site has a UI build command from `netlify init`, would
# rebuild AND resolve --dir relative to the repo root instead of apps/client).
# Absolute --dir removes any base-directory ambiguity.
npx netlify-cli deploy --prod --no-build --dir "$SCRIPT_DIR/dist"

echo ""
echo "🎉 Deployment Complete!"
echo "======================="
echo "💡 Remember: the *.netlify.app origin must be present in the API's"
echo "   ALLOWED_ORIGINS (apps/api/.env, then 'make deploy-api') and in the"
echo "   S3 assets bucket CORS (scripts/add-allowed-origin.sh) or downloads and"
echo "   API calls will be blocked by CORS."
