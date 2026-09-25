# M09A — Verification Report

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M09A commit:

`9f682173c0a092b49a7526a6747c98afaff42e3c`

Before M09A:

- M09 was committed locally
- M09 was pushed to origin/feat/nqa-foundation
- remote SHA was verified to match 9f68217

M09A remains unmerged from main.

## Runtime provisioning evidence

Python:

```text
C:\AI-Workspace\runtimes\python311\python.exe
Python 3.11.9
```

The normal Python launcher/PATH was intentionally not required.

Python installer:

- source: python.org official 3.11.9 Windows amd64 installer
- verified SHA-256:
  `5EE42C4EEE1E6B4464BB23722F90B45303F79442DF63083F05322F1785F5FDDE`

Virtual environment:

```text
C:\AI-Workspace\runtimes\nqa-bge-m3\venv
```

PyTorch:

```text
2.9.1+cu130
CUDA 13.0
cuda_available = true
NVIDIA GeForce RTX 5070
compute capability = 12.0
```

## Runtime dependency boundary

The accepted embedding runtime uses:

- torch
- transformers
- NumPy
- Hugging Face model files

It does not import sentence-transformers or scikit-learn.

During re-verification, sentence-transformers and its optional scientific-stack dependencies were temporarily installed only for an exploratory comparison. They were removed again before the final gate so the accepted venv matches the repository-managed direct-transformers sidecar.

Direct transformers import, CUDA availability, pinned offline model load, and model execution were re-tested successfully.

## Model verification

Model:
`BAAI/bge-m3`

Pinned revision:
`5617a9f61b028005a4858fdac845db406aefb181`

Verified pooling config from the model repository:

```text
word_embedding_dimension = 1024
pooling_mode_cls_token = true
pooling_mode_mean_tokens = false
```

Direct model smoke:

```text
dimension = 1024
dtype = torch.float16
tokenizer model max length = 8192
GPU = NVIDIA GeForce RTX 5070
VRAM allocated after short smoke ≈ 1092 MiB
VRAM reserved ≈ 1112 MiB
EN/TH short-pair cosine ≈ 0.74706
```

After cleanup, the Hugging Face cache index contains only pinned revision `5617a9f61b028005a4858fdac845db406aefb181` and reports approximately 2.3 GB of model content. The physical HF_HOME footprint may be larger because Hugging Face/Xet maintains shared blob/cache data.

## Offline sidecar verification

Final normal startup was performed using the repository-managed:

`server/nqa/semantic/runtime/start-sidecar.ps1`

The script sets:

- pinned model revision
- CUDA-required mode
- loopback port
- external model cache
- HF_HUB_OFFLINE=1
- TRANSFORMERS_OFFLINE=1

Final startup produced no Hugging Face network warning.

Ready event:

```json
{
  "host": "127.0.0.1",
  "port": 8765,
  "model": "BAAI/bge-m3",
  "model_revision": "5617a9f61b028005a4858fdac845db406aefb181",
  "device": "cuda",
  "dimension": 1024,
  "max_length": 8192
}
```

Health endpoint returned:

- status ok
- torch 2.9.1+cu130
- CUDA 13.0
- RTX 5070
- float16
- batch size 4
- pinned model revision

## Live Google evidence

English source:

- document ID: 1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q
- source revision:
  `ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk`
- parsed source chapters: 49
- parsed range: 182-230

Current Thai:

- document ID: 1iLE_8KxtftOIcZuRuU30CVmOQM0W3CnF4HWARAT3vjY
- current revision token:
  `ANLCKQmKbq-ZJzMyvDUPEZYooBvgZMlAQj96UTF-wQJrmvUAm6gyY5FFxP3Ig6vj7zJLPcRQ0UmbBjWN6CEYvbPM5_XiPCzlgFQ0oR-H9pQ`
- Chapter 197 tab: t.bf525hytchcg
- current heading: บทที่ 197 การสิงร่าง(แปลใหม่)

Google Drive revision history:

- revisions exposed: 1, 52, 69, 90
- previousRevisionId: 69
- revision 69 modified: 2026-09-19T20:21:09.236Z
- revision 69 Chapter 197 heading: บทที่ 197 ค้นหาและช่วยเหลือ

Revision 69 was fetched using read-only revision export.

## Smoke snapshot evidence

Canonical smoke snapshot path:

`C:\AI-Workspace\runtimes\nqa-bge-m3\smoke\canonical-197.jsonl`

Records:

- 1 metadata record
- 49 source chapter records
- 1 current corrected translation record
- 1 historical revision-69 translation record

Snapshot SHA-256:

`2e554d9d47da61c272d8214149213c24faf07454f1a64819d8459f048da1fc59`

The snapshot is deliberately outside the repository because it contains novel text.

No full novel text was added to Git.

## Current corrected result

Final offline M09 core result:

```text
decision: PASS
expected rank: 1
expected similarity: 0.819802054
expected lead over alternate: 0.038111493
best source: chapter 197 / Possessing
best alternate: chapter 196 / Search and Rescue
alternate similarity: 0.781690561
```

Top-five ranking:

1. 197 — 0.819802054
2. 196 — 0.781690561
3. 194 — 0.747153661
4. 184 — 0.739128835
5. 200 — 0.723910053

Final offline search latency:
approximately 4.86 seconds for 49 source chapters.

A separate warm run measured approximately 4.28 seconds.

## Historical revision-69 result

Final offline M09 core result:

```text
decision: REVIEW
reason: LOW_CONFIDENCE
expected rank: 1
expected similarity: 0.711915227
expected lead over alternate: 0.011414666
best source: chapter 197 / Possessing
best alternate: chapter 211 / Rinnegan
alternate similarity: 0.700500562
```

Top-five ranking:

1. 197 — 0.711915227
2. 211 — 0.700500562
3. 192 — 0.700069590
4. 201 — 0.694832402
5. 191 — 0.692100378

Final offline search latency:
approximately 4.22 seconds for 49 source chapters.

## Negative-control interpretation

Historical revision 69 is known-bad from the canonical human investigation.

M09 does not classify it as WRONG_CHAPTER because expected source 197 still ranks first.

Instead it returns REVIEW because the expected lead is:

`0.011414666`

which is below:

`minExpectedLeadPass = 0.02`

This is the intended fail-safe behavior.

M09 does not overstate chapter-level embedding evidence.

The measured gap between controls is substantial:

```text
current expected similarity  ≈ 0.819802
historical expected similarity ≈ 0.711915
difference ≈ 0.107887

current expected lead ≈ 0.038111
historical expected lead ≈ 0.011415
difference ≈ 0.026697
```

The historical case therefore reaches REVIEW instead of an unsafe PASS.

## Evidence files

Final offline result path:

`C:\AI-Workspace\runtimes\nqa-bge-m3\smoke\m09a-offline-result.json`

Result SHA-256:

`7aeec91aed710a25948f287155075d115e57a43290362a50e03dd01783b24502`

The result file contains ranking metadata/hashes, not a replacement production artifact.

Smoke source/result files remain outside Git.

## Repository changes

M09A adds only NQA runtime/support/docs:

- Python sidecar
- Python bootstrap script
- venv/model provision script
- sidecar start script
- actual-M09-core smoke runner
- runtime static tests
- docs

No shared application integration is introduced.

## Final verification

Final runtime and repository gate:

```text
python -m py_compile
PASS

PowerShell parser validation
PASS

pip check
No broken requirements found.

runtime static tests
1 test file / 9 tests PASS

full NQA regression
30 test files / 186 tests PASS

pnpm check / tsc --noEmit
PASS

git diff --check
PASS
```

The final offline pinned sidecar was re-started through `start-sidecar.ps1` and re-ran the canonical snapshot through the repository-managed `m09a-smoke.ts`.

Re-verification preserved the same semantic conclusions:

- current corrected Chapter 197: PASS, rank 1, similarity 0.819802054, lead 0.038111493
- historical revision 69: REVIEW / LOW_CONFIDENCE, rank 1, similarity 0.711915227, lead 0.011414666
- current best alternate: Chapter 196
- historical best alternate: Chapter 211

Re-verification result path:

`C:\AI-Workspace\runtimes\nqa-bge-m3\smoke\m09a-reverify-result.json`

Re-verification result SHA-256:

`3f066607bf5cbe4ef6837e0b3989d404596ca5291e77b0aa25020c4ee9eeb774`

Final safety gate additionally verifies:

- no secrets staged
- no smoke novel-text snapshots staged
- no model weights/cache staged
- no client/router/workspace/Drizzle/migration/package changes
- sidecar binds loopback only
- no paid-model endpoint
- model/runtime versions are pinned
- canonical M02 fixture files are unchanged

## Acceptance

M09A is accepted.

Next engineering milestone:
**M10 — Cross-Encoder + Monotonic Alignment**
