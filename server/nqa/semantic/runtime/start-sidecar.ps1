param(
  [string]$RuntimeRoot = "C:\AI-Workspace\runtimes\nqa-bge-m3",
  [int]$Port = 8765,
  [int]$BatchSize = 4
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
$PythonExe = Join-Path $RuntimeRoot "venv\Scripts\python.exe"
$Sidecar = Join-Path $PSScriptRoot "bge_m3_sidecar.py"

if (-not (Test-Path $PythonExe)) {
  throw "M09A venv not found. Run provision.ps1 first."
}

$env:NQA_BGE_MODEL = "BAAI/bge-m3"
$env:NQA_BGE_MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
$env:NQA_BGE_CACHE = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HOME = $env:NQA_BGE_CACHE
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:NQA_BGE_PORT = [string]$Port
$env:NQA_BGE_BATCH_SIZE = [string]$BatchSize
$env:NQA_BGE_REQUIRE_CUDA = "1"

Set-Location $RepoRoot
& $PythonExe $Sidecar
