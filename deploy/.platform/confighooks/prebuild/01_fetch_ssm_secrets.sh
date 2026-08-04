#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# EB prebuild hook for CONFIGURATION deployments.
#
# Elastic Beanstalk runs two separate hook trees and shares nothing between
# them:
#
#   .platform/hooks/prebuild/        → APPLICATION deploys   (a git push)
#   .platform/confighooks/prebuild/  → CONFIGURATION deploys (an option change,
#                                      e.g. a CloudFormation stack update)
#
# Only the first existed until 2026-08-04, which was invisible until the first
# config-only update was attempted. EB re-ran `docker compose up` without ever
# regenerating ./.env, so DATABASE_URL and SECRET_KEY interpolated to empty
# strings, the migrate container failed pydantic validation, `docker compose
# up` exited non-zero, and the configuration deployment aborted — leaving the
# environment Degraded with no running containers.
#
# The two deploy types need byte-identical work, so this delegates instead of
# duplicating a hundred lines that would then be free to drift apart. The one
# thing that must not happen is the two paths disagreeing about what lands in
# .env.
#
# IMPORTANT: keep this file LF-only (.gitattributes) and make sure CI chmods it
# +x alongside the hooks/ copy — the executable bit is NOT stored in git.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REAL="$(dirname "$0")/../../hooks/prebuild/01_fetch_ssm_secrets.sh"

if [ ! -f "${REAL}" ]; then
  echo "[confighook] FATAL: application-deploy hook not found at:" >&2
  echo "[confighook]   ${REAL}" >&2
  echo "[confighook] Without it .env is never written and the containers would" >&2
  echo "[confighook] start with blank DATABASE_URL and SECRET_KEY. Refusing." >&2
  exit 1
fi

# Not `-x`: the bundle may arrive without the bit set (it is applied by CI, and
# a hand-built zip can miss it). Running it through bash makes this hook work
# either way rather than failing for a reason that has nothing to do with the
# secrets it is here to fetch.
exec bash "${REAL}"
