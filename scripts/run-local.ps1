# Run a fetcher locally for debugging, using credentials from a gitignored
# .env.local file. Writes to data-local/ so it never clobbers the sample data.
#
#   1. Install Node (https://nodejs.org, LTS).
#   2. Create .env.local in the repo root with:
#        BLIZZARD_CLIENT_ID=your-id
#        BLIZZARD_CLIENT_SECRET=your-secret
#   3. Run:  powershell scripts/run-local.ps1            (BoEs, default)
#            powershell scripts/run-local.ps1 scripts/fetch-commodities.mjs
#
# The secret is only ever read from the file into the child process env — it is
# not printed and .env.local is gitignored.
param([string]$script = 'scripts/fetch-boes.mjs')

$ErrorActionPreference = 'Stop'
if (-not (Test-Path '.env.local')) { throw '.env.local not found — create it with BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET' }

# Find node: PATH first, then common install spots (incl. PyCharm's bundled Node).
function Resolve-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($g in @(
      "$env:APPDATA\JetBrains\*\node\versions\*\node.exe",
      "$env:ProgramFiles\nodejs\node.exe",
      "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    $hit = Get-Item $g -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw 'node.exe not found — install Node or add it to PATH.'
}
$node = Resolve-Node

Get-Content '.env.local' | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    Set-Item "env:$($matches[1])" ($matches[2].Trim().Trim('"'))
  }
}
if (-not $env:DATA_DIR) { $env:DATA_DIR = 'data-local' }
New-Item -ItemType Directory -Force -Path "$env:DATA_DIR/history" | Out-Null

Write-Host "node: $node"
Write-Host "Running $script -> $env:DATA_DIR/ (MAX_NEW_ILVL=$env:MAX_NEW_ILVL)"
& $node $script
