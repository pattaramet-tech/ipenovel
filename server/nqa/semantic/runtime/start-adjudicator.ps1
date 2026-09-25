param(
  [string]$PythonExe = "C:\AI-Workspace\runtimes\nqa-bge-m3\venv\Scripts\python.exe",
  [string]$RuntimeRoot = "C:\AI-Workspace\runtimes\nqa-qwen3-1.7b",
  [int]$Port = 8767
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
$Sidecar = Join-Path $PSScriptRoot "qwen_adjudicator_sidecar.py"

if (-not (Test-Path $PythonExe)) {
  throw "M09A Python venv not found."
}

$env:NQA_ADJ_MODEL = "Qwen/Qwen3-1.7B"
$env:NQA_ADJ_MODEL_REVISION = "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e"
$env:NQA_ADJ_CACHE = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HOME = $env:NQA_ADJ_CACHE
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:NQA_ADJ_PORT = [string]$Port
$env:NQA_ADJ_REQUIRE_CUDA = "1"

Set-Location $RepoRoot
& $PythonExe $Sidecar
