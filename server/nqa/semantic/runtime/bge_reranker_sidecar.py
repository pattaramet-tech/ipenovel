from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
)

MODEL_NAME = os.environ.get(
    "NQA_RERANK_MODEL",
    "BAAI/bge-reranker-v2-m3",
)
MODEL_REVISION = os.environ.get(
    "NQA_RERANK_MODEL_REVISION",
    "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
)
CACHE_DIR = os.environ.get(
    "NQA_RERANK_CACHE",
    r"C:\AI-Workspace\runtimes\nqa-bge-reranker-v2-m3\hf-cache",
)
HOST = "127.0.0.1"
PORT = int(os.environ.get("NQA_RERANK_PORT", "8766"))
BATCH_SIZE = max(
    1, int(os.environ.get("NQA_RERANK_BATCH_SIZE", "8"))
)
MAX_PAIRS = max(
    1, int(os.environ.get("NQA_RERANK_MAX_PAIRS", "256"))
)
MAX_TEXT_CHARS = max(
    1, int(os.environ.get("NQA_RERANK_MAX_TEXT_CHARS", "20000"))
)
REQUIRE_CUDA = (
    os.environ.get("NQA_RERANK_REQUIRE_CUDA", "1") != "0"
)

if REQUIRE_CUDA and not torch.cuda.is_available():
    raise RuntimeError("NQA reranker sidecar requires CUDA.")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

load_started = time.perf_counter()
TOKENIZER = AutoTokenizer.from_pretrained(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_dir=CACHE_DIR,
)
MODEL = AutoModelForSequenceClassification.from_pretrained(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_dir=CACHE_DIR,
    dtype=DTYPE,
).to(DEVICE)
MODEL.eval()
LOAD_SECONDS = time.perf_counter() - load_started
MAX_LENGTH = min(8192, int(TOKENIZER.model_max_length))


def score_pairs(
    pairs: list[dict[str, str]]
) -> list[dict[str, float | str]]:
    output: list[dict[str, float | str]] = []

    for start in range(0, len(pairs), BATCH_SIZE):
        batch = pairs[start : start + BATCH_SIZE]
        queries = [pair["query"] for pair in batch]
        passages = [pair["passage"] for pair in batch]

        encoded = TOKENIZER(
            queries,
            passages,
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        )
        encoded = {
            key: value.to(DEVICE)
            for key, value in encoded.items()
        }

        with torch.inference_mode():
            logits = MODEL(**encoded).logits.view(-1)
            scores = torch.sigmoid(logits.float())

        for pair, score in zip(batch, scores.cpu().tolist()):
            output.append(
                {
                    "pairId": pair["pairId"],
                    "score": float(score),
                }
            )

    return output


class Handler(BaseHTTPRequestHandler):
    server_version = "NqaBgeRerankerSidecar/1.0"

    def _json(
        self, status: int, payload: dict[str, Any]
    ) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
        self.send_header(
            "Content-Length", str(len(body))
        )
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._json(404, {"error": "not_found"})
            return

        self._json(
            200,
            {
                "status": "ok",
                "model": MODEL_NAME,
                "model_revision": MODEL_REVISION,
                "device": DEVICE,
                "dtype": str(DTYPE),
                "max_length": MAX_LENGTH,
                "batch_size": BATCH_SIZE,
                "load_seconds": round(
                    LOAD_SECONDS, 3
                ),
                "torch": torch.__version__,
                "cuda": torch.version.cuda,
                "gpu": (
                    torch.cuda.get_device_name(0)
                    if torch.cuda.is_available()
                    else None
                ),
            },
        )

    def do_POST(self) -> None:
        if self.path != "/rerank":
            self._json(404, {"error": "not_found"})
            return

        try:
            length = int(
                self.headers.get("Content-Length", "0")
            )
        except ValueError:
            self._json(
                400,
                {"error": "invalid_content_length"},
            )
            return

        if length <= 0 or length > 30_000_000:
            self._json(
                413, {"error": "request_too_large"}
            )
            return

        try:
            payload = json.loads(
                self.rfile.read(length).decode("utf-8")
            )
        except Exception:
            self._json(400, {"error": "invalid_json"})
            return

        if payload.get("model") != MODEL_NAME:
            self._json(
                400, {"error": "model_mismatch"}
            )
            return

        pairs = payload.get("pairs")
        if not isinstance(pairs, list) or not pairs:
            self._json(
                400, {"error": "pairs_required"}
            )
            return
        if len(pairs) > MAX_PAIRS:
            self._json(
                413, {"error": "too_many_pairs"}
            )
            return

        normalized: list[dict[str, str]] = []
        seen_ids: set[str] = set()

        for pair in pairs:
            if not isinstance(pair, dict):
                self._json(
                    400, {"error": "invalid_pair"}
                )
                return

            pair_id = pair.get("pairId")
            query = pair.get("query")
            passage = pair.get("passage")
            if (
                not isinstance(pair_id, str)
                or not pair_id
                or pair_id in seen_ids
                or not isinstance(query, str)
                or not query.strip()
                or not isinstance(passage, str)
                or not passage.strip()
            ):
                self._json(
                    400, {"error": "invalid_pair"}
                )
                return

            if (
                len(query) > MAX_TEXT_CHARS
                or len(passage) > MAX_TEXT_CHARS
            ):
                self._json(
                    413, {"error": "text_too_large"}
                )
                return

            seen_ids.add(pair_id)
            normalized.append(
                {
                    "pairId": pair_id,
                    "query": query,
                    "passage": passage,
                }
            )

        started = time.perf_counter()
        try:
            scores = score_pairs(normalized)
        except RuntimeError:
            self._json(
                500, {"error": "reranking_failed"}
            )
            return

        self._json(
            200,
            {
                "scores": scores,
                "model": MODEL_NAME,
                "model_revision": MODEL_REVISION,
                "elapsed_ms": round(
                    (
                        time.perf_counter()
                        - started
                    )
                    * 1000,
                    1,
                ),
            },
        )

    def log_message(
        self, format: str, *args: Any
    ) -> None:
        return


def main() -> None:
    print(
        json.dumps(
            {
                "event": "ready",
                "host": HOST,
                "port": PORT,
                "model": MODEL_NAME,
                "model_revision": MODEL_REVISION,
                "device": DEVICE,
                "max_length": MAX_LENGTH,
                "load_seconds": round(
                    LOAD_SECONDS, 3
                ),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
