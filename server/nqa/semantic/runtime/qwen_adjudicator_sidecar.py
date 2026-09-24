from __future__ import annotations

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_NAME = os.environ.get("NQA_ADJ_MODEL", "Qwen/Qwen3-1.7B")
MODEL_REVISION = os.environ.get(
    "NQA_ADJ_MODEL_REVISION",
    "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e",
)
CACHE_DIR = os.environ.get(
    "NQA_ADJ_CACHE",
    "C:/AI-Workspace/runtimes/nqa-qwen3-1.7b/hf-cache",
)
HOST = "127.0.0.1"
PORT = int(os.environ.get("NQA_ADJ_PORT", "8767"))
MAX_BODY_BYTES = max(
    1024,
    int(os.environ.get("NQA_ADJ_MAX_BODY_BYTES", str(4 * 1024 * 1024))),
)
MAX_INPUT_TOKENS = max(
    512, int(os.environ.get("NQA_ADJ_MAX_INPUT_TOKENS", "8192"))
)
MAX_NEW_TOKENS = max(
    64, int(os.environ.get("NQA_ADJ_MAX_NEW_TOKENS", "256"))
)
REQUIRE_CUDA = os.environ.get("NQA_ADJ_REQUIRE_CUDA", "1") != "0"

ALLOWED_DECISIONS = {"PASS", "REVIEW", "FAIL"}
ALLOWED_REASONS = {
    "MEANING_DIVERGENCE",
    "EVENT_MISMATCH",
    "ENTITY_MISMATCH",
    "RELATIONSHIP_MISMATCH",
    "CAUSALITY_MISMATCH",
    "CHRONOLOGY_MISMATCH",
    "CONTRADICTION",
    "OMISSION_MAJOR",
    "ADDITION_MAJOR",
    "FABRICATION_SUSPECTED",
    "WRONG_CHAPTER",
    "SOURCE_DRIFT",
    "LOW_CONFIDENCE",
    "MODEL_DISAGREEMENT",
    "ALIGNMENT_UNCERTAIN",
    "INSUFFICIENT_EVIDENCE",
    "HUMAN_REVIEW_REQUIRED",
}

if REQUIRE_CUDA and not torch.cuda.is_available():
    raise RuntimeError("NQA adjudicator sidecar requires CUDA.")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

load_started = time.perf_counter()
TOKENIZER = AutoTokenizer.from_pretrained(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_dir=CACHE_DIR,
)
MODEL = AutoModelForCausalLM.from_pretrained(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_dir=CACHE_DIR,
    dtype=DTYPE,
).to(DEVICE)
MODEL.eval()
LOAD_SECONDS = time.perf_counter() - load_started

SYSTEM_PROMPT = """You are the bounded adjudicator in a translation QA pipeline.
Use only the evidence object supplied by the application.
Do not assume access to the full novel, outside knowledge, or omitted text.
Judge whether the bounded English source and Thai translation evidence supports PASS, FAIL, or REVIEW.
PASS means the bounded evidence supports semantic fidelity.
FAIL requires clear bounded evidence of a material semantic defect.
REVIEW means evidence is insufficient, mixed, or confidence is too low.
Use ONLY these exact reason codes when decision is REVIEW or FAIL:
MEANING_DIVERGENCE, EVENT_MISMATCH, ENTITY_MISMATCH, RELATIONSHIP_MISMATCH,
CAUSALITY_MISMATCH, CHRONOLOGY_MISMATCH, CONTRADICTION, OMISSION_MAJOR,
ADDITION_MAJOR, FABRICATION_SUSPECTED, WRONG_CHAPTER, SOURCE_DRIFT,
LOW_CONFIDENCE, MODEL_DISAGREEMENT, ALIGNMENT_UNCERTAIN,
INSUFFICIENT_EVIDENCE, HUMAN_REVIEW_REQUIRED.
Never invent a positive reason code such as ALIGNMENT_CERTAIN.
If decision is PASS, reasonCodes MUST be [].
Return one JSON object only with keys decision, reasonCodes, confidence, boundedRationale.
The rationale must be under 700 characters and must not quote long passages."""

def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^\x60\x60\x60(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*\x60\x60\x60$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("missing_json_object")
    return json.loads(cleaned[start : end + 1])

def validate_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid_result")
    decision = value.get("decision")
    reasons = value.get("reasonCodes")
    confidence = value.get("confidence")
    rationale = value.get("boundedRationale")
    if decision not in ALLOWED_DECISIONS:
        raise ValueError("invalid_decision")
    if not isinstance(reasons, list):
        raise ValueError("invalid_reason_codes")
    normalized_reasons: list[str] = []
    if decision != "PASS":
        for reason in reasons:
            if not isinstance(reason, str) or reason not in ALLOWED_REASONS:
                safe_reason = reason if isinstance(reason, str) else "non_string"
                raise ValueError("invalid_reason_code:" + safe_reason[:80])
            if reason not in normalized_reasons:
                normalized_reasons.append(reason)
    if (
        not isinstance(confidence, (int, float))
        or isinstance(confidence, bool)
        or not 0 <= float(confidence) <= 1
    ):
        raise ValueError("invalid_confidence")
    if not isinstance(rationale, str) or len(rationale) > 1000:
        raise ValueError("invalid_rationale")
    return {
        "decision": decision,
        "reasonCodes": normalized_reasons,
        "confidence": float(confidence),
        "boundedRationale": rationale.strip(),
        "modelVersion": f"{MODEL_NAME}@{MODEL_REVISION}",
    }

def adjudicate(evidence: dict[str, Any]) -> dict[str, Any]:
    user_payload = json.dumps(
        {"evidence": evidence},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_payload},
    ]
    try:
        rendered = TOKENIZER.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
    except TypeError:
        rendered = TOKENIZER.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    encoded = TOKENIZER(
        rendered,
        return_tensors="pt",
        truncation=True,
        max_length=MAX_INPUT_TOKENS,
    )
    encoded = {key: value.to(DEVICE) for key, value in encoded.items()}
    input_length = int(encoded["input_ids"].shape[-1])
    with torch.inference_mode():
        output = MODEL.generate(
            **encoded,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            use_cache=True,
            pad_token_id=TOKENIZER.eos_token_id,
        )
    generated = output[0][input_length:]
    text = TOKENIZER.decode(generated, skip_special_tokens=True)
    return validate_result(extract_json_object(text))

class Handler(BaseHTTPRequestHandler):
    server_version = "NqaQwenAdjudicator/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header(
            "Content-Type", "application/json; charset=utf-8"
        )
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
                "max_input_tokens": MAX_INPUT_TOKENS,
                "max_new_tokens": MAX_NEW_TOKENS,
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
        if self.path != "/adjudicate":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "invalid_content_length"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(413, {"error": "request_body_out_of_bounds"})
            return
        try:
            payload = json.loads(
                self.rfile.read(length).decode("utf-8")
            )
        except Exception:
            self._json(400, {"error": "invalid_json"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"error": "invalid_request"})
            return
        if payload.get("model") != MODEL_NAME:
            self._json(400, {"error": "model_mismatch"})
            return
        evidence = payload.get("evidence")
        if not isinstance(evidence, dict):
            self._json(400, {"error": "evidence_required"})
            return
        started = time.perf_counter()
        try:
            result = adjudicate(evidence)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            self._json(503, {"error": "cuda_out_of_memory"})
            return
        except ValueError as exc:
            reason = str(exc)[:100]
            print(
                json.dumps(
                    {
                        "event": "model_output_invalid",
                        "reason": reason,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            self._json(
                422,
                {
                    "error": "invalid_model_output",
                    "reason": reason,
                },
            )
            return
        except Exception as exc:
            print(
                json.dumps(
                    {
                        "event": "adjudication_error",
                        "type": type(exc).__name__,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            self._json(500, {"error": "adjudication_failed"})
            return
        result["elapsedMs"] = round(
            (time.perf_counter() - started) * 1000, 1
        )
        self._json(200, result)

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
