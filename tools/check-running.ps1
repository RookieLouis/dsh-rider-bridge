#requires -Version 5.1
[CmdletBinding()]
param([string]$DshHomeDirectory = '')
$ErrorActionPreference = 'Stop'
if (-not $DshHomeDirectory) {
  $DshHomeDirectory = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$descriptor = Join-Path $DshHomeDirectory 'ide-bridge\desktop.properties'
if (-not (Test-Path -LiteralPath $descriptor -PathType Leaf)) {
  [pscustomobject]@{ DescriptorPresent = $false; HostReady = $false; ClientReady = $false; Port = $null }
  exit 1
}
$properties = @{}
foreach ($line in [IO.File]::ReadAllLines($descriptor)) {
  $parts = $line.Split(@('='), 2)
  if ($parts.Length -eq 2) { $properties[$parts[0].Trim()] = $parts[1].Trim() }
}
$port = 0
if (-not [int]::TryParse($properties['port'], [ref]$port) -or $port -lt 1 -or $port -gt 65535 -or $properties['token'] -notmatch '^[a-f0-9]{64}$') { throw 'Bridge descriptor is invalid.' }
try {
  $headers = @{ Authorization = 'Bearer ' + $properties['token'] }
  $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -Headers $headers -TimeoutSec 3
  [pscustomobject]@{ DescriptorPresent = $true; HostReady = ($health.ok -eq $true); ClientReady = ($health.clientReady -eq $true); Port = $port }
} catch {
  [pscustomobject]@{ DescriptorPresent = $true; HostReady = $false; ClientReady = $false; Port = $port }
  exit 1
}
