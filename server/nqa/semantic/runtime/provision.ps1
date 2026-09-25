param(
  [string]$PythonExe = "C:\AI-Workspace\runtimes\python311\python.exe",
  [string]$RuntimeRoot = "C:\AI-Workspace\runtimes\nqa-bge-m3"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PythonExe)) {
  throw "Python 3.11 runtime not found at $PythonExe"
}

$version = & $PythonExe --version 2>&1
if ($version -notmatch "^Python 3\.11\.") {
  throw "M09A runtime requires Python 3.11.x; found: $version"
}

New-Item -ItemType Directory -Force $RuntimeRoot | Out-Null
$VenvPython = Join-Path $RuntimeRoot "venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
  & $PythonExe -m venv (Join-Path $RuntimeRoot "venv")
}

& $VenvPython -m pip install --upgrade pip setuptools wheel
& $VenvPython -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cu130
& $VenvPython -m pip install transformers==5.17.0

$ModelCache = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HOME = $ModelCache

& $VenvPython -c @"
import torch
import transformers
from transformers import AutoModel, AutoTokenizer

MODEL = "BAAI/bge-m3"
REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
CACHE = r"$ModelCache"

if not torch.cuda.is_available():
    raise SystemExit("CUDA is required for M09A runtime.")

AutoTokenizer.from_pretrained(
    MODEL,
    revision=REVISION,
    cache_dir=CACHE,
)
AutoModel.from_pretrained(
    MODEL,
    revision=REVISION,
    cache_dir=CACHE,
    dtype=torch.float16,
)

print("torch=" + torch.__version__)
print("transformers=" + transformers.__version__)
print("cuda=" + str(torch.version.cuda))
print("gpu=" + torch.cuda.get_device_name(0))
print("model_revision=" + REVISION)
"@
