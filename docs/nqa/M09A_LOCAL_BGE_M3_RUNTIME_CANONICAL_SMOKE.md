# M09A — Local BGE-M3 Runtime Provisioning + Canonical Chapter 197 Smoke Test

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M09A provisions the real local dense-embedding runtime required by M09 and executes the canonical Chapter 197 shadow smoke against live Google source data and historical Google Drive revision data.

The milestone validates:

- isolated Python runtime
- CUDA/PyTorch compatibility
- pinned BAAI/bge-m3 model revision
- loopback-only embedding sidecar
- offline normal runtime after model pre-cache
- M09 TypeScript adapter/core against real BGE-M3 vectors
- current corrected Chapter 197 positive control
- historical bad revision 69 negative/review control

No production novel content is modified.

## Hardware

Machine: Makelleley

Observed hardware:

- GPU: NVIDIA GeForce RTX 5070
- VRAM: 12227 MiB reported by nvidia-smi
- GPU driver: 616.92
- compute capability reported by PyTorch: 12.0
- CPU: AMD Ryzen 7 5700G, 8 cores / 16 logical processors
- RAM: approximately 15.37 GiB
- C: free space before provisioning: approximately 313 GiB

PyTorch CUDA verification:

```text
torch = 2.9.1+cu130
cuda_available = true
cuda_version = 13.0
device = NVIDIA GeForce RTX 5070
VRAM = approximately 11.91 GiB from PyTorch
```

The GPU path is therefore active; M09A is not using CPU fallback.

## Isolated Python/runtime layout

Python was installed outside the repository and outside global PATH:

```text
C:\AI-Workspace\runtimes\python311\python.exe
Python 3.11.9
```

M09A venv:

```text
C:\AI-Workspace\runtimes\nqa-bge-m3\venv
```

Model cache:

```text
C:\AI-Workspace\runtimes\nqa-bge-m3\hf-cache
```

Smoke evidence:

```text
C:\AI-Workspace\runtimes\nqa-bge-m3\smoke
```

These directories are outside Git.

The repository contains only reproducible provisioning/start/smoke code.

## Runtime versions

Pinned/runtime versions used for the accepted smoke:

- Python 3.11.9
- PyTorch 2.9.1+cu130
- Transformers 5.17.0
- NumPy 2.4.6
- huggingface-hub 1.32.0
- tokenizers 0.23.2
- safetensors 0.8.0

The accepted runtime intentionally does not depend on sentence-transformers or scikit-learn.

The final runtime uses:

```text
torch + transformers + NumPy
```

directly.

During re-verification, sentence-transformers and its scientific-stack dependencies were installed only for an exploratory comparison and were then removed again. The accepted venv therefore remains on the direct-transformers path used by the repository sidecar.

## BGE-M3 model contract

Model:

`BAAI/bge-m3`

Pinned Hugging Face revision:

`5617a9f61b028005a4858fdac845db406aefb181`

Verified model configuration:

- embedding dimension: 1024
- tokenizer max length: 8192
- pooling: CLS token
- output: L2-normalized dense vector
- inference dtype on GPU: float16

The repository sidecar performs:

```python
hidden = model(**encoded).last_hidden_state[:, 0]
dense = F.normalize(hidden.float(), p=2, dim=1)
```

The model revision is pinned in both provisioning/start/runtime contracts.

## Runtime network boundary

Model provisioning may access Hugging Face once to populate the external cache.

Normal sidecar startup sets:

```text
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

The HTTP service binds only:

```text
127.0.0.1
```

Default endpoint:

```text
http://127.0.0.1:8765/embed
```

Health endpoint:

```text
http://127.0.0.1:8765/health
```

The sidecar refuses non-local exposure because host is hardcoded to loopback.

No OpenAI/Anthropic/Gemini/Cohere API is used.

No API key is required for normal cached operation.

## Sidecar health acceptance

Final offline health:

```json
{
  "status": "ok",
  "model": "BAAI/bge-m3",
  "model_revision": "5617a9f61b028005a4858fdac845db406aefb181",
  "device": "cuda",
  "dtype": "torch.float16",
  "dimension": 1024,
  "max_length": 8192,
  "batch_size": 4,
  "torch": "2.9.1+cu130",
  "cuda": "13.0",
  "gpu": "NVIDIA GeForce RTX 5070"
}
```

Offline model load from cache completed in approximately 2.9 seconds in the final verification run.

The final Hugging Face cache index contains only the pinned revision `5617a9f61b028005a4858fdac845db406aefb181`; the cache index reports approximately 2.3 GB of model content. The physical HF_HOME footprint may be larger because Hugging Face/Xet maintains shared blob/cache data.

A separate two-text model smoke produced a multilingual EN/TH cosine similarity of approximately 0.747 using the same direct CLS-pooling path.

## Canonical source snapshot

English source document:

`1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q`

Source revision used:

`ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk`

The current parser found 49 eligible source chapters:

```text
182 .. 230
```

Canonical expected chapter:

```text
internal sequence = 198
source chapter = 197
title = Possessing
```

The smoke search ranks all 49 parsed source chapters.

Snapshot file is outside Git:

```text
C:\AI-Workspace\runtimes\nqa-bge-m3\smoke\canonical-197.jsonl
```

Snapshot SHA-256:

`2e554d9d47da61c272d8214149213c24faf07454f1a64819d8459f048da1fc59`

## Translation controls

### Current corrected control

Current Google Doc revision token:

`ANLCKQmKbq-ZJzMyvDUPEZYooBvgZMlAQj96UTF-wQJrmvUAm6gyY5FFxP3Ig6vj7zJLPcRQ0UmbBjWN6CEYvbPM5_XiPCzlgFQ0oR-H9pQ`

Tab:

`t.bf525hytchcg`

Current heading:

`บทที่ 197 การสิงร่าง(แปลใหม่)`

Smoke variant:

`corrected_candidate`

### Historical bad control

Google Drive revision list exposed historical revision:

`69`

Revision modified time:

`2026-09-19T20:21:09.236Z`

Historical Chapter 197 was extracted from the revision-69 plain-text export between the Chapter 197 and Chapter 198 headings.

Historical heading:

`บทที่ 197 ค้นหาและช่วยเหลือ`

This is the real historical content, not a synthetic fixture.

## Current corrected live result

M09 TypeScript core result using real BGE-M3:

```text
decision = PASS
reasonCodes = []
expectedChapter = 197
expectedRank = 1
expectedSimilarity = 0.819802054
expectedLeadOverAlternate = 0.038111493
bestCandidate = 197 / Possessing
bestAlternate = 196 / Search and Rescue
bestAlternateSimilarity = 0.781690561
```

Top five source chapters:

1. 197 — Possessing — 0.819802054
2. 196 — Search and Rescue — 0.781690561
3. 194 — Rest — 0.747153661
4. 184 — Bind of The Past — 0.739128835
5. 200 — Preparation Completed — 0.723910053

Final offline warm search latency was approximately 4.86 seconds for the full 49-chapter scan.

## Historical revision-69 live result

M09 TypeScript core result using real BGE-M3:

```text
decision = REVIEW
reasonCodes = [LOW_CONFIDENCE]
expectedChapter = 197
expectedRank = 1
expectedSimilarity = 0.711915227
expectedLeadOverAlternate = 0.011414666
bestCandidate = 197 / Possessing
bestAlternate = 211 / Rinnegan
bestAlternateSimilarity = 0.700500562
```

Top five source chapters:

1. 197 — Possessing — 0.711915227
2. 211 — Rinnegan — 0.700500562
3. 192 — Treatment — 0.700069590
4. 201 — Seclusion — 0.694832402
5. 191 — A Twin — 0.692100378

Final offline warm search latency was approximately 4.22 seconds for the full 49-chapter scan.

## Interpretation

The positive control behaves as desired:

- expected Chapter 197 ranks first
- expected similarity is substantially higher
- lead over the best alternate exceeds the M09 PASS threshold

The historical bad revision does not produce WRONG_CHAPTER.

It still ranks expected Chapter 197 first, but:

- expected similarity drops by approximately 0.108
- expected lead drops from approximately 0.0381 to approximately 0.0114
- the lead falls below the configured 0.02 PASS threshold
- M09 therefore returns REVIEW + LOW_CONFIDENCE

This is an important measured result.

The historical defect is not a clean whole-chapter wrong-source substitution detectable by chapter-level dense retrieval alone.

Its known fabrication/event drift occurs within a chapter that still shares enough global semantic signal with expected Chapter 197 to remain rank 1.

Therefore M09 is working within its declared scope: it refuses to PASS the historical bad revision, but does not manufacture a false WRONG_CHAPTER failure.

## Consequence for M10

M10 is now supported by real evidence rather than architecture alone.

The next layer needs:

- semantic chunking
- top-k chunk retrieval
- cross-encoder reranking
- monotonic source/translation alignment
- coverage and gap accounting

These mechanisms can detect local scene divergence even when whole-chapter embeddings remain globally similar.

For historical revision 69 specifically, M10 should test whether:

- source Chapter 197 possession/mindscape chunks fail to align
- Thai Devon/laboratory/surgery/commander-search chunks align poorly with expected source
- unmatched Thai spans create ADDITION/FABRICATION evidence
- unmatched source spans create OMISSION evidence
- alternate source chunks from distant chapters receive stronger local matches

M09A therefore strengthens, rather than replaces, the M10 design.

## Repository/runtime files

Repository-managed runtime files:

- server/nqa/semantic/runtime/bootstrap-python311.ps1
- server/nqa/semantic/runtime/provision.ps1
- server/nqa/semantic/runtime/start-sidecar.ps1
- server/nqa/semantic/runtime/bge_m3_sidecar.py
- server/nqa/semantic/runtime/m09a-smoke.ts
- server/nqa/semantic/runtime/runtime.static.test.ts
- server/nqa/semantic/runtime/.gitignore

External runtime/cache/smoke files remain outside Git.

M09A is complete.
