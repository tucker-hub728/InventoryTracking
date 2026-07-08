# Production seeding runbook (super admin + freezer locations)

How to seed a **production** environment on AWS (Elastic Beanstalk, Docker-Compose
platform). Both scripts live in the backend image and run *inside the running
backend container* on the EB instance.

## What is automatic vs manual

| Step | When | Who runs it |
|------|------|-------------|
| DB migrations (`alembic upgrade head`, incl. the `loccat01` location-category enum) | **Every deploy**, via the `migrate` service in `deploy/docker-compose.yml` | Automatic — do **not** run by hand |
| Seed the **super admin** | Once, after first deploy | Manual (this runbook) |
| Seed the **freezer locations** | Once, after first deploy | Manual (this runbook) |

After migrations the schema exists but is **empty** — no users, no locations.

## Prerequisites (one-time)

1. **IAM permissions.** In prod `COGNITO_ENDPOINT_URL` is unset, so the super-admin
   seed calls the real Cognito admin APIs using the **EB instance role**. That role
   must allow, on the target user pool:
   - `cognito-idp:AdminCreateUser`
   - `cognito-idp:AdminSetUserPassword`
   - `cognito-idp:AdminGetUser`

   Without these the seed fails with `AccessDenied`.

2. **Super-admin password.** `scripts/seed_super_admins.py` has a placeholder
   password baked into the image. Either set a strong, unique value in `_USERS`
   **before the CI build**, or rotate it immediately after seeding (step 6). The
   prod gate checks strength, not whether the value is committed to git.

## Steps

### 1. Deploy
Deploy as usual (CI / `eb deploy`). The `migrate` service applies all migrations
(creates the schema + the new location categories: Analytical Lab, Sterility Lab, PD).

### 2. Connect to the instance
```bash
eb ssh                     # EB CLI — or use SSM Session Manager / SSH to the instance
```

### 3. Find the backend container
```bash
docker ps --format '{{.Names}}' | grep backend      # e.g. cellready-ims-backend-1
```

### 4. Seed the super admin (ONE user; everyone else is invited in-app)
```bash
C=cellready-ims-backend-1     # from step 3

# pool id is needed for the production confirmation flag:
docker exec "$C" printenv COGNITO_USER_POOL_ID       # e.g. us-east-1_ABC123

docker exec "$C" python -m scripts.seed_super_admins                       # dry run — prints the plan
docker exec "$C" python -m scripts.seed_super_admins --yes --confirm-production us-east-1_ABC123
```
Creates the single super admin in Cognito **and** the `app.users` mirror row.
Idempotent — safe to re-run.

### 5. Seed the freezer locations
```bash
docker exec "$C" python -m scripts.seed_locations          # dry run — 7 freezers + 15 sub-locations
docker exec "$C" python -m scripts.seed_locations --yes    # create them
```
Idempotent — re-running creates nothing new.

### 6. Verify + secure
- Log in to the app (CloudFront URL) as the super admin; confirm the Locations page
  shows the freezers and sub-locations.
- If you used the committed placeholder password, rotate it now:
  ```bash
  aws cognito-idp admin-set-user-password \
    --user-pool-id us-east-1_ABC123 \
    --username superadmin@your-domain.com \
    --password '<new-strong-password>' --permanent \
    --region "$AWS_REGION"
  ```
- Invite the rest of the team from **Users → Invite user** (admin / operator only;
  super_admin is a fixed singleton and can't be invited).

## Gotchas
- **RDS password rotation.** If the RDS master password rotated and the static SSM
  `DATABASE_URL` went stale, the app (and these scripts) can't reach the DB. Re-sync
  SSM + redeploy before seeding.
- **Interactive shell** (alternative to `docker exec ... <cmd>`): `docker exec -it "$C" sh`,
  then run the `python -m scripts.*` commands from `/app`.
