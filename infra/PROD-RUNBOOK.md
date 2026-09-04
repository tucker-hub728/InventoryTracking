# Production runbook

Stand up a **production** environment alongside the existing dev one, in the same AWS
account. Prod gets its own database, its own Cognito pool, its own users and its own URL.

Dev is not touched by any step here.

**Everything below is one-time.** Once it is done, deploying prod is just
`git push origin production`.

---

## Before you start

| Need | Why |
|---|---|
| AWS CLI, logged in with admin rights | Creates the stacks |
| A **globally unique** CNAME prefix | e.g. `cellready-prod-7f3a`. Must not clash with ANY other AWS customer |

The four `params/prod-*.json` files are **already filled in** with the real values, read
from the deployed dev stacks:

| | |
|---|---|
| Account | `684707794581` |
| Region | `us-east-2` |
| VPC | `vpc-02aa950b6bd600d14` |
| Subnets | `subnet-0f811daba24c61594`, `subnet-0bf5f6b52f78ef8f5` |
| Solution stack | `64bit Amazon Linux 2023 v4.13.1 running Docker` |
| CloudFront prefix list | `pl-b6a144df` |
| OIDC provider | `arn:aws:iam::684707794581:oidc-provider/token.actions.githubusercontent.com` |
| PostgreSQL | `16.13` — matches the version dev is **actually running** |

> ⚠️ **Do not copy the EngineVersion from the dev stack's parameters.** RDS has
> `AutoMinorVersionUpgrade: true`, so the running instance drifts upward from whatever the
> parameter said — dev's parameter reads `16.8` while the instance is on `16.13`. AWS also
> retires older minors for NEW instance creation, so a stale value fails with
> `Cannot find version X for postgres`. Check both before deploying:
>
> ```powershell
> # what dev is REALLY on
> aws rds describe-db-instances --region us-east-2 --db-instance-identifier cellready-dev `
>   --query "DBInstances[0].EngineVersion" --output text
> # what can still be created
> aws rds describe-db-engine-versions --region us-east-2 --engine postgres `
>   --query "DBEngineVersions[?starts_with(EngineVersion,'16.')].EngineVersion" --output text
> ```

**Exactly one value is left for you:** `CNAMEPrefix` in `params/prod-beanstalk.json`.
Replace `cellready-prod-REPLACE_UNIQUE_SUFFIX` with something unlikely to be taken —
`cellready-prod-` plus a few random characters. The stack fails if the name is in use
anywhere in AWS.

> `prod-beanstalk.json` sets `SSMParamPrefix` to `""` **on purpose**. Blank means "derive it
> as `/cellready/prod/`", which is exactly where `bootstrap_ssm.sh` writes. Do not put
> `/cellready/dev/` here — that is how a production box ends up on the dev database.

---

## 1. Create the AWS stacks

Order matters. Each must reach `CREATE_COMPLETE` before the next.

```bash
REGION=us-east-2
cd infra/cloudformation

# 1a) Deploy role for the production branch.
#     Reuses the account's existing OIDC provider — see prod-oidc.json.
aws cloudformation deploy --region $REGION \
  --stack-name cellready-prod-oidc --template-file 04-github-oidc.yaml \
  --parameter-overrides file://params/prod-oidc.json \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation describe-stacks --stack-name cellready-prod-oidc \
  --query "Stacks[0].Outputs" --region $REGION      # copy DeployRoleArn

# 1b) Foundation — prod Cognito pool + prod artifacts bucket.
#     CreateEcrRepos=false: the two ECR repos already exist and are shared.
aws cloudformation deploy --region $REGION \
  --stack-name cellready-prod-foundation --template-file 01-foundation.yaml \
  --parameter-overrides file://params/prod-foundation.json

# 1c) Database. SLOWEST STEP — 10-15 minutes. Wait for it.
aws cloudformation deploy --region $REGION \
  --stack-name cellready-prod-database --template-file 02-database.yaml \
  --parameter-overrides file://params/prod-database.json
```

## 2. Seed the secrets — DO NOT SKIP

Nothing automates this and nothing warns you if it is missed. It reads the RDS endpoint
from step 1c and writes prod's `DATABASE_URL` and a freshly generated `SECRET_KEY` to
`/cellready/prod/`.

```bash
cd ../..
PROJECT=cellready ENV=prod REGION=us-east-2 ./scripts/bootstrap_ssm.sh
cd infra/cloudformation
```

Confirm all three landed:

```bash
aws ssm get-parameters-by-path --path /cellready/prod/ \
  --region $REGION --query "Parameters[].Name"
# expect: SECRET_KEY, DATABASE_URL, SUPERADMIN_PASSWORD
```

## 3. Create the Beanstalk environment

```bash
aws cloudformation deploy --region $REGION \
  --stack-name cellready-prod-beanstalk --template-file 03-beanstalk.yaml \
  --parameter-overrides file://params/prod-beanstalk.json \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation describe-stacks --stack-name cellready-prod-beanstalk \
  --query "Stacks[0].Outputs" --region $REGION      # note AppURL — this is your prod link
```

**The URL will show the Elastic Beanstalk sample page. That is correct.** The stack starts
with no application version; your first push replaces it.

---

## 4. Add the repository variables

GitHub Environments are not available on this repo, so the workflow selects by **prefixed
repository variables** instead. Repo → **Settings → Secrets and variables → Actions →
Variables**.

**Keep the three shared ones exactly as they are:**

| Variable | Value |
|---|---|
| `AWS_REGION` | `us-east-2` |
| `AWS_ACCOUNT_ID` | `684707794581` |
| `PROJECT` | `cellready` |

**Add eight new ones** — four per environment:

| Variable | Value |
|---|---|
| `DEV_EB_APP` | `cellready-dev` |
| `DEV_EB_ENV` | `cellready-dev` |
| `DEV_ARTIFACTS_BUCKET` | `cellready-eb-artifacts-684707794581-dev` |
| `DEV_DEPLOY_ROLE_ARN` | *(copy from the existing `DEPLOY_ROLE_ARN`)* |
| `PROD_EB_APP` | `cellready-prod` |
| `PROD_EB_ENV` | `cellready-prod` |
| `PROD_ARTIFACTS_BUCKET` | `cellready-eb-artifacts-684707794581-prod` |
| `PROD_DEPLOY_ROLE_ARN` | `DeployRoleArn` from step 1a |

> ⚠️ **Do NOT delete or rename the four existing unprefixed variables yet**
> (`EB_APP`, `EB_ENV`, `ARTIFACTS_BUCKET`, `DEPLOY_ROLE_ARN`). `main` is still running the
> OLD workflow and reads them. Delete them only after the new workflow has been merged to
> `main` and deployed dev successfully.
>
> The `DEV_*` copies must exist **before** that merge, or the first dev deploy afterwards
> stops with `Missing repository variable(s)`. That is a deliberate guard — the workflow
> refuses to run with an empty environment name rather than doing something unpredictable.

Copy the dev role ARN with:

```bash
aws cloudformation describe-stacks --stack-name cellready-dev-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text --region us-east-2
```

---

## 5. First production deploy

```bash
git checkout -b production
git push -u origin production
```

Watch **Actions**. The run will:

1. Run CI (lint only)
2. Build and push both images — or reuse them if this commit was already built
3. Zip the bundle, upload it, create an application version
4. Roll the environment
5. On the instance: fetch `/cellready/prod/` secrets, then **run all 63 migrations**
   (`alembic upgrade head`) before the backend is allowed to start
6. Poll until **Ready/Green**

**8-15 minutes.** If migrations fail, the backend never starts, health never goes green, and
the workflow exits non-zero. It cannot half-deploy silently.

---

## 6. Seed production data

The app is running but the database is **empty** — you cannot log in yet.

Run these **on the EB instance**, in order. Connect with **Session Manager**
(`aws ssm start-session`), then `docker exec` into the backend container — the
RDS instance is `PubliclyAccessible: false` and its security group admits only
that instance, so there is no route to it from a laptop.

Every one of these is **idempotent** (a node whose `(parent, code)` already
exists is skipped), so re-running after a release is safe.

> A migration never inserts a location row (`created_by_user_id` is NOT NULL, and
> the audit trail wants a real owner), so a release that adds a location AREA
> ships the code but not the rows, and the screen reads "… isn't set up yet"
> until this step runs. **Storage is not in this list** and needs nothing here:
> its room is created by the server when the first location is added, precisely
> so that a missed deploy step cannot strand the screen. Prefer that pattern for
> any new area whose container the client never names.

```bash
# Reference data
python -m scripts.seed_item_tiers
python -m scripts.seed_suppliers
python -m scripts.seed_production      # the only location seed — six clean rooms
```

> **Retired 2026-08-19 (client-approved).** Materials Management, Cold Storage
> and Analytical Lab were removed in favour of Storage's generic template, and
> `seed_cold_storage`, `seed_analytical_lab`, `seed_materials_management` and the
> `seed_locations` aggregator were deleted with them. If you are following an
> older copy of this runbook, those four commands no longer exist. Storage
> locations and the LN2 tree are both built in the app, not seeded.

Then the first administrator:

```bash
# Get the pool id — the seeder makes you echo it back on purpose.
aws cloudformation describe-stacks --stack-name cellready-prod-foundation \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text --region us-east-2

python -m scripts.seed_super_admins --yes \
  --email you@yourcompany.com \
  --password '<12+ chars, upper + lower + digit + symbol>' \
  --confirm-production <the-pool-id-from-above>
```

> The password lands in your shell history. Use a password manager and clear the entry, or
> run it from a shell with history disabled.

---

## 7. Verify

| Check | Expected |
|---|---|
| Open the prod `AppURL`, log in as the super admin | Works |
| Audit trail | **Empty** — proves prod is not pointed at dev's database |
| Create a lot, e-sign a change | Succeeds |
| `SELECT record_table, record_id FROM audit.reauth_events ORDER BY created_at DESC LIMIT 1;` | Both populated, not NULL |
| `SELECT ip_address FROM audit.reauth_events ORDER BY created_at DESC LIMIT 1;` | A real client IP — **not** `172.*` and not a CloudFront address |

If that last one is wrong, `TRUSTED_PROXY_COUNT` (currently `2`) does not match the real
hop count. Adjust it in `03-beanstalk.yaml` and redeploy — the value decides which
`X-Forwarded-For` entry is trusted for the Part 11 audit record.

---

## After this

Every later prod release is just:

```bash
git checkout production
git merge main          # or whatever you are releasing
git push
```

## Bringing dev up to the same code

Only once prod is verified. Two separate jobs: **merge the code** (required), then
**update dev's CloudFormation** (optional cleanup). Pushing code never touches
CloudFormation, so they are independent.

### Part 1 — merge the code

Dev runs `APP_ENV=production`, so every production invariant in `core/config.py` applies to
it. Verified 2026-08-04 — all pass, no action needed:

| Check | Dev |
|---|---|
| `/cellready/dev/SECRET_KEY` | 64 chars, 45 distinct, no `dev-only` / `changeme` / `example` marker |
| `APP_DEBUG` | `false` |
| `COGNITO_USER_POOL_ID` / `CLIENT_ID` | both set |
| `COGNITO_ENDPOINT_URL` | unset (must be — it points boto3 at cognito-local) |
| `SSM_PARAM_PREFIX` | `/cellready/dev/` — set, so the fail-closed prebuild hook passes |
| `esignimg01` (drops a column) | 0 of 35 reauth rows carry a signature key — nothing orphaned |

> Re-check the secret key if it is ever rotated:
> ```powershell
> aws ssm get-parameter --name /cellready/dev/SECRET_KEY --with-decryption `
>   --query Parameter.Value --output text --region us-east-2
> ```
> Run it from **PowerShell, not Git Bash** — Git Bash rewrites a leading `/` into a Windows
> path, so the lookup fails in a way that is easy to mistake for a pass.

1. **Confirm the four `DEV_*` variables exist** (step 4). The new workflow reads only the
   prefixed names — without them the first post-merge dev deploy stops with
   `Missing repository variable(s)`. Nothing is built; add them and re-run.
2. Merge into `main`. Dev deploys on the new workflow and applies the two pending
   migrations (`esignimg01`, `esignbind01`).
3. Once that deploy is green, delete the four old unprefixed variables
   (`EB_APP`, `EB_ENV`, `ARTIFACTS_BUCKET`, `DEPLOY_ROLE_ARN`) — nothing reads them now.
   Dependabot also starts working here; its config reaches `main` with this merge.

### Part 2 — update dev's CloudFormation (optional)

The merge alone leaves `TRUSTED_PROXY_COUNT` unset on dev, so it defaults to `0` and the
audit trail records CloudFront's IP instead of the client's. Honest, but useless. This also
clears out the dead signatures bucket and its `S3_*` environment properties.

> ⚠️ **`CreateEcrRepos` must be `true` for dev.** `cellready-dev-foundation` OWNS
> `cellready/backend` and `cellready/frontend`, and **production pulls its images from
> them**. Setting `false` removes them from the stack, which deletes the repositories and
> prod's live images with them. `prod-foundation.json` is the file that sets `false`,
> because prod reuses what dev owns.

**Order matters — 03 before 01.** `01` exports `SignaturesBucketArn` and the old `03`
imports it; CloudFormation will not remove an Export while something still imports it.

```powershell
cd infra/cloudformation

# 1) Beanstalk first — drops the import, adds TRUSTED_PROXY_COUNT=2.
aws cloudformation deploy --region us-east-2 `
  --stack-name cellready-dev-beanstalk --template-file 03-beanstalk.yaml `
  --parameter-overrides file://params/dev-beanstalk.json `
  --capabilities CAPABILITY_NAMED_IAM

# 2) Foundation second — removes the now-unimported bucket and its exports.
aws cloudformation deploy --region us-east-2 `
  --stack-name cellready-dev-foundation --template-file 01-foundation.yaml `
  --parameter-overrides file://params/dev-foundation.json
```

The signatures bucket is `DeletionPolicy: Retain` and empty, so it is left behind in S3
rather than deleted. Remove it by hand if you want it gone.

**Do not touch `02-database` or `04-github-oidc` for dev.** The database stack's
`EngineVersion` parameter reads `16.8` while the instance has auto-upgraded to `16.13`, and
`16.8` can no longer be created — an update would fail. The OIDC stack already trusts
`main`, which is the branch dev now deploys from.

Verify afterwards:

```powershell
aws elasticbeanstalk describe-configuration-settings `
  --application-name cellready-dev --environment-name cellready-dev --region us-east-2 `
  --query "ConfigurationSettings[0].OptionSettings[?OptionName=='TRUSTED_PROXY_COUNT'].Value" `
  --output text
```

## Tearing prod down

`EnableDeletionProtection` is `true`, so RDS refuses to be deleted until you turn it off
deliberately. Delete stacks in reverse order: `beanstalk` → `database` → `foundation` →
`oidc`. The database leaves a final snapshot (`DeletionPolicy: Snapshot`).
