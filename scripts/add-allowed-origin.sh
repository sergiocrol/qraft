#!/bin/bash

# Add a browser Origin (e.g. your new Netlify site) to the S3 assets-bucket CORS
# so the frontend can fetch generated images for download from the new domain.
#
# Usage:
#   scripts/add-allowed-origin.sh https://your-site.netlify.app
#
# The bucket is read from apps/api/.env (S3_BUCKET_NAME) unless S3_BUCKET_NAME is
# already exported in the environment. Region comes from AWS_REGION (default
# eu-west-1). The operation is idempotent — re-running with an origin that is
# already present is a no-op.
#
# This updates ONLY the S3 bucket CORS. You must ALSO allow the origin on the
# API: append it to ALLOWED_ORIGINS in apps/api/.env and run `make deploy-api`.

set -euo pipefail

ORIGIN="${1:?Usage: add-allowed-origin.sh <https://origin>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${S3_BUCKET_NAME:-}" ] && [ -f "$ROOT/apps/api/.env" ]; then
    S3_BUCKET_NAME="$(grep '^S3_BUCKET_NAME=' "$ROOT/apps/api/.env" | cut -d= -f2- || true)"
fi
: "${S3_BUCKET_NAME:?Set S3_BUCKET_NAME (or add it to apps/api/.env)}"
REGION="${AWS_REGION:-eu-west-1}"

echo "Bucket: $S3_BUCKET_NAME ($REGION)"
echo "Adding CORS origin: $ORIGIN"

# Read the current CORS config; fall back to an empty rule set if the bucket has
# no CORS configuration yet.
current="$(aws s3api get-bucket-cors --bucket "$S3_BUCKET_NAME" --region "$REGION" 2>/dev/null || echo '{"CORSRules":[]}')"

updated="$(ORIGIN="$ORIGIN" CURRENT="$current" python3 <<'PY'
import json, os, sys
origin = os.environ["ORIGIN"]
data = json.loads(os.environ["CURRENT"])
rules = data.get("CORSRules") or [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedOrigins": [],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000,
}]
changed = False
for rule in rules:
    origins = rule.setdefault("AllowedOrigins", [])
    if origin not in origins:
        origins.append(origin)
        changed = True
sys.stderr.write("added\n" if changed else "already present — no change\n")
print(json.dumps({"CORSRules": rules}))
PY
)"

aws s3api put-bucket-cors --bucket "$S3_BUCKET_NAME" --region "$REGION" \
    --cors-configuration "$updated"

echo "✅ S3 bucket CORS updated for $ORIGIN"
echo "⚠️  Next: add $ORIGIN to ALLOWED_ORIGINS in apps/api/.env, then run: make deploy-api"
