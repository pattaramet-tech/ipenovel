param(
  [string]$PythonExe = "C:\AI-Workspace\runtimes\nqa-bge-m3\venv\Scripts\python.exe",
  [string]$RuntimeRoot = "C:\AI-Workspace\runtimes\nqa-qwen3-1.7b"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PythonExe)) {
  throw "M09A Python venv not found at $PythonExe"
}

New-Item -ItemType Directory -Force $RuntimeRoot | Out-Null
$ModelCache = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HOME = $ModelCache
$env:NQA_ADJ_CACHE = $ModelCache

$ProvisionScript = Join-Path $env:TEMP "nqa-m11-provision-qwen.py"
$ProvisionSource = @'
import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = "Qwen/Qwen3-1.7B"
REVISION = "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e"
CACHE = os.environ["NQA_ADJ_CACHE"]

if not torch.cuda.is_available():
    raise SystemExit("CUDA is required for M11 adjudicator runtime.")

AutoTokenizer.from_pretrained(
    MODEL,
    revision=REVISION,
    cache_dir=CACHE,
)
AutoModelForCausalLM.from_pretrained(
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
    throw "Qwen adjudicator provisioning failed with exit code $LASTEXITCODE"
  }
}
finally {
  Remove-Item $ProvisionScript -Force -ErrorAction SilentlyContinue
}
