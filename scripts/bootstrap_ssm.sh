#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-time (and on-rotation) seeding of SecureString secrets into SSM Parameter
# Store. CloudFormation cannot create SecureString parameters, so this runs
# AFTER the database stack (02) is up. The EB prebuild hook reads these at deploy.
#
# Run in AWS CloudShell, git-bash, or WSL with AWS creds configured. Requires:
# aws CLI v2, python3, openssl.
#
# Usage:
#   PROJECT=cellready ENV=dev REGION=us-east-2 ./scripts/bootstrap_ssm.sh
# Optional overrides:
#   SUPERADMIN_PASSWORD=...   (default: generated and printed once)
#   SECRET_KEY=...            (default: generated)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT="${PROJECT:-cellready}"
ENV="${ENV:-dev}"
REGION="${REGION:-us-east-2}"
PREFIX="/${PROJECT}/${ENV}/"

echo "==> Seeding SSM secrets under ${PREFIX} (region ${REGION})"

get_export() {
  aws cloudformation list-exports --region "${REGION}" \
    --query "Exports[?Name=='${1}'].Value" --output text
}

DB_HOST="$(get_export "${PROJECT}-${ENV}-DBEndpoint")"
DB_PORT="$(get_export "${PROJECT}-${ENV}-DBPort")"
DB_NAME="$(get_export "${PROJECT}-${ENV}-DBName")"
DB_USER="$(get_export "${PROJECT}-${ENV}-DBUsername")"
DB_SECRET_ARN="$(get_export "${PROJECT}-${ENV}-DBSecretArn")"

if [[ -z "${DB_HOST}" || "${DB_HOST}" == "None" ]]; then
  echo "ERROR: could not read DB exports — is the 02-database stack deployed?" >&2
  exit 1
fi

# Master password from the RDS-managed Secrets Manager secret.
DB_SECRET_JSON="$(aws secretsmanager get-secret-value \
  --secret-id "${DB_SECRET_ARN}" --query SecretString --output text --region "${REGION}")"
DB_PASS="$(printf '%s' "${DB_SECRET_JSON}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')"
# URL-encode the password so special characters are DSN-safe.
DB_PASS_ENC="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "${DB_PASS}")"

DATABASE_URL="postgresql+asyncpg://${DB_USER}:${DB_PASS_ENC}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

SECRET_KEY="${SECRET_KEY:-$(openssl rand -base64 48 | tr -d '\n')}"

GEN_ADMIN_PW=0
if [[ -z "${SUPERADMIN_PASSWORD:-}" ]]; then
  SUPERADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '\n')Aa1!"
  GEN_ADMIN_PW=1
fi

put() {
  aws ssm put-parameter --region "${REGION}" \
    --name "${PREFIX}$1" --type SecureString --value "$2" --overwrite >/dev/null
  echo "    put ${PREFIX}$1"
}

put SECRET_KEY          "${SECRET_KEY}"
put DATABASE_URL        "${DATABASE_URL}"
put SUPERADMIN_PASSWORD "${SUPERADMIN_PASSWORD}"

echo "==> Done."
if [[ "${GEN_ADMIN_PW}" == "1" ]]; then
  echo ""
  echo "  Generated SUPERADMIN_PASSWORD (store it now, shown once):"
  echo "    ${SUPERADMIN_PASSWORD}"
fi
