#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MANUAL app deploy (no GitHub / no CI). Run in AWS CloudShell AFTER you've
# pushed both images to ECR with the same <tag> (see infra/README.md →
# "Deploy without GitHub").
#
# It renders the prod compose with your image refs, zips the EB source bundle
# (preserving the prebuild hook's executable bit — important!), uploads it,
# and rolls the Elastic Beanstalk environment to it.
#
# Usage:
#   PROJECT=cellready ENV=dev REGION=us-east-2 ./scripts/deploy_bundle.sh <tag>
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT="${PROJECT:-cellready}"
ENV="${ENV:-dev}"
REGION="${REGION:-us-east-2}"
TAG="${1:?usage: deploy_bundle.sh <image-tag> (same tag you pushed to ECR)}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "${REGION}")"
REG="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
BACKEND_IMAGE="${REG}/${PROJECT}/backend:${TAG}"
FRONTEND_IMAGE="${REG}/${PROJECT}/frontend:${TAG}"
ARTIFACTS="${PROJECT}-eb-artifacts-${ACCOUNT}-${ENV}"
APP="${PROJECT}-${ENV}"
EBENV="${PROJECT}-${ENV}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Rendering bundle for tag ${TAG}"
WORK="$(mktemp -d)"
sed -e "s|\${BACKEND_IMAGE}|${BACKEND_IMAGE}|g" \
    -e "s|\${FRONTEND_IMAGE}|${FRONTEND_IMAGE}|g" \
    "${ROOT}/deploy/docker-compose.yml" > "${WORK}/docker-compose.yml"
cp -r "${ROOT}/deploy/.platform" "${WORK}/.platform"
chmod +x "${WORK}"/.platform/hooks/prebuild/*.sh

( cd "${WORK}" && zip -r -y bundle.zip docker-compose.yml .platform >/dev/null )

KEY="bundle/${TAG}.zip"
echo "==> Uploading s3://${ARTIFACTS}/${KEY}"
aws s3 cp "${WORK}/bundle.zip" "s3://${ARTIFACTS}/${KEY}" --region "${REGION}"

echo "==> Creating application version + deploying"
aws elasticbeanstalk create-application-version --region "${REGION}" \
  --application-name "${APP}" --version-label "${TAG}" \
  --source-bundle "S3Bucket=${ARTIFACTS},S3Key=${KEY}" --auto-create-application
aws elasticbeanstalk update-environment --region "${REGION}" \
  --environment-name "${EBENV}" --version-label "${TAG}"

echo "==> Deploying. Poll status with:"
echo "    aws elasticbeanstalk describe-environments --environment-names ${EBENV} \\"
echo "      --query 'Environments[0].[Status,Health]' --output text --region ${REGION}"
rm -rf "${WORK}"
