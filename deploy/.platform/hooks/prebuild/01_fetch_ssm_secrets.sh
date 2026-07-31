#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# EB prebuild hook (Docker-Compose platform, Amazon Linux 2023).
#
# Runs on the instance during every deploy, BEFORE `docker compose up`. It:
#   1. Reads SecureString secrets from SSM Parameter Store and writes them as
#      KEY=value lines into ./.env so docker compose can interpolate ${VAR}.
#   2. Logs in to ECR so compose can pull the private backend/frontend images.
#
# Secrets never appear in the EB console or in CloudFormation — only in SSM,
# decrypted here at deploy time via the instance role.
#
# IMPORTANT: keep this file +x and LF line endings (see infra/README.md).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

EB_GET_CONFIG=/opt/elasticbeanstalk/bin/get-config

REGION="$("$EB_GET_CONFIG" environment -k AWS_REGION 2>/dev/null || true)"
PREFIX="$("$EB_GET_CONFIG" environment -k SSM_PARAM_PREFIX 2>/dev/null || true)"
REGION="${REGION:-us-east-2}"
PREFIX="${PREFIX:-/cellready/dev/}"

APP_DIR="$(pwd)"   # /var/app/staging during prebuild
ENV_FILE="${APP_DIR}/.env"

echo "[prebuild] fetching SSM secrets from ${PREFIX} (region ${REGION})"

# Pull every parameter under the prefix and emit `NAME=value`.
# --with-decryption returns the plaintext of SecureString params.
: > "${ENV_FILE}"
aws ssm get-parameters-by-path \
  --path "${PREFIX}" \
  --with-decryption \
  --recursive \
  --region "${REGION}" \
  --query 'Parameters[].[Name,Value]' \
  --output text \
| while IFS=$'\t' read -r name value; do
    # Last path segment is the env var name, e.g. /cellready/dev/SECRET_KEY → SECRET_KEY
    key="${name##*/}"
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  done

# ── Non-secret app config from EB environment properties ─────────────────────
# On the AL2023 Docker-Compose platform, EB does NOT export environment
# properties into the shell that runs `docker compose up`, so compose would
# interpolate ${APP_ENV} etc. as EMPTY strings (which then fail pydantic
# validation, e.g. app_env=''). Materialise them into .env ourselves.
NONSECRET_KEYS="APP_ENV APP_DEBUG AWS_REGION LOG_LEVEL LOG_FORMAT \
CORS_ALLOW_ORIGINS COGNITO_USER_POOL_ID COGNITO_CLIENT_ID \
JWT_ACCESS_TOKEN_TTL_MINUTES JWT_ID_TOKEN_TTL_MINUTES JWT_REFRESH_TOKEN_TTL_DAYS \
S3_REGION S3_SIGNATURES_BUCKET S3_FORCE_PATH_STYLE BACKEND_INTERNAL_URL"
for key in ${NONSECRET_KEYS}; do
  val="$("$EB_GET_CONFIG" environment -k "${key}" 2>/dev/null || true)"
  [ -n "${val}" ] && printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
done
# No SUPERADMIN_* is materialised here. The bootstrap super admin is created by
# running scripts/seed_super_admins.py with --email / --password after the
# deploy; nothing at runtime reads those values.

chmod 600 "${ENV_FILE}"
echo "[prebuild] wrote $(grep -c '=' "${ENV_FILE}" || echo 0) env vars to .env"

# ── ECR login so `docker compose pull` can fetch private images ──────────────
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "${REGION}")"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
echo "[prebuild] docker login to ${REGISTRY}"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}"

echo "[prebuild] done"
