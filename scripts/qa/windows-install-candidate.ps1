param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Use a disposable GitHub-hosted Windows runner'
}
# NSIS may hand off to a child installer. Start-Process -Wait waits for the
# complete process tree, matching the original package acceptance workflow.
$process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallRoot") -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "NSIS installation failed: $($process.ExitCode)" }
