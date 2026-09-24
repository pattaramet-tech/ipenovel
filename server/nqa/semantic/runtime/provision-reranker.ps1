param(
  [string]$PythonExe = "C:\AI-Workspace\runtimes\nqa-bge-m3\venv\Scripts\python.exe",
  [string]$RuntimeRoot = "C:\AI-Workspace\runtimes\nqa-bge-reranker-v2-m3"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PythonExe)) {
  throw "M09A Python venv not found at $PythonExe"
}

New-Item -ItemType Directory -Force $RuntimeRoot | Out-Null
$ModelCache = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HOME = $ModelCache
$env:NQA_RERANK_CACHE = $ModelCache

$ProvisionScript = Join-Path $env:TEMP "nqa-m10-provision-reranker.py"
$ProvisionSource = @'
import os
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL = "BAAI/bge-reranker-v2-m3"
REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
CACHE = os.environ["NQA_RERANK_CACHE"]

if not torch.cuda.is_available():
    raise SystemExit("CUDA is required for M10 reranker runtime.")

AutoTokenizer.from_pretrained(
    MODEL,
    revision=REVISION,
    cache_dir=CACHE,
)
AutoModelForSequenceClassification.from_pretrained(
    MODEL,
    revision=REVISION,
    cache_dir=CACHE,
    dtype=torch.float16,
)

print("torch=" + torch.__version__)
print("cuda=" + str(torch.version.cuda))
print("gpu=" + torch.cuda.get_device_name(0))
print("model_revision=" + REVISION)
'@

Set-Content -Path $ProvisionScript -Value $ProvisionSource -Encoding UTF8
try {
  & $PythonExe $ProvisionScript
  if ($LASTEXITCODE -ne 0) {
    throw "Reranker provisioning failed with exit code $LASTEXITCODE"
  }
}
finally {
  Remove-Item $ProvisionScript -Force -ErrorAction SilentlyContinue
}
