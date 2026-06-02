# ─────────────────────────────────────────────────────────────────────────────
# Manual app deploy from Windows (no GitHub / no CI). Needs: AWS CLI v2
# configured for the target account + Docker Desktop running.
#
# Builds the two prod images, pushes to the client's ECR, packages the EB
# source bundle (the zip is created INSIDE a tiny alpine container so the
# prebuild hook keeps its +x permission — Windows zip tools can't do that),
# and rolls the Elastic Beanstalk environment to it.
#
# Usage:
#   .\scripts\deploy.ps1 -Tag v1
# ─────────────────────────────────────────────────────────────────────────────
param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$Project = "cellready",
  [string]$EnvName = "dev",
  [string]$Region  = "us-east-2"
)
$ErrorActionPreference = "Stop"

$account       = aws sts get-caller-identity --query Account --output text --region $Region
$registry      = "$account.dkr.ecr.$Region.amazonaws.com"
$backendImage  = "$registry/$Project/backend:$Tag"
$frontendImage = "$registry/$Project/frontend:$Tag"
$artifacts     = "$Project-eb-artifacts-$account-$EnvName"
$appName       = "$Project-$EnvName"
$envName       = "$Project-$EnvName"
$root          = Split-Path -Parent $PSScriptRoot   # scripts\ -> repo root

Write-Host "==> ECR login ($registry)"
# NOTE: piping the token to --password-stdin mangles it under Windows PowerShell
# (a 400 Bad Request), so capture it and pass via --password instead.
$ecrPassword = aws ecr get-login-password --region $Region
docker login --username AWS --password $ecrPassword $registry

Write-Host "==> Build & push images ($Tag)"
docker build --target prod -t $backendImage  "$root\backend"
docker build --target prod -t $frontendImage "$root\frontend"
docker push $backendImage
docker push $frontendImage

Write-Host "==> Package EB source bundle"
$stage = Join-Path $env:TEMP "ebbundle"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Render compose: literal replace of ONLY the image placeholders.
$compose = Get-Content -Raw "$root\deploy\docker-compose.yml"
$compose = $compose.Replace('${BACKEND_IMAGE}', $backendImage).Replace('${FRONTEND_IMAGE}', $frontendImage)
# Write UTF-8 with NO BOM (a BOM can break YAML parsers).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage "docker-compose.yml"), $compose, $utf8NoBom)
Copy-Item -Recurse "$root\deploy\.platform" (Join-Path $stage ".platform")

# Zip inside alpine so chmod +x sticks (Docker is already installed).
$stageDocker = $stage -replace '\\','/'
docker run --rm -v "${stageDocker}:/b" -w /b alpine sh -c `
  "apk add --no-cache zip >/dev/null && chmod +x .platform/hooks/prebuild/*.sh && zip -r -y bundle.zip docker-compose.yml .platform >/dev/null"

$key = "bundle/$Tag.zip"
Write-Host "==> Upload + deploy ($key)"
aws s3 cp (Join-Path $stage "bundle.zip") "s3://$artifacts/$key" --region $Region
aws elasticbeanstalk create-application-version --region $Region `
  --application-name $appName --version-label $Tag `
  --source-bundle "S3Bucket=$artifacts,S3Key=$key" --auto-create-application
aws elasticbeanstalk update-environment --region $Region `
  --environment-name $envName --version-label $Tag

Write-Host "==> Deploying $Tag. Poll status with:"
Write-Host "    aws elasticbeanstalk describe-environments --environment-names $envName --query 'Environments[0].[Status,Health]' --output text --region $Region"
