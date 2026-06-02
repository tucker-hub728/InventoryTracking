# ─────────────────────────────────────────────────────────────────────────────
# Seed SecureString secrets into SSM Parameter Store (Windows PowerShell).
# Run AFTER the 02-database stack is up. Needs: AWS CLI v2 configured for the
# target account. No Python/openssl required.
#
# Usage:
#   .\scripts\bootstrap_ssm.ps1
#   .\scripts\bootstrap_ssm.ps1 -Region us-east-2 -SuperadminPassword 'My$trongPw1!'
# ─────────────────────────────────────────────────────────────────────────────
param(
  [string]$Project = "cellready",
  [string]$EnvName = "dev",
  [string]$Region  = "us-east-2",
  [string]$SuperadminPassword,
  [string]$SecretKey
)
$ErrorActionPreference = "Stop"
$prefix = "/$Project/$EnvName/"
Write-Host "==> Seeding SSM under $prefix ($Region)"

function Get-Export([string]$name) {
  aws cloudformation list-exports --region $Region --query "Exports[?Name=='$name'].Value" --output text
}

$dbHost      = Get-Export "$Project-$EnvName-DBEndpoint"
$dbPort      = Get-Export "$Project-$EnvName-DBPort"
$dbName      = Get-Export "$Project-$EnvName-DBName"
$dbUser      = Get-Export "$Project-$EnvName-DBUsername"
$dbSecretArn = Get-Export "$Project-$EnvName-DBSecretArn"

if (-not $dbHost -or $dbHost -eq "None") {
  throw "Could not read DB exports - is the 02-database stack deployed?"
}

$secretJson = aws secretsmanager get-secret-value --secret-id $dbSecretArn --query SecretString --output text --region $Region
$dbPass     = ($secretJson | ConvertFrom-Json).password
$dbPassEnc  = [uri]::EscapeDataString($dbPass)   # URL-encode so the DSN is safe
$databaseUrl = "postgresql+asyncpg://$($dbUser):$($dbPassEnc)@$($dbHost):$($dbPort)/$($dbName)"

if (-not $SecretKey) {
  $b = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $SecretKey = [Convert]::ToBase64String($b)
}

$generatedAdmin = $false
if (-not $SuperadminPassword) {
  $b = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $SuperadminPassword = [Convert]::ToBase64String($b) + "Aa1!"
  $generatedAdmin = $true
}

function Put-Param([string]$name, [string]$value) {
  aws ssm put-parameter --region $Region --name "$prefix$name" --type SecureString --value $value --overwrite | Out-Null
  Write-Host "    put $prefix$name"
}

Put-Param "SECRET_KEY"          $SecretKey
Put-Param "DATABASE_URL"        $databaseUrl
Put-Param "SUPERADMIN_PASSWORD" $SuperadminPassword

Write-Host "==> Done."
if ($generatedAdmin) {
  Write-Host ""
  Write-Host "  Generated SUPERADMIN_PASSWORD (store it now, shown once):"
  Write-Host "    $SuperadminPassword"
}
