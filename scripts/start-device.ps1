param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not [OperatingSystem]::IsWindows() -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
      [Runtime.InteropServices.Architecture]::X64) {
  throw 'The Thyrqel device runtime requires 64-bit Windows.'
}
$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.0.0') {
  throw 'Node.js 22 or newer is required.'
}
$configPath = Join-Path $env:LOCALAPPDATA 'Thyrqel/device.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw 'The local Thyrqel device configuration is missing.'
}

$headers = @{ 'User-Agent' = 'Thyrqel-device-launcher'; 'Accept' = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/4i7/Thyrqel/releases/latest' -Headers $headers
if ($release.tag_name -cnotmatch '^device-([0-9a-f]{40})$') {
  throw 'The latest GitHub release is not a commit-bound device release.'
}
$commit = $Matches[1]
$assets = @($release.assets | Where-Object { $_.name -eq 'device.zip' -and $_.state -eq 'uploaded' })
if ($assets.Count -ne 1 -or $assets[0].digest -cnotmatch '^sha256:([0-9a-f]{64})$') {
  throw 'The device release lacks one SHA-256-labelled runtime archive.'
}
$expectedHash = $Matches[1]
$asset = $assets[0]
$expectedUrl = "https://github.com/4i7/Thyrqel/releases/download/$($release.tag_name)/device.zip"
if ($asset.browser_download_url -cne $expectedUrl) {
  throw 'Unexpected device artifact download URL.'
}

$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$runtime = [IO.Path]::GetFullPath((Join-Path $tempRoot ('Thyrqel-runtime-' + [guid]::NewGuid().ToString('N'))))
if (-not $runtime.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Unsafe runtime staging path.'
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
try {
  $archive = Join-Path $runtime 'device.zip'
  Invoke-WebRequest -Uri $expectedUrl -Headers $headers -OutFile $archive
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne $expectedHash) { throw 'Device archive SHA-256 mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $runtime
  Remove-Item -LiteralPath $archive -Force
  $manifest = Get-Content -LiteralPath (Join-Path $runtime 'build.json') -Raw | ConvertFrom-Json
  if ($manifest.commit -cne $commit -or $manifest.nodeMajor -ne 22 -or
      $manifest.platform -cne 'win32' -or $manifest.arch -cne 'x64') {
    throw 'Device runtime metadata does not match its GitHub release.'
  }
  $entry = Join-Path $runtime 'dist/src/remote/device-cli.js'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'The device entry point is missing from the archive.'
  }
  if ($VerifyOnly) {
    & node -e "require(process.argv[1]); console.log('node-pty import PASS')" (Join-Path $runtime 'node_modules/node-pty')
    if ($LASTEXITCODE -ne 0) { throw 'The packaged node-pty module could not load.' }
    Write-Output "Verified GitHub device runtime: $commit"
  } else {
    Set-Location -LiteralPath $env:USERPROFILE
    Write-Output "Starting GitHub device runtime: $commit"
    & node $entry
    if ($LASTEXITCODE -ne 0) { throw "Thyrqel device exited with code $LASTEXITCODE" }
  }
} finally {
  if (-not $runtime.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe runtime cleanup path.'
  }
  Remove-Item -LiteralPath $runtime -Recurse -Force
}