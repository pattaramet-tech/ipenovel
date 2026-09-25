from __future__ import annotations

import hashlib
import json
import os
import re
import time
from difflib import SequenceMatcher
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
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
STRUCTURE_ENGINE_VERSION = "nqa-structure-runtime-v3"
RUNTIME_SOURCE_SHA256 = hashlib.sha256(
    Path(__file__).read_bytes()
).hexdigest()
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
STRUCTURE_MAX_NEW_TOKENS = max(
    256,
    int(os.environ.get("NQA_STRUCTURE_MAX_NEW_TOKENS", "640")),
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

THAI_CANONICALIZE_PROMPT = """You are a bounded Thai-to-English semantic canonicalizer.
Translate ONLY the supplied Thai translationText into concise English semantic text.
Preserve named entities, actions, objects, outcomes, relationships, cause/effect, negation, and event order.
Do not add facts, explain, summarize beyond the supplied text, or use outside context.
Return JSON only:
{"canonicalText":"..."}
Keep canonicalText under 1200 characters."""

def _contains_thai(text: str) -> bool:
    return any("\u0e00" <= char <= "\u0e7f" for char in text)

def canonicalize_translation_text(text: str) -> str:
    normalized = text.strip()
    if not normalized:
        raise ValueError("empty_translation_text")
    if not _contains_thai(normalized):
        return normalized

    messages = [
        {"role": "system", "content": THAI_CANONICALIZE_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {"translationText": normalized},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        },
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
    encoded = {
        key: value.to(DEVICE)
        for key, value in encoded.items()
    }
    input_length = int(encoded["input_ids"].shape[-1])

    with torch.inference_mode():
        output = MODEL.generate(
            **encoded,
            max_new_tokens=256,
            do_sample=False,
            use_cache=True,
            pad_token_id=TOKENIZER.eos_token_id,
        )

    generated = output[0][input_length:]
    text_output = TOKENIZER.decode(
        generated,
        skip_special_tokens=True,
    )
    parsed = extract_json_object(text_output)
    canonical = parsed.get("canonicalText")
    if (
        not isinstance(canonical, str)
        or not canonical.strip()
        or len(canonical) > 1200
    ):
        raise ValueError("invalid_canonical_translation")
    return canonical.strip()

FACT_EXTRACTION_PROMPT = """Extract compact semantic facts from exactly one English text.
Use only the supplied text. Return JSON only:
{
  "entities": [{"canonicalName":"name","role":"role or null"}],
  "events": [{"actor":"name or null","action":"short action","object":"short object or null","outcome":"short outcome or null","order":0}],
  "relationships": [{"subject":"name","relation":"short relation","object":"name"}],
  "causalLinks": [{"causeOrder":0,"effectOrder":1}]
}
Rules:
- Keep at most 6 entities and 6 events.
- Preserve event order.
- Do not invent relationships or causal links; use [] when absent.
- Named entities must use the spelling present in the supplied text.
- Use null, not the string "null", for missing fields.
"""

def _empty_structure_side() -> dict[str, Any]:
    return {
        "entities": [],
        "events": [],
        "relationships": [],
        "causalLinks": [],
    }

def _nullable_fact_text(value: Any, max_len: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or normalized.lower() in {"null", "none", "n/a"}:
        return None
    return normalized[:max_len]

def _fact_text(value: Any, max_len: int) -> str:
    normalized = _nullable_fact_text(value, max_len)
    if normalized is None:
        raise ValueError("invalid_fact_text")
    return normalized

def _normalize_extracted_side(
    value: Any,
    event_prefix: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid_fact_object")

    entities_value = value.get("entities") or []
    events_value = value.get("events") or []
    relationships_value = value.get("relationships") or []
    causal_value = value.get("causalLinks") or []

    if not isinstance(entities_value, list):
        entities_value = [entities_value]
    if not isinstance(events_value, list):
        events_value = [events_value]
    if not isinstance(relationships_value, list):
        relationships_value = [relationships_value]
    if not isinstance(causal_value, list):
        causal_value = [causal_value]

    if (
        len(entities_value) > 8
        or len(events_value) > 8
        or len(relationships_value) > 8
        or len(causal_value) > 8
    ):
        raise ValueError("fact_collection_too_large")

    entities: list[dict[str, Any]] = []
    for raw in entities_value:
        if isinstance(raw, str):
            name = _nullable_fact_text(raw, 120)
            role = None
        elif isinstance(raw, dict):
            name = _nullable_fact_text(
                raw.get("canonicalName")
                or raw.get("name")
                or raw.get("entity"),
                120,
            )
            role = _nullable_fact_text(raw.get("role"), 120)
        else:
            continue
        if name is not None:
            entities.append(
                {
                    "canonicalName": name,
                    "role": role,
                }
            )

    events: list[dict[str, Any]] = []
    for index, raw in enumerate(events_value):
        if not isinstance(raw, dict):
            continue
        action = _nullable_fact_text(raw.get("action"), 180)
        if action is None:
            continue
        raw_order = raw.get("order")
        if (
            isinstance(raw_order, (int, float))
            and not isinstance(raw_order, bool)
            and float(raw_order).is_integer()
            and 0 <= int(raw_order) <= 100
        ):
            order = int(raw_order)
        else:
            order = index
        events.append(
            {
                "eventId": f"{event_prefix}{len(events)}",
                "actor": _nullable_fact_text(raw.get("actor"), 120),
                "action": action,
                "object": _nullable_fact_text(raw.get("object"), 180),
                "outcome": _nullable_fact_text(raw.get("outcome"), 180),
                "order": order,
            }
        )

    relationships: list[dict[str, str]] = []
    for raw in relationships_value:
        if not isinstance(raw, dict):
            continue
        subject = _nullable_fact_text(raw.get("subject"), 120)
        relation = _nullable_fact_text(raw.get("relation"), 160)
        object_value = _nullable_fact_text(raw.get("object"), 120)
        if subject and relation and object_value:
            relationships.append(
                {
                    "subject": subject,
                    "relation": relation,
                    "object": object_value,
                }
            )

    causal_links: list[dict[str, str]] = []
    for raw in causal_value:
        if not isinstance(raw, dict):
            continue

        cause_order = raw.get("causeOrder")
        effect_order = raw.get("effectOrder")
        if (
            isinstance(cause_order, (int, float))
            and not isinstance(cause_order, bool)
            and float(cause_order).is_integer()
            and isinstance(effect_order, (int, float))
            and not isinstance(effect_order, bool)
            and float(effect_order).is_integer()
        ):
            cause_index = int(cause_order)
            effect_index = int(effect_order)
            if (
                0 <= cause_index < len(events)
                and 0 <= effect_index < len(events)
            ):
                causal_links.append(
                    {
                        "causeEventId": events[cause_index]["eventId"],
                        "effectEventId": events[effect_index]["eventId"],
                    }
                )
                continue

        cause_id = _nullable_fact_text(raw.get("causeEventId"), 80)
        effect_id = _nullable_fact_text(raw.get("effectEventId"), 80)
        if cause_id and effect_id:
            causal_links.append(
                {
                    "causeEventId": cause_id,
                    "effectEventId": effect_id,
                }
            )

    return {
        "entities": entities,
        "events": events,
        "relationships": relationships,
        "causalLinks": causal_links,
    }

def extract_structure_side(
    text: str | None,
    event_prefix: str,
) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip():
        return _empty_structure_side()

    messages = [
        {"role": "system", "content": FACT_EXTRACTION_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {"text": text.strip()},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        },
    ]

    last_error: Exception | None = None
    retry_instructions = [
        "",
        "\nRETRY MODE: Return one compact JSON object only. Include entities, events, relationships, causalLinks arrays even when empty. If the supplied text describes any action, events MUST contain at least one event. If named people or places appear, entities MUST contain them.",
        "\nMINIMAL FALLBACK MODE: Return JSON only. Focus on entities and events. relationships and causalLinks may be empty arrays. A non-empty sentence describing an action MUST produce at least one event. Named people or places MUST appear in entities.",
    ]
    for attempt, retry_instruction in enumerate(
        retry_instructions
    ):
        messages[0]["content"] = (
            FACT_EXTRACTION_PROMPT + retry_instruction
        )
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
        encoded = {
            key: value.to(DEVICE)
            for key, value in encoded.items()
        }
        input_length = int(encoded["input_ids"].shape[-1])

        with torch.inference_mode():
            output = MODEL.generate(
                **encoded,
                max_new_tokens=384,
                do_sample=False,
                use_cache=True,
                pad_token_id=TOKENIZER.eos_token_id,
            )

        generated = output[0][input_length:]
        generated_text = TOKENIZER.decode(
            generated,
            skip_special_tokens=True,
        )

        try:
            normalized = _normalize_extracted_side(
                extract_json_object(generated_text),
                event_prefix,
            )
            if (
                len(normalized["entities"]) == 0
                and len(normalized["events"]) == 0
            ):
                last_error = ValueError("empty_fact_extraction")
                continue
            return normalized
        except Exception as exc:
            last_error = exc

    print(
        json.dumps(
            {
                "event": "fact_extraction_insufficient",
                "side": event_prefix,
                "reason": (
                    str(last_error)[:80]
                    if last_error is not None
                    else "unknown"
                ),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return _empty_structure_side()

def _semantic_key(value: str | None) -> str:
    if value is None:
        return ""
    lowered = value.casefold()
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return " ".join(lowered.split())

def _text_similarity(left: str | None, right: str | None) -> float:
    left_key = _semantic_key(left)
    right_key = _semantic_key(right)
    if not left_key and not right_key:
        return 1.0
    if not left_key or not right_key:
        return 0.0
    if left_key == right_key:
        return 1.0
    if left_key in right_key or right_key in left_key:
        return min(len(left_key), len(right_key)) / max(
            len(left_key), len(right_key)
        )

    sequence = SequenceMatcher(
        None,
        left_key,
        right_key,
    ).ratio()
    left_tokens = set(left_key.split())
    right_tokens = set(right_key.split())
    union = left_tokens | right_tokens
    jaccard = (
        len(left_tokens & right_tokens) / len(union)
        if union
        else 0.0
    )
    return max(sequence, jaccard)

def _greedy_match(
    left: list[Any],
    right: list[Any],
    score_fn: Any,
    threshold: float,
) -> list[tuple[int, int, float]]:
    candidates: list[tuple[float, int, int]] = []
    for left_index, left_item in enumerate(left):
        for right_index, right_item in enumerate(right):
            score = float(score_fn(left_item, right_item))
            if score >= threshold:
                candidates.append(
                    (score, left_index, right_index)
                )

    candidates.sort(
        key=lambda entry: (
            -entry[0],
            entry[1],
            entry[2],
        )
    )
    used_left: set[int] = set()
    used_right: set[int] = set()
    matches: list[tuple[int, int, float]] = []

    for score, left_index, right_index in candidates:
        if (
            left_index in used_left
            or right_index in used_right
        ):
            continue
        used_left.add(left_index)
        used_right.add(right_index)
        matches.append(
            (left_index, right_index, score)
        )

    matches.sort(key=lambda entry: entry[0])
    return matches

def _entity_matches(
    source: dict[str, Any],
    translation: dict[str, Any],
) -> list[tuple[int, int, float]]:
    return _greedy_match(
        source["entities"],
        translation["entities"],
        lambda left, right: _text_similarity(
            left.get("canonicalName"),
            right.get("canonicalName"),
        ),
        0.76,
    )

def _event_similarity(
    left: dict[str, Any],
    right: dict[str, Any],
) -> float:
    weighted: list[tuple[float, float]] = []
    weighted.append(
        (
            0.5,
            _text_similarity(
                left.get("action"),
                right.get("action"),
            ),
        )
    )

    for weight, field in (
        (0.2, "actor"),
        (0.2, "object"),
        (0.1, "outcome"),
    ):
        left_value = left.get(field)
        right_value = right.get(field)
        if left_value is None and right_value is None:
            continue
        weighted.append(
            (
                weight,
                _text_similarity(left_value, right_value),
            )
        )

    total_weight = sum(weight for weight, _ in weighted)
    if total_weight <= 0:
        return 0.0
    return sum(
        weight * score
        for weight, score in weighted
    ) / total_weight

def _event_matches(
    source: dict[str, Any],
    translation: dict[str, Any],
) -> list[tuple[int, int, float]]:
    return _greedy_match(
        source["events"],
        translation["events"],
        _event_similarity,
        0.55,
    )

def _relationship_similarity(
    left: dict[str, Any],
    right: dict[str, Any],
) -> float:
    return (
        _text_similarity(left.get("subject"), right.get("subject"))
        + _text_similarity(left.get("relation"), right.get("relation"))
        + _text_similarity(left.get("object"), right.get("object"))
    ) / 3.0

def _dimension(
    name: str,
    status: str,
    confidence: float,
    summary: str,
) -> dict[str, Any]:
    return {
        "dimension": name,
        "status": status,
        "confidence": max(0.0, min(1.0, confidence)),
        "boundedSummary": summary[:300],
    }

def _coverage_status(
    *,
    dimension: str,
    source_count: int,
    translation_count: int,
    match_count: int,
    rerank_score: float | None,
) -> dict[str, Any]:
    if source_count == 0 and translation_count == 0:
        return _dimension(
            dimension,
            "INSUFFICIENT",
            0.9,
            "No bounded facts were expressed for this dimension.",
        )
    if source_count == 0 or translation_count == 0:
        return _dimension(
            dimension,
            "INSUFFICIENT",
            0.9,
            "Fact extraction on one bounded side was empty; mismatch is not asserted.",
        )

    source_coverage = match_count / source_count
    translation_coverage = match_count / translation_count
    min_coverage = min(source_coverage, translation_coverage)

    if min_coverage >= 0.6:
        return _dimension(
            dimension,
            "MATCH",
            min(0.95, 0.75 + 0.2 * min_coverage),
            f"Matched {match_count}/{source_count} source and {match_count}/{translation_count} translation facts.",
        )

    if (
        match_count == 0
        and (
            rerank_score is None
            or rerank_score < 0.55
        )
    ):
        return _dimension(
            dimension,
            "MISMATCH",
            0.95,
            "No bounded structured facts matched across the two sides.",
        )

    return _dimension(
        dimension,
        "INSUFFICIENT",
        0.85,
        f"Only {match_count} structured facts matched; evidence is not strong enough for a mismatch.",
    )

def compare_structure_sides(
    item: dict[str, Any],
    source: dict[str, Any],
    translation: dict[str, Any],
) -> list[dict[str, Any]]:
    kind = item.get("kind")
    rerank_score = item.get("rerankScore")
    if not isinstance(rerank_score, (int, float)):
        rerank_score = None
    else:
        rerank_score = float(rerank_score)

    if kind in {"SOURCE_GAP", "TRANSLATION_GAP"}:
        present = (
            source
            if kind == "SOURCE_GAP"
            else translation
        )
        dimensions = []
        for name, field in (
            ("EVENT", "events"),
            ("ENTITY", "entities"),
            ("RELATIONSHIP", "relationships"),
            ("CAUSALITY", "causalLinks"),
        ):
            if len(present[field]) > 0:
                dimensions.append(
                    _dimension(
                        name,
                        "MISMATCH",
                        0.95,
                        "Material bounded facts exist only on the present side of this alignment gap.",
                    )
                )
            else:
                dimensions.append(
                    _dimension(
                        name,
                        "INSUFFICIENT",
                        0.9,
                        "No bounded facts were extracted for this gap dimension.",
                    )
                )
        dimensions.append(
            _dimension(
                "CHRONOLOGY",
                "INSUFFICIENT",
                0.9,
                "Chronology cannot be compared when one aligned side is absent.",
            )
        )
        return dimensions

    entity_matches = _entity_matches(source, translation)
    event_matches = _event_matches(source, translation)
    relationship_matches = _greedy_match(
        source["relationships"],
        translation["relationships"],
        _relationship_similarity,
        0.6,
    )

    event_dimension = _coverage_status(
        dimension="EVENT",
        source_count=len(source["events"]),
        translation_count=len(translation["events"]),
        match_count=len(event_matches),
        rerank_score=rerank_score,
    )
    entity_dimension = _coverage_status(
        dimension="ENTITY",
        source_count=len(source["entities"]),
        translation_count=len(translation["entities"]),
        match_count=len(entity_matches),
        rerank_score=rerank_score,
    )
    relationship_dimension = _coverage_status(
        dimension="RELATIONSHIP",
        source_count=len(source["relationships"]),
        translation_count=len(translation["relationships"]),
        match_count=len(relationship_matches),
        rerank_score=rerank_score,
    )

    source_causal = {
        (
            link["causeEventId"],
            link["effectEventId"],
        )
        for link in source["causalLinks"]
    }
    translation_causal = {
        (
            link["causeEventId"],
            link["effectEventId"],
        )
        for link in translation["causalLinks"]
    }
    if not source_causal and not translation_causal:
        causality_dimension = _dimension(
            "CAUSALITY",
            "INSUFFICIENT",
            0.9,
            "No explicit bounded cause/effect links were extracted.",
        )
    elif not source_causal or not translation_causal:
        causality_dimension = _dimension(
            "CAUSALITY",
            "INSUFFICIENT",
            0.85,
            "Explicit cause/effect facts were extracted on only one side.",
        )
    else:
        # Event IDs are side-local, so compare causal-link count here.
        source_count = len(source_causal)
        translation_count = len(translation_causal)
        ratio = min(source_count, translation_count) / max(
            source_count,
            translation_count,
        )
        causality_dimension = _dimension(
            "CAUSALITY",
            "MATCH" if ratio >= 0.75 else "INSUFFICIENT",
            0.8,
            "Bounded causal-link structure has comparable cardinality."
            if ratio >= 0.75
            else "Bounded causal-link evidence is incomplete.",
        )

    if len(event_matches) < 2:
        chronology_dimension = _dimension(
            "CHRONOLOGY",
            "INSUFFICIENT",
            0.9,
            "Fewer than two matched bounded events are available for order comparison.",
        )
    else:
        ordered = sorted(
            event_matches,
            key=lambda match: (
                source["events"][match[0]]["order"],
                match[0],
            ),
        )
        translation_orders = [
            translation["events"][match[1]]["order"]
            for match in ordered
        ]
        monotonic = all(
            translation_orders[index]
            < translation_orders[index + 1]
            for index in range(len(translation_orders) - 1)
        )
        chronology_dimension = _dimension(
            "CHRONOLOGY",
            "MATCH" if monotonic else "MISMATCH",
            0.92,
            "Matched bounded events preserve order."
            if monotonic
            else "Matched bounded events reverse or cross order.",
        )

    return [
        event_dimension,
        entity_dimension,
        relationship_dimension,
        causality_dimension,
        chronology_dimension,
    ]

def verify_structure_item(item: dict[str, Any]) -> dict[str, Any]:
    evidence_id = item.get("evidenceId")
    if not isinstance(evidence_id, str) or not evidence_id:
        raise ValueError("invalid_structure_request_id")

    source_text = item.get("sourceText")
    translation_text = item.get("translationText")
    canonical_translation = translation_text

    if (
        isinstance(translation_text, str)
        and translation_text.strip()
        and _contains_thai(translation_text)
    ):
        canonical_translation = canonicalize_translation_text(
            translation_text
        )

    source = extract_structure_side(
        source_text if isinstance(source_text, str) else None,
        "s",
    )
    translation = extract_structure_side(
        canonical_translation
        if isinstance(canonical_translation, str)
        else None,
        "t",
    )

    dimensions = compare_structure_sides(
        item,
        source,
        translation,
    )

    return {
        "evidenceId": evidence_id,
        "source": source,
        "translation": translation,
        "dimensions": dimensions,
    }

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
                "structure_engine_version": STRUCTURE_ENGINE_VERSION,
                "runtime_source_sha256": RUNTIME_SOURCE_SHA256,
            },
        )

    def do_POST(self) -> None:
        if self.path not in {"/adjudicate", "/verify-structure"}:
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

        if self.path == "/verify-structure":
            items = payload.get("items")
            if (
                not isinstance(items, list)
                or not items
                or len(items) > 8
                or any(not isinstance(item, dict) for item in items)
            ):
                self._json(400, {"error": "invalid_structure_items"})
                return

            started = time.perf_counter()
            try:
                assessments = [
                    verify_structure_item(item)
                    for item in items
                ]
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                self._json(503, {"error": "cuda_out_of_memory"})
                return
            except ValueError as exc:
                reason = str(exc)[:100]
                print(
                    json.dumps(
                        {
                            "event": "structure_output_invalid",
                            "reason": reason,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                self._json(
                    422,
                    {
                        "error": "invalid_structure_output",
                        "reason": reason,
                    },
                )
                return
            except Exception as exc:
                print(
                    json.dumps(
                        {
                            "event": "structure_verification_error",
                            "type": type(exc).__name__,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                self._json(
                    500,
                    {"error": "structure_verification_failed"},
                )
                return

            self._json(
                200,
                {
                    "assessments": assessments,
                    "modelVersion": f"{MODEL_NAME}@{MODEL_REVISION}",
                    "elapsedMs": round(
                        (time.perf_counter() - started) * 1000,
                        1,
                    ),
                },
            )
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
                "structure_engine_version": STRUCTURE_ENGINE_VERSION,
                "runtime_source_sha256": RUNTIME_SOURCE_SHA256,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    server = HTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
