#!/usr/bin/env bash
# Runs ON the EC2 instance (invoked by GitHub Actions through SSM Run Command):
#   deploy.sh <image-tag> <deploy-bucket> <aws-region> <ssm-path>
# 1. downloads this release's compose.prod.yml + Caddyfile from the deploy bucket,
# 2. renders .env from SSM Parameter Store,
# 3. pulls images from ECR and restarts the stack,
# 4. waits until https://$OPENGLASS_DOMAIN/health answers 200 on this host.
set -euo pipefail

IMAGE_TAG="${1:?image tag}"
DEPLOY_BUCKET="${2:?deploy bucket}"
AWS_REGION="${3:?aws region}"
SSM_PATH="${4:?ssm path, e.g. /openglass/prod}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

ROOT=/opt/openglass
RELEASE="$ROOT/releases/$IMAGE_TAG"
mkdir -p "$RELEASE"
cd "$RELEASE"

aws s3 cp --only-show-errors "s3://$DEPLOY_BUCKET/releases/$IMAGE_TAG/compose.prod.yml" compose.prod.yml
aws s3 cp --only-show-errors "s3://$DEPLOY_BUCKET/releases/$IMAGE_TAG/Caddyfile" Caddyfile

# .env from SSM: every parameter under $SSM_PATH becomes NAME='value'. In Compose's dotenv
# format single-quoted values are literal ($, #, \ kept) except \' for a quote.
umask 077
aws ssm get-parameters-by-path --path "$SSM_PATH" --recursive --with-decryption --output json \
  | python3 -c '
import json, sys
Q, B = chr(39), chr(92)
for p in json.load(sys.stdin)["Parameters"]:
    name, value = p["Name"].rsplit("/", 1)[-1], p["Value"]
    if chr(10) in value or value.endswith(B) or B + Q in value:
        sys.exit(p["Name"] + ": newline, trailing backslash or backslash-quote cannot be written to .env")
    print(name + "=" + Q + value.replace(Q, B + Q) + Q)
' > .env
umask 022
for required in MONGODB_URI OPENGLASS_DOMAIN ACME_EMAIL S3_BUCKET KMS_KEY_ID; do
  grep -q "^$required=" .env || { echo "missing SSM parameter $SSM_PATH/$required" >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export ECR_REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
export IMAGE_TAG
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null

compose() { docker compose --project-name openglass -f compose.prod.yml --env-file .env "$@"; }
compose pull --quiet
compose up -d --remove-orphans --wait --wait-timeout 300
ln -sfn "$RELEASE" "$ROOT/current"

DOMAIN="$(sed -n "s/^OPENGLASS_DOMAIN='\(.*\)'$/\1/p" .env)"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health"; then
    echo
    echo "deployed $IMAGE_TAG"
    # Keep the last 5 releases and prune images no container uses.
    # shellcheck disable=SC2012 # release dirs are image tags (git SHAs)
    ls -1dt "$ROOT"/releases/* | tail -n +6 | xargs -r rm -rf
    docker image prune -af --filter "until=168h" >/dev/null || true
    exit 0
  fi
  sleep 5
done
echo "health check failed for $IMAGE_TAG" >&2
compose ps >&2
compose logs --tail 50 api caddy >&2
exit 1
