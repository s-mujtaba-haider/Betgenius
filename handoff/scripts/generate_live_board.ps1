# Regenerate the current production board under the LOCKED configuration.
# It READS the shipped configuration and changes no model, threshold or policy.
# Requires the member cache to exist (scripts\reproduce.ps1 step 2).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\project\betgenius")

$env:UPLIFT_DATA_DIR  = "$PWD\harness\uplift\data_expanded_6h"
$env:UPLIFT_CACHE_DIR = "$PWD\harness\uplift\cache_fam"

New-Item -ItemType Directory -Force harness\uplift\reports | Out-Null
if (-not (Test-Path harness\uplift\reports\final_v1.csv)) {
    Copy-Item ..\..\results\final_v1.csv harness\uplift\reports\
}

python harness/uplift/live_board.py --tag=_v1 --windows=1,7,30

Write-Host "`nWrote harness\uplift\reports\live_production_results.csv and live_summary.txt"
