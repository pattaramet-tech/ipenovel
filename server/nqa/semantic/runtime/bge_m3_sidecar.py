from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

MODEL_NAME = os.environ.get("NQA_BGE_MODEL", "BAAI/bge-m3")
MODEL_REVISION = os.environ.get(
    "NQA_BGE_MODEL_REVISION",
    "5617a9f61b028005a4858fdac845db406aefb181",
)
CACHE_DIR = os.environ.get(
    "NQA_BGE_CACHE",
    r"C:\AI-Workspace\runtimes\nqa-bge-m3\hf-cache",
)
HOST = "127.0.0.1"
PORT = int(os.environ.get("NQA_BGE_PORT", "8765"))
BATCH_SIZE = max(1, int(os.environ.get("NQA_BGE_BATCH_SIZE", "4")))
MAX_TEXTS = max(1, int(os.environ.get("NQA_BGE_MAX_TEXTS", "128")))
MAX_TEXT_CHARS = max(
    1, int(os.environ.get("NQA_BGE_MAX_TEXT_CHARS", "200000"))
)
REQUIRE_CUDA = os.environ.get("NQA_BGE_REQUIRE_CUDA", "1") != "0"

if REQUIRE_CUDA and not torch.cuda.is_available():
    raise RuntimeError("NQA BGE-M3 sidecar requires CUDA.")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

load_started = time.perf_counter()
TOKENIZER = AutoTokenizer.from_pretrained(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_dir=CACHE_DIR,
)
MODEL = AutoModel.from_pretrained(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_dir=CACHE_DIR,
    dtype=DTYPE,
).to(DEVICE)
MODEL.eval()
LOAD_SECONDS = time.perf_counter() - load_started

DIMENSION = int(MODEL.config.hidden_size)
MAX_LENGTH = min(8192, int(TOKENIZER.model_max_length))
def embed_texts(texts: list[str]) -> list[list[float]]:
    vectors: list[list[float]] = []

    for start in range(0, len(texts), BATCH_SIZE):
        batch = texts[start : start + BATCH_SIZE]
        encoded = TOKENIZER(
            batch,
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        )
        encoded = {key: value.to(DEVICE) for key, value in encoded.items()}

        with torch.inference_mode():
            hidden = MODEL(**encoded).last_hidden_state[:, 0]
            dense = F.normalize(hidden.float(), p=2, dim=1)

        vectors.extend(dense.cpu().tolist())

    return vectors


class Handler(BaseHTTPRequestHandler):
    server_version = "NqaBgeM3Sidecar/1.0"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
                "dimension": DIMENSION,
                "max_length": MAX_LENGTH,
                "batch_size": BATCH_SIZE,
                "load_seconds": round(LOAD_SECONDS, 3),
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
        if self.path != "/embed":
            self._json(404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "invalid_content_length"})
            return

        if length <= 0 or length > 30_000_000:
            self._json(413, {"error": "request_too_large"})
            return

        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(400, {"error": "invalid_json"})
            return

        model_name = payload.get("model")
        texts = payload.get("texts")

        if model_name != MODEL_NAME:
            self._json(400, {"error": "model_mismatch"})
            return
        if not isinstance(texts, list) or not texts:
            self._json(400, {"error": "texts_required"})
            return
        if len(texts) > MAX_TEXTS:
            self._json(413, {"error": "too_many_texts"})
            return
        if any(not isinstance(text, str) for text in texts):
            self._json(400, {"error": "texts_must_be_strings"})
            return
        if any(len(text) > MAX_TEXT_CHARS for text in texts):
            self._json(413, {"error": "text_too_large"})
            return

        started = time.perf_counter()
        try:
            vectors = embed_texts(texts)
        except RuntimeError:
            self._json(500, {"error": "embedding_failed"})
            return

        self._json(
            200,
            {
                "vectors": vectors,
                "model": MODEL_NAME,
                "model_revision": MODEL_REVISION,
                "dimension": DIMENSION,
                "elapsed_ms": round(
                    (time.perf_counter() - started) * 1000, 1
                ),
            },
        )

    def log_message(self, format: str, *args: Any) -> None:
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
                "dimension": DIMENSION,
                "max_length": MAX_LENGTH,
                "load_seconds": round(LOAD_SECONDS, 3),
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
