# CellReady IMS — AWS Deployment (Elastic Beanstalk)

Low-cost, secure **dev-tier** deployment on Elastic Beanstalk, scalable to prod by
flipping parameters. Infrastructure is CloudFormation; app deploys are GitHub Actions.

## Architecture

```
Browser ──HTTPS──▶ CloudFront (free *.cloudfront.net TLS)
                       │  HTTP :80, locked to CloudFront prefix list
                       ▼
   EB SingleInstance (t3.small, AL2023 Docker-Compose)
     migrate → backend (FastAPI :8000, internal) → frontend (Next.js :3000 → :80)
     prebuild hook: SSM SecureString ──▶ .env   +   ECR docker login
                       │ asyncpg                 │ boto3 (instance role)
                       ▼                          ▼
   RDS PostgreSQL (db.t4g.micro, default VPC,    S3 signatures   Cognito User Pool
   :5432 only from EB SG)                        (instance role) (real, prod)
```

- **Browser only talks to the frontend** via CloudFront. The backend has no public
  port — the Next.js BFF reaches it at `http://backend:8000/v1` on the compose network.
- **Secrets** (`SECRET_KEY`, `DATABASE_URL`, `SUPERADMIN_PASSWORD`) live only in **SSM
  SecureString**, pulled at deploy time by the prebuild hook. They never appear in the
  EB console or CloudFormation.
- **No static AWS keys**: S3 + Cognito use the EC2 instance role; CI uses GitHub OIDC.

## Files

| Path | Purpose |
|---|---|
| `cloudformation/01-foundation.yaml` | ECR repos, S3 (signatures + EB artifacts), Cognito User Pool |
| `cloudformation/02-database.yaml` | RDS PostgreSQL + SG (ingress added by 03) |
| `cloudformation/03-beanstalk.yaml` | EB app/env, IAM roles, SGs, CloudFront, RDS ingress |
| `cloudformation/04-github-oidc.yaml` | GitHub OIDC provider + least-priv deploy role |
| `cloudformation/params/dev-*.json` | Parameter values (fill in the `REPLACE_*` blanks) |
| `../deploy/docker-compose.yml` | **Prod** compose — the EB source bundle root |
| `../deploy/.platform/hooks/prebuild/01_fetch_ssm_secrets.sh` | SSM→.env + ECR login |
| `../scripts/bootstrap_ssm.sh` | Seed SecureString secrets after RDS exists |
| `../.github/workflows/ci.yml` | Lint/type/test on PR + push |
| `../.github/workflows/deploy.yml` | Build→ECR→new EB version→deploy (OIDC) |

## Prerequisites

- AWS CLI v2, authenticated to the target account; region **us-east-2**.
- A bash environment for the scripts (AWS CloudShell / git-bash / WSL).
- Look up these values first:

```bash
REGION=us-east-2

# Default VPC id
aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region $REGION

# Subnet ids in the default VPC (pick 2+ in different AZs)
aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text --region $REGION

# Latest AL2023 Docker solution stack (use the exact string)
aws elasticbeanstalk list-available-solution-stacks \
  --query "SolutionStacks[?contains(@,'running Docker')]" --output text --region $REGION

# CloudFront origin-facing managed prefix list id
aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text --region $REGION
```

Put the results into `cloudformation/params/dev-database.json` and
`dev-beanstalk.json` (replace every `REPLACE_*`). `CNAMEPrefix` must be globally
unique.

## Deploy — order of operations

```bash
REGION=us-east-2
cd infra/cloudformation

# 1) GitHub OIDC + deploy role (once per account)
aws cloudformation deploy --region $REGION \
  --stack-name cellready-dev-oidc --template-file 04-github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-stacks --stack-name cellready-dev-oidc \
  --query "Stacks[0].Outputs" --region $REGION    # copy DeployRoleArn

# 2) Foundation (ECR, S3, Cognito)
aws cloudformation deploy --region $REGION \
  --stack-name cellready-dev-foundation --template-file 01-foundation.yaml

# 3) Database (wait until CREATE_COMPLETE — a few minutes)
aws cloudformation deploy --region $REGION \
  --stack-name cellready-dev-database --template-file 02-database.yaml \
  --parameter-overrides file://params/dev-database.json

# 4) Seed secrets into SSM (needs the RDS endpoint from step 3)
cd ../..
PROJECT=cellready ENV=dev REGION=$REGION ./scripts/bootstrap_ssm.sh
cd infra/cloudformation

# 5) Beanstalk + CloudFront (env starts on the EB sample app)
aws cloudformation deploy --region $REGION \
  --stack-name cellready-dev-beanstalk --template-file 03-beanstalk.yaml \
  --parameter-overrides file://params/dev-beanstalk.json \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-stacks --stack-name cellready-dev-beanstalk \
  --query "Stacks[0].Outputs" --region $REGION    # note AppURL (CloudFront)
```

### 6) Wire up GitHub Actions, then deploy the real app

In the repo: **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
|---|---|
| `AWS_REGION` | `us-east-2` |
| `AWS_ACCOUNT_ID` | your 12-digit account id |
| `DEPLOY_ROLE_ARN` | `DeployRoleArn` output from step 1 |
| `PROJECT` | `cellready` |
| `EB_APP` | `cellready-dev` |
| `EB_ENV` | `cellready-dev` |
| `ARTIFACTS_BUCKET` | `cellready-eb-artifacts-<accountId>-dev` |

Then push to `main` (or run the **Deploy (dev)** workflow manually). CI builds the
images, bundles `deploy/`, and rolls the EB environment to the real app.

### 7) Create the first admin user (Cognito)

`admin-create-user` against the real pool (pool id is a foundation output), e.g.:

```bash
POOL=$(aws cloudformation describe-stacks --stack-name cellready-dev-foundation \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text --region $REGION)
aws cognito-idp admin-create-user --user-pool-id "$POOL" \
  --username admin@cellready.local \
  --user-attributes Name=email,Value=admin@cellready.local Name=email_verified,Value=true \
                    Name=custom:role,Value=super_admin Name=custom:initials,Value=SA \
  --region $REGION
```

## Deploy TODAY without GitHub (manual)

Use this when you just need the app live and don't want to wire up a CI/CD
pipeline yet (e.g. the pipeline will later live in the client's repo). Skip the
OIDC stack (`04`) and the GitHub variables entirely.

1. **Infra** — do Steps 1–5 of the runbook above, but **skip stack `04`**.
   (Stacks `01`, `02`, `03` + `bootstrap_ssm.sh`.)
2. **Get an ECR login token** in CloudShell (valid ~12h):
   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   echo "Registry: ${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com"
   aws ecr get-login-password --region us-east-2     # copy this output
   ```
3. **Build + push images from your local machine** (Docker Desktop; Windows builds
   linux/amd64, which matches the t3.small instance):
   ```bash
   docker login --username AWS --password-stdin <REGISTRY>   # paste token from step 2
   TAG=v1
   docker build --target prod -t <REGISTRY>/cellready/backend:$TAG  ./backend
   docker build --target prod -t <REGISTRY>/cellready/frontend:$TAG ./frontend
   docker push <REGISTRY>/cellready/backend:$TAG
   docker push <REGISTRY>/cellready/frontend:$TAG
   ```
4. **Deploy from CloudShell** (zip preserves the hook's exec bit there):
   ```bash
   PROJECT=cellready ENV=dev REGION=us-east-2 ./scripts/deploy_bundle.sh v1
   ```
5. Create the admin user (Step 7 above) and hand the client the **`AppURL`**.

To redeploy later: bump `TAG` (e.g. `v2`), repeat steps 3–4. When the client's repo
is ready, deploy stack `04` with their org/repo and use the GitHub Actions workflow
instead of this manual path.

## Verify (end-to-end)

- `AppURL` (CloudFront) loads over **HTTPS** with a padlock.
- Backend is **not** reachable directly: `curl http://<CNAMEPrefix>.<region>.elasticbeanstalk.com`
  from your laptop should hang/refuse (only CloudFront IPs are allowed on :80).
- Log in → DevTools shows the session cookie as `Secure; HttpOnly`.
- Create an item + upload a signature → object appears in the signatures S3 bucket.
- `migrate` service exited 0 (check EB logs / CloudWatch) and tables exist in RDS.
- Re-deploy from `main`; data persists (RDS is decoupled from the env).

## Cost (us-east-2, dev, ~/mo)

| Resource | Est. |
|---|---|
| EC2 `t3.small` (SingleInstance) | ~$15 |
| RDS `db.t4g.micro` + 20 GB gp3 | ~$14 |
| EBS root + misc | ~$2 |
| CloudFront / S3 / Cognito / SSM / CloudWatch | ~$0–1 (free tiers) |
| **Total** | **~$30/mo** |

## Notes & scaling to prod

- **Instance arch:** default is `t3.small` (x86_64) so CI builds match natively. To
  use Graviton **`t4g.small`** (~20% cheaper), set `InstanceType=t4g.small` **and**
  build arm64 images in CI: add `docker/setup-qemu-action` + `docker/setup-buildx-action`
  and `--platform linux/arm64` to the two `docker build` steps. (arm64 builds are
  slower under emulation.)
- **Scale to prod** without rewriting templates:
  - `03`: `EnvironmentType=LoadBalanced` (+ ALB + ACM cert for a custom domain),
    larger `InstanceType`, autoscaling min/max.
  - `02`: `MultiAZ=true`, bigger `DBInstanceClass`, enable `DeletionProtection`.
  - Add a prod params file + a tag-gated deploy job with an approval environment.
- **Origin hardening (optional):** add a secret `X-Origin-Verify` custom header on the
  CloudFront origin and check it in Next.js middleware so only CloudFront (not any
  other distribution) can use the origin.
- **Secret rotation:** re-run `bootstrap_ssm.sh` then redeploy; the prebuild hook picks
  up new values.
- **Line endings:** the prebuild hook must stay LF + executable. It's committed with
  `core.autocrlf` safe content; CI re-`chmod +x`s it before zipping.
