# BetGenius MLB Phase 1 -- full reproduction from the packaged data.
# No network, no credentials, no API credits. Roughly 2 hours end to end.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\project\betgenius")

$env:UPLIFT_DATA_DIR  = "$PWD\harness\uplift\data_expanded_6h"
$env:UPLIFT_CACHE_DIR = "$PWD\harness\uplift\cache_fam"
$env:UPLIFT_MEMBERS   = "rf,et,gbmB,gbmC,gbmD"

Write-Host "`n[1/6] smoke test -- the gate port"
python harness/uplift/verify_gate.py

Write-Host "`n[2/6] building the member cache  (~90 minutes, ~940 MB)"
python harness/uplift/build_cache.py

Write-Host "`n[3/6] the final run  (~5 minutes)"
python harness/uplift/run_final_model.py --conf=60 --tag=_v1

Write-Host "`n[4/6] production parity  -- expect 0 of 28,141 rejected"
python harness/uplift/parity_audit.py --tag=_v1

Write-Host "`n[5/6] the current production board"
python harness/uplift/live_board.py --tag=_v1 --windows=1,7,30

Write-Host "`n[6/6] season split"
python harness/uplift/season_analysis.py --tag=_v1

Write-Host "`nNow compare what you produced against what shipped:"
Write-Host "    Compare-Object (gc harness\uplift\reports\final_v1.csv) (gc ..\..\results\final_v1.csv)"
Write-Host "`nExpected: 6/11 both gates, 7/11 full OOS, 6/11 verdict, 202.7 verdict units,"
Write-Host "          0 of 28,141 board rows rejected."
Write-Host "`nThe final client table needs the robustness roll-up as an input:"
Write-Host "    copy ..\..\results\robustness_v1.csv harness\uplift\reports\"
Write-Host "    python harness/uplift/final_matrix.py --tag=_v1"
