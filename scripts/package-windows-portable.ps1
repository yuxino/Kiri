# Package the already-built Windows executable without starting a second build.
param(
  [string]$Executable = 'src-tauri/target/release/kiri.exe',
  [string]$RuntimeDirectory = (Join-Path (Split-Path $Executable) 'ocr-runtime')
)
if ($env:OS -ne 'Windows_NT' -or -not $env:RUNNER_TEMP) {
  throw 'Run on a Windows CI runner'
}
$ErrorActionPreference = 'Stop'
$version = (Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json).version
$portableDir = Join-Path $env:RUNNER_TEMP 'kiri-portable'
$verifyDir = Join-Path $env:RUNNER_TEMP 'kiri-portable-verify'
$archive = "Kiri-$version-Windows-x64-Portable.zip"
if (-not (Test-Path $executable)) { throw 'Missing Windows release executable' }
node src-tauri/ocr/windows-runtime.mjs --verify $RuntimeDirectory
if ($LASTEXITCODE -ne 0) { throw 'The release build has an invalid OCR runtime' }
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item $executable (Join-Path $portableDir 'kiri.exe') -Force
$portableRuntime = Join-Path $portableDir 'ocr-runtime'
New-Item -ItemType Directory -Force -Path $portableRuntime | Out-Null
# The verifier above checks the exact file set and the hash of every model.
Get-ChildItem -LiteralPath $RuntimeDirectory -File | Copy-Item -Destination $portableRuntime -Force
New-Item -ItemType File -Force -Path (Join-Path $portableDir 'kiri.portable') | Out-Null
Compress-Archive -Path (Join-Path $portableDir '*') -DestinationPath $archive -Force
Expand-Archive -Path $archive -DestinationPath $verifyDir -Force
$expected = (Get-FileHash $executable).Hash
$actual = (Get-FileHash (Join-Path $verifyDir 'kiri.exe')).Hash
$contents = @(Get-ChildItem $verifyDir | ForEach-Object Name | Sort-Object)
if ($expected -ne $actual -or ($contents -join ',') -ne 'kiri.exe,kiri.portable,ocr-runtime') {
  throw 'Portable archive verification failed'
}
node src-tauri/ocr/windows-runtime.mjs --verify (Join-Path $verifyDir 'ocr-runtime')
if ($LASTEXITCODE -ne 0) { throw 'Portable OCR verification failed' }
Write-Host "Verified $archive against the release executable"
