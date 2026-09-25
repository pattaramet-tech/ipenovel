param(
  [string]$PythonExe = "C:\AI-Workspace\runtimes\nqa-bge-m3\venv\Scripts\python.exe",
  [string]$RuntimeRoot = "C:\AI-Workspace\runtimes\nqa-bge-reranker-v2-m3",
  [int]$Port = 8766,
  [int]$BatchSize = 8
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
$Sidecar = Join-Path $PSScriptRoot "bge_reranker_sidecar.py"

if (-not (Test-Path $PythonExe)) {
  throw "M09A Python venv not found."
}

$env:NQA_RERANK_MODEL = "BAAI/bge-reranker-v2-m3"
$env:NQA_RERANK_MODEL_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
$env:NQA_RERANK_CACHE = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HOME = $env:NQA_RERANK_CACHE
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:NQA_RERANK_PORT = [string]$Port
$env:NQA_RERANK_BATCH_SIZE = [string]$BatchSize
$env:NQA_RERANK_REQUIRE_CUDA = "1"

Set-Location $RepoRoot
& $PythonExe $Sidecar
