# -------------------------------------------------------------
# deploy.ps1 - one-shot build + commit + push for the portfolio.
#
# Usage:
#   .\deploy.ps1                      # commits as "Update site"
#   .\deploy.ps1 "Fixed cert links"   # custom commit message
#
# Steps:
#   1. npm run build   (regenerates build/bundle.min.js + style.min.css)
#   2. git add .       (stages every change under the site root)
#   3. git commit      (skips if nothing changed)
#   4. git push        (Pages redeploys within ~30 seconds)
#
# Exits non-zero on any step failure so it can chain with other scripts.
# -------------------------------------------------------------

param(
  [string]$Message = "Update site"
)

$ErrorActionPreference = "Stop"

function Section($text) {
  Write-Host ""
  Write-Host ">> $text" -ForegroundColor Cyan
}

# 1. Build minified bundles.
Section "Building bundles"
npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed. Aborting deploy." -ForegroundColor Red
  exit 1
}

# 2. Stage everything.
Section "Staging changes"
git add .

# 3. Commit - or skip if nothing changed.
$staged = git status --porcelain
if (-not $staged) {
  Write-Host "No changes to commit. Nothing to deploy." -ForegroundColor Yellow
  exit 0
}

Section "Committing"
git commit -m "$Message"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Commit failed. Aborting deploy." -ForegroundColor Red
  exit 1
}

# 4. Push.
Section "Pushing to origin/main"
git push origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "Push failed. The commit is local - inspect and retry." -ForegroundColor Red
  exit 1
}

Section "Deployed"
Write-Host "Live at https://sons-git.github.io/ (Pages redeploys within ~30s)" -ForegroundColor Green
