#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# seed_cognito.sh — idempotently provision local Cognito.
#
# Creates / ensures-exists:
#   - User pool       cellready-local
#   - App client      cellready-backend-local  (no secret, USER_PASSWORD_AUTH)
#   - Test user       ${SUPERADMIN_EMAIL:-admin@cellready.local}, confirmed
#
# Re-runnable: existing resources are detected by name and reused.
#
# Prerequisites:
#   - cognito-local container running (compose service `cognito`)
#   - `aws` CLI on PATH OR Docker (script will fall back to amazon/aws-cli)
#
# Output: the COGNITO_* env values to paste into your root .env.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cellready-ims}"
NETWORK_NAME="${COMPOSE_PROJECT_NAME}_ims"

POOL_NAME="cellready-local"
CLIENT_NAME="cellready-backend-local"

# Credentials come from the environment and have NO defaults. A default here is
# a working login committed to the repository — public on clone, and identical
# on every machine that ever ran this script.
TEST_EMAIL="${SUPERADMIN_EMAIL:-}"
TEST_PASSWORD="${SUPERADMIN_PASSWORD:-}"
if [ -z "$TEST_EMAIL" ] || [ -z "$TEST_PASSWORD" ]; then
  echo "REFUSING: SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD must both be set." >&2
  echo >&2
  echo "  SUPERADMIN_EMAIL=you@example SUPERADMIN_PASSWORD='…' \\" >&2
  echo "      scripts/seed_cognito.sh" >&2
  exit 2
fi
TEST_NAME="Super Admin"
TEST_INITIALS="SAD"
TEST_ROLE="super_admin"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Token TTLs applied to the app client. Cognito accepts integer values plus
# a "units" map. We pull from env so the seed mirrors what the backend and
# frontend cookies expect.
JWT_ACCESS_TOKEN_TTL_MINUTES="${JWT_ACCESS_TOKEN_TTL_MINUTES:-60}"
JWT_ID_TOKEN_TTL_MINUTES="${JWT_ID_TOKEN_TTL_MINUTES:-60}"
JWT_REFRESH_TOKEN_TTL_DAYS="${JWT_REFRESH_TOKEN_TTL_DAYS:-30}"
TOKEN_VALIDITY_UNITS='{"AccessToken":"minutes","IdToken":"minutes","RefreshToken":"days"}'

# ── Resolve AWS CLI — prefer host install, fall back to docker ──────────────
if command -v aws >/dev/null 2>&1; then
    CLI_MODE="host"
    COGNITO_ENDPOINT="http://localhost:${COGNITO_HOST_PORT:-9229}"
    aws_cmd() {
        AWS_ACCESS_KEY_ID=local \
        AWS_SECRET_ACCESS_KEY=local \
        AWS_DEFAULT_REGION="$AWS_REGION" \
        aws --endpoint-url "$COGNITO_ENDPOINT" "$@"
    }
else
    CLI_MODE="docker"
    COGNITO_ENDPOINT="http://cognito:9229"
    if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
        echo "✗ Docker network '$NETWORK_NAME' not found." >&2
        echo "  Bring the stack up first: docker compose up -d cognito" >&2
        exit 1
    fi
    aws_cmd() {
        docker run --rm \
            --network "$NETWORK_NAME" \
            -e AWS_ACCESS_KEY_ID=local \
            -e AWS_SECRET_ACCESS_KEY=local \
            -e AWS_DEFAULT_REGION="$AWS_REGION" \
            amazon/aws-cli \
            --endpoint-url "$COGNITO_ENDPOINT" "$@"
    }
fi

echo "→ Using AWS CLI ($CLI_MODE mode) against $COGNITO_ENDPOINT"

# ── Wait for cognito-local ──────────────────────────────────────────────────
echo "→ Waiting for cognito-local…"
ATTEMPTS=0
until aws_cmd cognito-idp list-user-pools --max-results 1 >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -gt 30 ]; then
        echo "✗ cognito-local didn't become ready after 30 attempts" >&2
        exit 1
    fi
    sleep 1
done
echo "✓ cognito-local is up"

# ── User pool ───────────────────────────────────────────────────────────────
POOL_ID="$(aws_cmd cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text 2>/dev/null || echo "None")"
POOL_ID="${POOL_ID//[$'\t\r\n ']/}"

if [ -z "$POOL_ID" ] || [ "$POOL_ID" = "None" ]; then
    echo "→ Creating user pool '${POOL_NAME}'…"
    POOL_ID="$(aws_cmd cognito-idp create-user-pool \
        --pool-name "$POOL_NAME" \
        --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true}}' \
        --auto-verified-attributes email \
        --username-attributes email \
        --schema '[
            {"Name":"email","AttributeDataType":"String","Required":true,"Mutable":true},
            {"Name":"name","AttributeDataType":"String","Required":true,"Mutable":true},
            {"Name":"initials","AttributeDataType":"String","Mutable":true,"StringAttributeConstraints":{"MinLength":"1","MaxLength":"8"}},
            {"Name":"role","AttributeDataType":"String","Mutable":true,"StringAttributeConstraints":{"MinLength":"1","MaxLength":"64"}}
        ]' \
        --query 'UserPool.Id' --output text)"
    POOL_ID="${POOL_ID//[$'\t\r\n ']/}"
    echo "✓ Pool created: $POOL_ID"
else
    echo "✓ Pool already exists: $POOL_ID"
fi

# ── App client ──────────────────────────────────────────────────────────────
CLIENT_ID="$(aws_cmd cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" \
    --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" \
    --output text 2>/dev/null || echo "None")"
CLIENT_ID="${CLIENT_ID//[$'\t\r\n ']/}"

if [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" = "None" ]; then
    echo "→ Creating app client '${CLIENT_NAME}'…"
    CLIENT_ID="$(aws_cmd cognito-idp create-user-pool-client \
        --user-pool-id "$POOL_ID" \
        --client-name "$CLIENT_NAME" \
        --no-generate-secret \
        --explicit-auth-flows \
            ALLOW_USER_PASSWORD_AUTH \
            ALLOW_REFRESH_TOKEN_AUTH \
            ALLOW_USER_SRP_AUTH \
        --access-token-validity "$JWT_ACCESS_TOKEN_TTL_MINUTES" \
        --id-token-validity "$JWT_ID_TOKEN_TTL_MINUTES" \
        --refresh-token-validity "$JWT_REFRESH_TOKEN_TTL_DAYS" \
        --token-validity-units "$TOKEN_VALIDITY_UNITS" \
        --query 'UserPoolClient.ClientId' --output text)"
    CLIENT_ID="${CLIENT_ID//[$'\t\r\n ']/}"
    echo "✓ Client created: $CLIENT_ID"
else
    echo "✓ Client already exists: $CLIENT_ID"
fi

# Always reapply token validities — keeps the client in sync with current
# env values without forcing a full recreate. cognito-local accepts the
# same surface as AWS.
echo "→ Applying token TTLs (access=${JWT_ACCESS_TOKEN_TTL_MINUTES}m, id=${JWT_ID_TOKEN_TTL_MINUTES}m, refresh=${JWT_REFRESH_TOKEN_TTL_DAYS}d)…"
aws_cmd cognito-idp update-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-id "$CLIENT_ID" \
    --explicit-auth-flows \
        ALLOW_USER_PASSWORD_AUTH \
        ALLOW_REFRESH_TOKEN_AUTH \
        ALLOW_USER_SRP_AUTH \
    --access-token-validity "$JWT_ACCESS_TOKEN_TTL_MINUTES" \
    --id-token-validity "$JWT_ID_TOKEN_TTL_MINUTES" \
    --refresh-token-validity "$JWT_REFRESH_TOKEN_TTL_DAYS" \
    --token-validity-units "$TOKEN_VALIDITY_UNITS" >/dev/null
echo "✓ Token TTLs applied"

# ── Test user ───────────────────────────────────────────────────────────────
EXISTS="$(aws_cmd cognito-idp list-users --user-pool-id "$POOL_ID" \
    --filter "email = \"${TEST_EMAIL}\"" \
    --query "Users[0].Username" --output text 2>/dev/null || echo "None")"
EXISTS="${EXISTS//[$'\t\r\n ']/}"

if [ -z "$EXISTS" ] || [ "$EXISTS" = "None" ]; then
    echo "→ Creating test user '${TEST_EMAIL}'…"
    aws_cmd cognito-idp admin-create-user \
        --user-pool-id "$POOL_ID" \
        --username "$TEST_EMAIL" \
        --user-attributes \
            "Name=email,Value=${TEST_EMAIL}" \
            "Name=email_verified,Value=true" \
            "Name=name,Value=${TEST_NAME}" \
            "Name=custom:initials,Value=${TEST_INITIALS}" \
            "Name=custom:role,Value=${TEST_ROLE}" \
        --message-action SUPPRESS >/dev/null

    # admin-create-user leaves the user in FORCE_CHANGE_PASSWORD; setting a
    # permanent password skips that flow so we can log in immediately.
    aws_cmd cognito-idp admin-set-user-password \
        --user-pool-id "$POOL_ID" \
        --username "$TEST_EMAIL" \
        --password "$TEST_PASSWORD" \
        --permanent
    echo "✓ Test user created + confirmed"
else
    echo "✓ Test user already exists: $TEST_EMAIL"
fi

# ── Done — print copy-pasteable env ──────────────────────────────────────────
JWKS_URL="http://cognito:9229/${POOL_ID}/.well-known/jwks.json"
# cognito-local emits this iss claim regardless of the host the backend uses
# to call it. Real Cognito doesn't need an override — leave COGNITO_ISSUER
# unset in production.
ISSUER="http://localhost:9229/${POOL_ID}"

cat <<EOF

═════════════════════════════════════════════════════════════════════════════
✓ Cognito setup complete

Paste these into ${REPO_ROOT}/.env  (replacing any existing COGNITO_* lines):

  AWS_REGION=${AWS_REGION}
  COGNITO_USER_POOL_ID=${POOL_ID}
  COGNITO_CLIENT_ID=${CLIENT_ID}
  COGNITO_ENDPOINT_URL=http://cognito:9229
  COGNITO_JWKS_URL=${JWKS_URL}
  COGNITO_ISSUER=${ISSUER}

Test user:
  email:    ${TEST_EMAIL}
  password: ${TEST_PASSWORD}

Then recreate the backend so it picks up the new env:

  docker compose up -d --force-recreate backend

═════════════════════════════════════════════════════════════════════════════
EOF
