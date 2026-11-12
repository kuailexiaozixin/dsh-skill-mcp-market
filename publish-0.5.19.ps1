<#
.SYNOPSIS
  One-click publish + deploy for dsh-market 0.5.19.
  Steps: (1) npm publish (needs a 2FA-capable token / `npm login` interactive),
         (2) extend pnpm-workspace minimumReleaseAgeExclude,
         (3) pnpm install into the desktop profile,
         (4) print the remount instruction.
  Run: pwsh -File publish-0.5.19.ps1
#>
$ErrorActionPreference = "Stop"

$pkg    = "D:\DeepSeek Harness WorkSpace\dsh-market"
$profile= "C:\Users\贺新\.dsh\profiles\desktop"
$ver    = "0.5.19"
$pkgName= "dsh-skill-mcp-market"

Write-Host "==> [1/4] npm publish $pkgName@$ver" -ForegroundColor Cyan
Push-Location $pkg
& npm publish 2>&1 | ForEach-Object { Write-Host $_ }
# 403 two-factor / token error => the token needs bypass-2fa or interactive `npm login`.
$last = $LASTEXITCODE
Pop-Location
if ($last -ne 0) {
  Write-Warning "npm publish failed (exit $last). The current ~/.npmrc token is a classic full-scope token blocked by npmjs 2FA policy."
  Write-Warning "Options: (a) run `npm login` interactively to do a one-time 2FA, or (b) replace the token with a granular one that has 'bypass 2fa' for publish."
  Write-Warning "Stopping here — do not install a version that is not published yet."
  exit $last
}

Write-Host "==> [2/4] extend pnpm-workspace minimumReleaseAgeExclude for $ver" -ForegroundColor Cyan
$ws = Join-Path $profile "pnpm-workspace.yaml"
$entry = "  - ${pkgName}@${ver}"
if (-not (Select-String -Path $ws -Pattern [regex]::Escape($entry) -Quiet)) {
  # append a new line after the existing dsh-market exclude lines
  $lines = Get-Content $ws
  $idx = ($lines | Select-String -Pattern 'minimumReleaseAgeExclude:' | Select-Object -First 1).LineNumber - 1
  # find the last dsh-market entry line
  $lastMkt = -1
  for ($i = $idx; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'dsh-skill-mcp-market@') { $lastMkt = $i }
    else { if ($lines[$i] -notmatch '^\s*-') { break } }
  }
  $lines = $lines.Insert($lastMkt + 1, $entry)
  Set-Content $ws $lines -Encoding UTF8
  Write-Host "    added: $entry"
} else {
  Write-Host "    already present"
}

Write-Host "==> [3/4] pnpm install into profile ($profile)" -ForegroundColor Cyan
Push-Location $profile
# bump the pinned dep to the new version so pnpm resolves it
$pkgJson = Join-Path $profile "package.json"
$pj = Get-Content $pkgJson -Raw
$pj = $pj -replace ('"' + $pkgName + '":\s*"\S+"'), ("`"$pkgName`": `"$ver`"")
Set-Content $pkgJson $pj -Encoding UTF8
& pnpm install 2>&1 | ForEach-Object { Write-Host $_ }
$pi = $LASTEXITCODE
Pop-Location
if ($pi -ne 0) { Write-Warning "pnpm install exited $pi — check the output above."; exit $pi }

Write-Host "==> [4/4] verify installed version" -ForegroundColor Cyan
$inst = Join-Path $profile "node_modules\$pkgName\package.json"
Write-Host "    installed: " + ((Get-Content $inst -Raw | ConvertFrom-Json).version)

Write-Host ""
Write-Host "DONE. Now remount the DSH host so the new client.js (composer buttons) loads:" -ForegroundColor Green
Write-Host "  - In the running GUI: press Ctrl+R to reload the web app, OR fully restart the DSH host."
Write-Host "  - Then open any session and look for the '⚡ 技能' / '⇄ MCP' buttons in the composer input bar (bottom of the chat box)."
exit 0
