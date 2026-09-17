# BetGenius Final -- smoke test.
# Needs nothing but Python and the packaged files: no credentials, no network.
# Expected: "2 shipped reports replayed, 0 mismatches"
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\project\betgenius")
Write-Host "Replaying the shipped harness reports through the Python gate port..."
python harness/uplift/verify_gate.py
