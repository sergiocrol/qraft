#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

BUCKET_NAME="${BUCKET_NAME:?Error: BUCKET_NAME environment variable is required}"
REGION="${AWS_REGION:-eu-west-1}"

echo "🚀 Building and deploying Astro site..."
echo "======================================="

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

# Upload assets with long cache. Only content-hashed files (_astro/*) may be
# cached for a year — styles/* is served from a stable URL, so a long TTL
# leaves browsers on stale CSS until they hard-refresh.
echo "📤 Uploading assets..."
aws s3 sync ./dist/ s3://"$BUCKET_NAME" \
    --delete \
    --cache-control "public, max-age=31536000" \
    --exclude "*.html" \
    --exclude "*.json" \
    --exclude "styles/*"

# Upload HTML + un-hashed files with short cache
echo "📤 Uploading HTML files..."
aws s3 sync ./dist/ s3://"$BUCKET_NAME" \
    --delete \
    --cache-control "public, max-age=0, must-revalidate" \
    --exclude "*" \
    --include "*.html" \
    --include "*.json" \
    --include "styles/*"

echo "✅ Files uploaded successfully!"

# Get URLs
S3_URL="http://$BUCKET_NAME.s3-website-$REGION.amazonaws.com"
echo ""
echo "🎉 Deployment Complete!"
echo "======================="
echo "S3 Website URL: $S3_URL"

echo ""
echo "💡 Your updated Astro site is now live!"