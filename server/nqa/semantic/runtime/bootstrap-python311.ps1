param(
  [string]$TargetDir = "C:\AI-Workspace\runtimes\python311"
)

$ErrorActionPreference = "Stop"

$Version = "3.11.9"
$InstallerUrl = "https://www.python.org/ftp/python/$Version/python-$Version-amd64.exe"
$ExpectedSha256 = "5EE42C4EEE1E6B4464BB23722F90B45303F79442DF63083F05322F1785F5FDDE"
$DownloadDir = "C:\AI-Workspace\runtimes\downloads"
$Installer = Join-Path $DownloadDir "python-$Version-amd64.exe"

New-Item -ItemType Directory -Force $DownloadDir | Out-Null

if (-not (Test-Path $Installer)) {
  Invoke-WebRequest -Uri $InstallerUrl -OutFile $Installer
}

$ActualSha256 = (Get-FileHash $Installer -Algorithm SHA256).Hash
if ($ActualSha256 -ne $ExpectedSha256) {
  throw "Python installer SHA-256 mismatch."
}

& $Installer /quiet InstallAllUsers=0 TargetDir="$TargetDir" PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 Include_pip=1 Include_dev=1

$PythonExe = Join-Path $TargetDir "python.exe"
if (-not (Test-Path $PythonExe)) {
  throw "Python installation did not create $PythonExe"
}

& $PythonExe --version
