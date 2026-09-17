param([Parameter(Mandatory)][string]$Dependency)
$ErrorActionPreference = 'Stop'
# Use the VS instance selected by node-gyp, not an unrelated MSBuild on PATH.
$config = Get-Content -LiteralPath (Join-Path $Dependency 'build/config.gypi') -Raw
$config = ($config -split "`n" | Where-Object { -not $_.StartsWith('#') }) -join "`n" | ConvertFrom-Json
$vs = $config.variables.msbuild_path
if (-not (Test-Path -LiteralPath $vs)) { throw 'node-gyp did not resolve MSBuild' }
$project = Join-Path $Dependency 'build/conpty.vcxproj'
$properties = & $vs $project /nologo '/p:Configuration=Release;Platform=x64' '-getProperty:LibraryPath,VCToolsInstallDir,VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre'
if ($LASTEXITCODE -ne 0) { throw 'MSBuild property inspection failed' }
$properties = ($properties -join "`n" | ConvertFrom-Json).Properties
$spectre = $properties.VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre
$extra = @()
if (-not (Test-Path -LiteralPath $spectre)) {
  # Pinned official Microsoft package; no installer/admin changes, no /Qspectre removal.
  if ((Split-Path $properties.VCToolsInstallDir.TrimEnd('\') -Leaf) -ne '14.44.35207') {
    throw 'Install the matching MSVC Spectre libraries for this toolset'
  }
  $cache = Join-Path $env:LOCALAPPDATA 'Thyrqel/build-tools/msvc-14.44.35226-spectre'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $archive = Join-Path $cache 'spectre.vsix'
  $expected = '6d7cb93cc7fdc206f44999850b414600ae1041d0db7d2fe9d0ff658abfb97b58'
  if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri "https://download.visualstudio.microsoft.com/download/pr/67cf767c-5e71-47c2-a54a-cd5631e28942/$expected/Microsoft.VC.14.44.17.14.CRT.x64.Desktop.spectre.base.vsix" -OutFile $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw "Spectre package hash mismatch: $archive"
  }
  # Re-extract verified bytes so a stale cache cannot silently change the link inputs.
  $extracted = Join-Path $cache 'extracted'
  [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted, $true)
  $spectre = Join-Path $extracted 'Contents/VC/Tools/MSVC/14.44.35207/lib/spectre/x64'
  $base = Join-Path $properties.VCToolsInstallDir 'lib/x64'
  $libraries = "$spectre;$base;$($properties.LibraryPath)".Replace(';', '%3B')
  $extra = @("/p:VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre=$spectre", "/p:LibraryPath=$libraries")
}
& $vs $project /nologo /nodeReuse:false /clp:Verbosity=minimal '/p:Configuration=Release;Platform=x64' @extra
if ($LASTEXITCODE -ne 0) { throw "Patched ConPTY build failed: $LASTEXITCODE" }
