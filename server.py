#!/usr/bin/env python3
"""高考词汇互动课堂的轻量级房间同步与内容补全服务。"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = ROOT / "runtime" / "rooms"
AUDIO_DIR = ROOT / "runtime" / "audio"
ROOM_ID_PATTERN = re.compile(r"[^A-Za-z0-9_-]")
STATE_LOCK = threading.RLock()
ROOM_CACHE: dict[str, dict] = {}
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_STROKES_PER_WORD = 800


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sanitize_room_id(value: str | None) -> str:
    room = ROOM_ID_PATTERN.sub("", (value or "WORD-1800").strip()).upper()
    return room[:40] or "WORD-1800"


def string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def pair_list(value) -> list[list[str]]:
    if not isinstance(value, list):
        return []
    result: list[list[str]] = []
    for item in value:
        if isinstance(item, (list, tuple)) and item:
            name = str(item[0]).strip()
            meaning = str(item[1]).strip() if len(item) > 1 else ""
        else:
            name = str(item).strip()
            meaning = ""
        if name:
            result.append([name, meaning])
    return result


def phrase_examples(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if not isinstance(item, dict):
            continue
        phrase = str(item.get("phrase") or "").strip()
        if not phrase:
            continue
        result.append({
            "phrase": phrase,
            "meaning": str(item.get("meaning") or "").strip(),
            "example": str(item.get("example") or "").strip(),
            "translation": str(item.get("translation") or "").strip(),
            "source": str(item.get("source") or "").strip()
        })
    return result


def normalize_word(item: dict, index: int = 0) -> dict:
    if not isinstance(item, dict):
        item = {"word": str(item)}
    word = str(item.get("word", "")).strip()
    if not word:
        word = f"word-{index + 1}"
    word_id = str(item.get("id") or word).strip().lower()
    word_id = re.sub(r"[^a-z0-9_-]+", "-", word_id).strip("-") or f"word-{index + 1}"
    raw_phrases = item.get("phrases", [])
    phrases = []
    if isinstance(raw_phrases, list):
        for phrase in raw_phrases:
            value = phrase.get("phrase") if isinstance(phrase, dict) else phrase
            if str(value or "").strip():
                phrases.append(str(value).strip())
    return {
        "id": word_id,
        "day": int(item.get("day") or 1),
        "word": word,
        "phonetic": str(item.get("phonetic", "")).strip(),
        "part": str(item.get("part", "")).strip(),
        "meaning": str(item.get("meaning", "")).strip(),
        "standardMeaning": str(item.get("standardMeaning", "")).strip(),
        "segments": string_list(item.get("segments", [])),
        "mnemonic": str(item.get("mnemonic") or item.get("hook") or "").strip(),
        "logic": str(item.get("logic", "")).strip(),
        "derivatives": pair_list(item.get("derivatives", [])),
        "phrases": phrases,
        "phraseExamples": phrase_examples(item.get("phraseExamples", [])),
        "example": str(item.get("example", "")).strip(),
        "exampleTranslation": str(item.get("exampleTranslation", "")).strip(),
        "enrichment": item.get("enrichment") if isinstance(item.get("enrichment"), dict) else {}
    }


def load_seed_words() -> list[dict]:
    text = (ROOT / "data.js").read_text(encoding="utf-8")
    payload = text.split("=", 1)[1].rsplit(";", 1)[0].strip()
    return [normalize_word(item, index) for index, item in enumerate(json.loads(payload))]


def default_state(room_id: str) -> dict:
    words = load_seed_words()
    return {
        "roomId": room_id,
        "version": 0,
        "phase": 1,
        "activeDay": words[0]["day"] if words else 1,
        "activeWordId": words[0]["id"] if words else None,
        "words": words,
        "strokes": {},
        "students": {},
        "batchName": "种子词库",
        "batchDate": time.strftime("%Y-%m-%d"),
        "newWordIds": [word["id"] for word in words],
        "wordBanks": [{"id": "seed", "name": "种子词库", "date": time.strftime("%Y-%m-%d"), "words": words}],
        "activeBankId": "seed",
        "spellTask": None,
        "showSpellAnswers": False,
        "updatedAt": now_iso(),
        "sessionStartedAt": now_iso()
    }


def normalize_state(room_id: str, state: dict) -> dict:
    base = default_state(room_id)
    if not isinstance(state, dict):
        return base
    base.update(state)
    base["roomId"] = room_id
    base["version"] = int(base.get("version") or 0)
    base["phase"] = max(1, min(3, int(base.get("phase") or 1)))
    base["words"] = [normalize_word(item, index) for index, item in enumerate(base.get("words") or [])]
    if not base["words"]:
        base["words"] = load_seed_words()
    valid_ids = {word["id"] for word in base["words"]}
    if base.get("activeWordId") not in valid_ids:
        base["activeWordId"] = base["words"][0]["id"]
    base["strokes"] = base.get("strokes") if isinstance(base.get("strokes"), dict) else {}
    base["students"] = base.get("students") if isinstance(base.get("students"), dict) else {}
    base["newWordIds"] = base.get("newWordIds") if isinstance(base.get("newWordIds"), list) else [word["id"] for word in base["words"]]
    raw_banks = base.get("wordBanks") if isinstance(base.get("wordBanks"), list) else []
    banks = []
    for bank_index, bank in enumerate(raw_banks):
        if not isinstance(bank, dict):
            continue
        bank_words = [normalize_word(item, item_index) for item_index, item in enumerate(bank.get("words") or [])]
        if not bank_words:
            continue
        banks.append({
            "id": str(bank.get("id") or f"bank-{bank_index + 1}"),
            "name": str(bank.get("name") or "历史词库")[:80],
            "date": str(bank.get("date") or ""),
            "words": bank_words
        })
    if not banks:
        banks = [{"id": "seed", "name": str(base.get("batchName") or "种子词库"), "date": str(base.get("batchDate") or time.strftime("%Y-%m-%d")), "words": base["words"]}]
    base["wordBanks"] = banks[-50:]
    bank_ids = {bank["id"] for bank in base["wordBanks"]}
    if base.get("activeBankId") not in bank_ids:
        base["activeBankId"] = base["wordBanks"][-1]["id"]
    base["spellTask"] = base.get("spellTask") if isinstance(base.get("spellTask"), dict) else None
    base["showSpellAnswers"] = bool(base.get("showSpellAnswers"))
    return base


def room_path(room_id: str) -> Path:
    return RUNTIME_DIR / f"{room_id}.json"


def load_room(room_id: str) -> dict:
    with STATE_LOCK:
        if room_id in ROOM_CACHE:
            return ROOM_CACHE[room_id]
        path = room_path(room_id)
        if path.exists():
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                state = default_state(room_id)
        else:
            state = default_state(room_id)
        state = normalize_state(room_id, state)
        ROOM_CACHE[room_id] = state
        return state


def save_room(state: dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    room_path(state["roomId"]).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def touch_and_bump(state: dict) -> None:
    state["version"] = int(state.get("version", 0)) + 1
    state["updatedAt"] = now_iso()


def clean_point(point) -> dict | None:
    if not isinstance(point, dict):
        return None
    try:
        x = float(point.get("x"))
        y = float(point.get("y"))
    except (TypeError, ValueError):
        return None
    return {"x": max(0.0, min(1.0, x)), "y": max(0.0, min(1.0, y))}


def clean_stroke(stroke) -> dict | None:
    if not isinstance(stroke, dict):
        return None
    points = [clean_point(point) for point in stroke.get("points", [])]
    points = [point for point in points if point]
    if len(points) < 2:
        return None
    mode = "highlighter" if stroke.get("mode") == "highlighter" else "pen"
    return {
        "id": str(stroke.get("id") or f"stroke-{time.time_ns()}"),
        "mode": mode,
        "color": str(stroke.get("color") or "#b83b35")[:20],
        "width": max(1, min(40, float(stroke.get("width") or 3))),
        "points": points[:600]
    }


def apply_action(state: dict, role: str, client_id: str, action: str, payload: dict) -> tuple[bool, str]:
    if role not in ("teacher", "student", "observer"):
        return False, "无效角色"
    teacher_only = {
        "setPhase", "setDay", "setWord", "replaceWords", "loadWordBank", "addStroke", "clearStrokes",
        "eraseStrokes", "mergeEnrichment", "deleteWordBank", "publishSpellTask", "setSpellAnswerVisibility", "teacherFeedback", "gradeItem", "publishGrades", "resetRoom"
    }
    if role != "teacher" and action in teacher_only:
        return False, "该操作仅允许教师端执行"

    if action == "join":
        if role == "student":
            current = state["students"].get(client_id, {})
            state["students"][client_id] = {
                **current,
                "clientId": client_id,
                "name": str(payload.get("name") or current.get("name") or "学生")[:30],
                "online": True,
                "lastSeen": now_iso()
            }
        return True, ""

    if action == "setPhase":
        state["phase"] = max(1, min(3, int(payload.get("phase") or 1)))
        return True, ""

    if action == "setDay":
        state["activeDay"] = max(1, int(payload.get("day") or 1))
        return True, ""

    if action == "setWord":
        word_id = str(payload.get("wordId") or "")
        if word_id not in {word["id"] for word in state["words"]}:
            return False, "单词不存在"
        state["activeWordId"] = word_id
        if not state.get("spellTask"):
            for student in state["students"].values():
                student.update({"answer": "", "answers": [], "itemResults": {}, "submittedAt": None, "status": "idle", "correct": None, "feedback": ""})
        return True, ""

    if action == "replaceWords":
        raw_words = payload.get("words")
        if not isinstance(raw_words, list) or not raw_words:
            return False, "词库不能为空"
        words = [normalize_word(item, index) for index, item in enumerate(raw_words[:5000])]
        batch_name = str(payload.get("batchName") or "新词库")[:80]
        batch_date = time.strftime("%Y-%m-%d")
        state["words"] = words
        state["activeDay"] = words[0]["day"]
        state["activeWordId"] = words[0]["id"]
        state["batchName"] = batch_name
        state["batchDate"] = batch_date
        state["newWordIds"] = [word["id"] for word in words]
        state["spellTask"] = None
        state["showSpellAnswers"] = False
        if payload.get("recordBank", True):
            bank_id = f"bank-{time.time_ns()}"
            state.setdefault("wordBanks", []).append({
                "id": bank_id,
                "name": batch_name,
                "date": batch_date,
                "words": deepcopy(words)
            })
            state["wordBanks"] = state["wordBanks"][-50:]
            state["activeBankId"] = bank_id
        else:
            active_id = state.get("activeBankId")
            for bank in state.get("wordBanks", []):
                if isinstance(bank, dict) and bank.get("id") == active_id:
                    bank["words"] = deepcopy(words)
                    bank["name"] = batch_name
                    bank["date"] = batch_date
                    break
        for student in state["students"].values():
            student.update({"answer": "", "answers": [], "itemResults": {}, "submittedAt": None, "status": "idle", "correct": None, "feedback": ""})
        return True, ""

    if action == "loadWordBank":
        bank_id = str(payload.get("bankId") or "")
        bank = next((item for item in state.get("wordBanks", []) if isinstance(item, dict) and item.get("id") == bank_id), None)
        if not bank:
            return False, "历史词库不存在"
        words = [normalize_word(item, index) for index, item in enumerate(bank.get("words") or [])]
        if not words:
            return False, "历史词库为空"
        state["words"] = words
        state["activeDay"] = words[0]["day"]
        state["activeWordId"] = words[0]["id"]
        state["batchName"] = str(bank.get("name") or "历史词库")[:80]
        state["batchDate"] = str(bank.get("date") or "")
        state["newWordIds"] = [word["id"] for word in words]
        state["activeBankId"] = bank_id
        state["spellTask"] = None
        state["showSpellAnswers"] = False
        for student in state["students"].values():
            student.update({"answer": "", "answers": [], "itemResults": {}, "submittedAt": None, "status": "idle", "correct": None, "feedback": ""})
        return True, ""

    if action == "deleteWordBank":
        bank_id = str(payload.get("bankId") or "")
        banks = state.get("wordBanks") if isinstance(state.get("wordBanks"), list) else []
        target = next((bank for bank in banks if isinstance(bank, dict) and str(bank.get("id") or "") == bank_id), None)
        if not target:
            return False, "历史词库不存在"
        if str(target.get("id") or "") == "seed" or str(target.get("name") or "") == "种子词库":
            return False, "种子词库不能删除"
        if len(banks) <= 1:
            return False, "至少保留一个历史词库"
        remaining = [bank for bank in banks if bank is not target]
        if not remaining:
            return False, "至少保留一个历史词库"
        was_active = str(state.get("activeBankId") or "") == bank_id
        replacement = remaining[-1] if was_active else None
        replacement_words = [normalize_word(item, index) for index, item in enumerate(replacement.get("words") or [])] if replacement else []
        if was_active and not replacement_words:
            return False, "替代词库为空，无法删除当前词库"
        state["wordBanks"] = remaining
        if was_active:
            state["words"] = replacement_words
            state["activeDay"] = replacement_words[0]["day"]
            state["activeWordId"] = replacement_words[0]["id"]
            state["batchName"] = str(replacement.get("name") or "历史词库")[:80]
            state["batchDate"] = str(replacement.get("date") or "")
            state["newWordIds"] = [word["id"] for word in replacement_words]
            state["activeBankId"] = str(replacement.get("id") or "")
            state["spellTask"] = None
            state["showSpellAnswers"] = False
            for student in state.get("students", {}).values():
                student.update({"answer": "", "answers": [], "itemResults": {}, "submittedAt": None, "status": "idle", "correct": None, "feedback": ""})
        return True, ""

    if action == "mergeEnrichment":
        raw_words = payload.get("words")
        if not isinstance(raw_words, list) or not raw_words:
            return False, "补全结果不能为空"
        updates = {}
        for index, item in enumerate(raw_words[:5000]):
            if not isinstance(item, dict):
                continue
            normalized = normalize_word(item, index)
            updates[normalized["id"]] = normalized
        if not updates:
            return False, "补全结果无效"
        for index, current in enumerate(state.get("words", [])):
            enriched = updates.get(str(current.get("id") or ""))
            if not enriched:
                continue
            preserved = {"id": current.get("id"), "day": current.get("day"), "word": current.get("word")}
            state["words"][index] = {**current, **enriched, **preserved}
        for bank in state.get("wordBanks", []):
            if not isinstance(bank, dict) or not isinstance(bank.get("words"), list):
                continue
            for index, current in enumerate(bank["words"]):
                if not isinstance(current, dict):
                    continue
                enriched = updates.get(str(current.get("id") or ""))
                if not enriched:
                    continue
                preserved = {"id": current.get("id"), "day": current.get("day"), "word": current.get("word")}
                bank["words"][index] = {**current, **enriched, **preserved}
        return True, ""

    if action == "addStroke":
        key = str(payload.get("strokeKey") or state.get("activeWordId") or "")
        stroke = clean_stroke(payload.get("stroke"))
        if not key or not stroke:
            return False, "批注数据无效"
        strokes = state["strokes"].setdefault(key, [])
        strokes.append(stroke)
        if len(strokes) > MAX_STROKES_PER_WORD:
            del strokes[:len(strokes) - MAX_STROKES_PER_WORD]
        return True, ""

    if action == "clearStrokes":
        key = str(payload.get("strokeKey") or state.get("activeWordId") or "")
        if key:
            state["strokes"][key] = []
        return True, ""

    if action == "eraseStrokes":
        key = str(payload.get("strokeKey") or state.get("activeWordId") or "")
        ids = {str(item) for item in (payload.get("strokeIds") or [])}
        if key and ids:
            state["strokes"][key] = [stroke for stroke in state["strokes"].get(key, []) if str(stroke.get("id")) not in ids]
        return True, ""

    if action == "publishSpellTask":
        task = payload.get("task")
        if not isinstance(task, dict):
            return False, "默写任务无效"
        raw_items = task.get("items") if isinstance(task.get("items"), list) else []
        items = []
        for index, item in enumerate(raw_items[:200]):
            if not isinstance(item, dict):
                continue
            items.append({
                "id": str(item.get("id") or f"item-{index + 1}"),
                "wordId": str(item.get("wordId") or ""),
                "type": str(item.get("type") or "meaning-to-word")[:40],
                "prompt": str(item.get("prompt") or "")[:1000],
                "subPrompt": str(item.get("subPrompt") or "")[:500],
                "answer": str(item.get("answer") or "")[:500],
                "audioText": str(item.get("audioText") or "")[:200],
                "hint": str(item.get("hint") or "")[:300],
                "maskedWord": str(item.get("maskedWord") or "")[:200],
                "roman": str(item.get("roman") or "")[:20],
                "leftWord": str(item.get("leftWord") or "")[:200],
                "rightLetter": str(item.get("rightLetter") or "")[:20],
                "rightMeaning": str(item.get("rightMeaning") or "")[:500]
            })
        if not items:
            return False, "默写任务没有题目"
        state["spellTask"] = {
            "id": str(task.get("id") or f"task-{time.time_ns()}"),
            "type": str(task.get("type") or "meaning-to-word")[:40],
            "title": str(task.get("title") or "默写任务")[:100],
            "wordIds": [str(item) for item in (task.get("wordIds") or [])[:200]],
            "items": items,
            "matching": {
                "left": [
                    {
                        "roman": str(entry.get("roman") or "")[:20],
                        "wordId": str(entry.get("wordId") or "")[:80],
                        "word": str(entry.get("word") or "")[:200]
                    }
                    for entry in (task.get("matching", {}).get("left", []) if isinstance(task.get("matching"), dict) else [])[:200]
                    if isinstance(entry, dict)
                ],
                "right": [
                    {
                        "letter": str(entry.get("letter") or "")[:20],
                        "wordId": str(entry.get("wordId") or "")[:80],
                        "meaning": str(entry.get("meaning") or "")[:500]
                    }
                    for entry in (task.get("matching", {}).get("right", []) if isinstance(task.get("matching"), dict) else [])[:200]
                    if isinstance(entry, dict)
                ]
            },
            "createdAt": now_iso()
        }
        state["showSpellAnswers"] = False
        for student in state["students"].values():
            student.update({"answer": "", "answers": [], "itemResults": {}, "submittedAt": None, "status": "idle", "correct": None, "feedback": ""})
        return True, ""

    if action == "setSpellAnswerVisibility":
        state["showSpellAnswers"] = bool(payload.get("visible"))
        return True, ""

    if action == "submitAnswer":
        student = state["students"].setdefault(client_id, {"clientId": client_id, "name": "学生", "online": True})
        answers = payload.get("answers") if isinstance(payload.get("answers"), list) else []
        student.update({
            "answer": str(payload.get("answer") or "")[:200],
            "answers": [str(item)[:300] for item in answers[:200]],
            "itemResults": {},
            "submittedAt": now_iso(),
            "status": "pending",
            "correct": None,
            "feedback": ""
        })
        return True, ""

    if action == "teacherFeedback":
        student = state["students"].get(str(payload.get("studentId") or ""))
        if not student:
            return False, "学生不存在"
        student["correct"] = bool(payload.get("correct"))
        student["status"] = "checked"
        student["feedback"] = str(payload.get("feedback") or "")[:200]
        student["checkedAt"] = now_iso()
        return True, ""

    if action == "gradeItem":
        student = state["students"].get(str(payload.get("studentId") or ""))
        if not student:
            return False, "学生不存在"
        item_id = str(payload.get("itemId") or "")
        if not item_id:
            return False, "题目不存在"
        results = student.get("itemResults") if isinstance(student.get("itemResults"), dict) else {}
        results[item_id] = bool(payload.get("correct"))
        student["itemResults"] = results
        student["status"] = "reviewing"
        return True, ""

    if action == "publishGrades":
        student = state["students"].get(str(payload.get("studentId") or ""))
        task = state.get("spellTask")
        if not student:
            return False, "学生不存在"
        if not isinstance(task, dict):
            return False, "默写任务不存在"
        results = student.get("itemResults") if isinstance(student.get("itemResults"), dict) else {}
        item_ids = [str(item.get("id") or "") for item in task.get("items", []) if isinstance(item, dict)]
        checked = [bool(results.get(item_id)) for item_id in item_ids if item_id in results]
        student["correct"] = bool(checked) and all(checked)
        student["status"] = "checked"
        student["feedback"] = str(payload.get("feedback") or "")[:200]
        student["checkedAt"] = now_iso()
        return True, ""

    if action == "resetRoom":
        fresh = default_state(state["roomId"])
        state.clear()
        state.update(fresh)
        return True, ""

    return False, "未知操作"


def fetch_json_url(url: str, timeout: float = 8.0):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "PixelWordFarm/1.0 (educational vocabulary enrichment)"}
    )
    last_error = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(0.4)
    raise last_error


def fetch_bytes_url(url: str, timeout: float = 10.0) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "PixelWordFarm/1.0 (educational audio proxy)"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def get_word_audio(word: str) -> tuple[bytes, str]:
    safe_word = re.sub(r"[^a-z0-9-]", "", word.lower())[:80]
    if not safe_word:
        raise ValueError("单词无效")
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    cached = AUDIO_DIR / f"{safe_word}.mp3"
    if cached.exists() and cached.stat().st_size > 0:
        return cached.read_bytes(), "audio/mpeg"
    source = "https://dict.youdao.com/dictvoice?audio=" + urllib.parse.quote(word) + "&type=2"
    payload = fetch_bytes_url(source)
    if not payload:
        raise ValueError("发音文件为空")
    cached.write_bytes(payload)
    return payload, "audio/mpeg"

def load_enrichment_cache() -> dict:
    path = RUNTIME_DIR / "enrichment_cache.json"
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_enrichment_cache(cache: dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    (RUNTIME_DIR / "enrichment_cache.json").write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_dictionary_data(word: str) -> dict:
    url = "https://api.dictionaryapi.dev/api/v2/entries/en/" + urllib.parse.quote(word)
    data = fetch_json_url(url)
    return data[0] if isinstance(data, list) and data else {}


def datamuse_words(params: dict) -> list[dict]:
    data = fetch_json_url("https://api.datamuse.com/words?" + urllib.parse.urlencode(params))
    return data if isinstance(data, list) else []


def fetch_tatoeba_example(word: str) -> str:
    query = urllib.parse.urlencode({"from": "eng", "query": word, "to": "eng"})
    data = fetch_json_url("https://tatoeba.org/en/api_v0/search?" + query)
    for sentence in (data.get("results") if isinstance(data, dict) else [])[:20]:
        text = str(sentence.get("text") or "").strip()
        if word.lower() in text.lower() and 12 <= len(text) <= 160:
            return text
    return ""


def simple_word_forms(word: str, part: str) -> list[list[str]]:
    base = word.lower()
    forms = []
    if base.endswith("y") and len(base) > 1 and base[-2] not in "aeiou":
        forms.append(base[:-1] + "ies")
    elif base.endswith(("s", "x", "z", "ch", "sh")):
        forms.append(base + "es")
    else:
        forms.append(base + "s")
    if "v" in part.lower():
        root = base[:-1] if base.endswith("e") else base
        forms.extend([root + "ing", root + "ed"])
    if "adj" in part.lower():
        forms.extend([base + "ly", base + "ness"])
    return [[form, "规则词形"] for form in dict.fromkeys(forms) if form != base]


def fetch_youdao_data(word: str) -> dict:
    url = "https://dict.youdao.com/jsonapi?q=" + urllib.parse.quote(word)
    data = fetch_json_url(url, timeout=10.0)
    return data if isinstance(data, dict) else {}


def safe_dict(data, *keys):
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def parse_youdao_entry(data: dict) -> dict:
    simple = data.get("simple") if isinstance(data.get("simple"), dict) else {}
    phonetic = str(simple.get("usphone") or simple.get("ukphone") or "").strip()
    if phonetic and not phonetic.startswith("/"):
        phonetic = f"/{phonetic}/"

    meaning = ""
    ec = data.get("ec") if isinstance(data.get("ec"), dict) else {}
    ec_words = ec.get("word") if isinstance(ec.get("word"), list) else []
    if ec_words:
        trs = ec_words[0].get("trs") if isinstance(ec_words[0].get("trs"), list) else []
        if trs:
            tr = trs[0].get("tr") if isinstance(trs[0].get("tr"), dict) else {}
            value = safe_dict(tr, "l").get("i")
            if isinstance(value, list):
                value = "；".join(str(item) for item in value)
            meaning = str(value or "").strip()

    derivatives = []
    rel_word = data.get("rel_word") if isinstance(data.get("rel_word"), dict) else {}
    stem = str(rel_word.get("stem") or "").strip().lower()
    seen_forms = set()
    for rel_item in rel_word.get("rels", []) if isinstance(rel_word.get("rels"), list) else []:
        rel = rel_item.get("rel") if isinstance(rel_item, dict) and isinstance(rel_item.get("rel"), dict) else {}
        for word_item in rel.get("words", []) if isinstance(rel.get("words"), list) else []:
            candidate = str(word_item.get("word") or "").strip()
            translation = str(word_item.get("tran") or "").strip()
            normalized = candidate.lower()
            if candidate and translation and normalized not in seen_forms and stem and normalized.startswith(stem):
                derivatives.append([candidate, translation])
                seen_forms.add(normalized)

    phrases = []
    phrs = data.get("phrs") if isinstance(data.get("phrs"), dict) else {}
    for item in phrs.get("phrs", []) if isinstance(phrs.get("phrs"), list) else []:
        phr = item.get("phr") if isinstance(item, dict) and isinstance(item.get("phr"), dict) else {}
        phrase = str(safe_dict(phr, "headword", "l").get("i") or "").strip()
        translation = ""
        trs = phr.get("trs") if isinstance(phr.get("trs"), list) else []
        if trs:
            tr = trs[0].get("tr") if isinstance(trs[0].get("tr"), dict) else {}
            value = safe_dict(tr, "l").get("i")
            if isinstance(value, list):
                value = "；".join(str(entry) for entry in value)
            translation = str(value or "").strip()
        if phrase and translation:
            phrases.append({"phrase": phrase, "meaning": translation})

    examples = []
    sentence_part = data.get("blng_sents_part") if isinstance(data.get("blng_sents_part"), dict) else {}
    for pair in sentence_part.get("sentence-pair", []) if isinstance(sentence_part.get("sentence-pair"), list) else []:
        sentence = str(pair.get("sentence") or "").replace("<b>", "").replace("</b>", "").strip()
        if sentence:
            examples.append({
                "example": sentence,
                "translation": str(pair.get("sentence-translation") or "").strip(),
                "source": str(pair.get("source") or "")
            })
    return {"phonetic": phonetic, "meaning": meaning, "derivatives": derivatives[:8], "phrases": phrases[:8], "examples": examples}


def phrase_example_from_entry(entry: dict, phrase: str) -> dict:
    target = phrase.lower()
    for example in entry.get("examples", []):
        if target in str(example.get("example") or "").lower():
            return example
    return {}


def fetch_phrase_example(phrase: str) -> dict:
    try:
        entry = parse_youdao_entry(fetch_youdao_data(phrase))
        direct = phrase_example_from_entry(entry, phrase)
        if direct:
            return direct
        first_word = phrase.split()[0].lower()
        for example in entry.get("examples", []):
            if first_word in str(example.get("example") or "").lower():
                return example
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        pass
    return {}


def translate_to_chinese(text: str) -> str:
    if not str(text or "").strip():
        return ""
    try:
        query = urllib.parse.urlencode({"q": text, "langpair": "en|zh-CN"})
        data = fetch_json_url("https://api.mymemory.translated.net/get?" + query, timeout=8.0)
        value = str(safe_dict(data, "responseData").get("translatedText") or "").strip()
        return value if value and "MYMEMORY WARNING" not in value.upper() else ""
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return ""


ARPABET_TO_IPA = {
    "AA": "ɑ", "AE": "æ", "AH0": "ə", "AH1": "ʌ", "AH2": "ʌ", "AH": "ʌ",
    "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "B": "b", "CH": "tʃ", "D": "d",
    "DH": "ð", "EH": "e", "ER0": "ər", "ER1": "ɜːr", "ER2": "ər", "ER": "ər",
    "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "iː",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "OW": "oʊ",
    "OY": "ɔɪ", "P": "p", "R": "r", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ",
    "UH": "ʊ", "UW": "uː", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ"
}


def arpabet_to_ipa(pronunciation: str) -> str:
    tokens = [token.strip().upper() for token in str(pronunciation or "").split() if token.strip()]
    vowels = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
    output = []
    trailing_consonants = 0
    for token in tokens:
        match = re.match(r"^([A-Z]+)([0-2])?$", token)
        if not match:
            continue
        phone, stress = match.groups()
        if phone in vowels:
            if stress in {"1", "2"}:
                marker = "ˈ" if stress == "1" else "ˌ"
                output.insert(max(0, len(output) - trailing_consonants), marker)
            if phone == "IY":
                output.append("iː" if stress == "1" else "i")
            elif phone == "UW":
                output.append("uː" if stress == "1" else "u")
            else:
                output.append(ARPABET_TO_IPA.get(phone + (stress or ""), ARPABET_TO_IPA.get(phone, "")))
            trailing_consonants = 0
        else:
            output.append(ARPABET_TO_IPA.get(phone, ""))
            trailing_consonants += 1
    value = "".join(output).strip()
    return f"/{value}/" if value else ""


def enrich_word_online(item: dict) -> dict:
    word = str(item.get("word") or "").strip()
    result = normalize_word(item)
    if not word:
        return result

    providers = []
    needs_review = False
    phonetic_fallback_used = False
    youdao_entry = {}

    try:
        youdao_entry = parse_youdao_entry(fetch_youdao_data(word))
        providers.append("有道词典")
        if youdao_entry.get("phonetic") and not result.get("phonetic"):
            result["phonetic"] = youdao_entry["phonetic"]
        standard_meaning = str(youdao_entry.get("meaning") or "").strip()
        if standard_meaning:
            result["standardMeaning"] = standard_meaning
            if not result.get("meaning"):
                result["meaning"] = standard_meaning
            if not result.get("logic"):
                result["logic"] = f"标准释义：{standard_meaning}（来源：有道词典）"
        if youdao_entry.get("derivatives") and not result.get("derivatives"):
            result["derivatives"] = youdao_entry["derivatives"]
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        pass

    if not result.get("phonetic"):
        try:
            exact = datamuse_words({"sp": word, "md": "pr", "max": 1})
            tags = exact[0].get("tags") if exact and isinstance(exact[0].get("tags"), list) else []
            pron = next((str(tag).split("pron:", 1)[1].strip() for tag in tags if str(tag).startswith("pron:")), "")
            if pron:
                result["phonetic"] = arpabet_to_ipa(pron)
                phonetic_fallback_used = True
                providers.append("Datamuse 发音回退")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError, IndexError):
            pass

    existing_examples = {str(entry.get("phrase") or "").lower(): entry for entry in result.get("phraseExamples", []) if isinstance(entry, dict)}
    phrase_source = []
    if result.get("phrases"):
        youdao_lookup = {str(entry.get("phrase") or "").lower(): entry for entry in youdao_entry.get("phrases", []) if isinstance(entry, dict)}
        for phrase in result["phrases"]:
            matched = youdao_lookup.get(str(phrase).lower(), {})
            phrase_source.append({"phrase": str(phrase), "meaning": str(matched.get("meaning") or existing_examples.get(str(phrase).lower(), {}).get("meaning") or "")})
    else:
        phrase_source = [{"phrase": str(entry.get("phrase") or ""), "meaning": str(entry.get("meaning") or "")} for entry in youdao_entry.get("phrases", [])[:4] if str(entry.get("phrase") or "").strip()]

    phrase_items = []
    for phrase_item in phrase_source:
        phrase = phrase_item["phrase"]
        previous = existing_examples.get(phrase.lower(), {})
        example = {} if previous.get("example") else (phrase_example_from_entry(youdao_entry, phrase) or fetch_phrase_example(phrase))
        record = {
            "phrase": phrase,
            "meaning": phrase_item.get("meaning", ""),
            "example": str(previous.get("example") or example.get("example") or ""),
            "translation": str(previous.get("translation") or example.get("translation") or ""),
            "source": str(previous.get("source") or example.get("source") or "")
        }
        phrase_items.append(record)
        if not result.get("example") and record["example"]:
            result["example"] = record["example"]
            result["exampleTranslation"] = record["translation"]
    if phrase_items:
        result["phrases"] = [entry["phrase"] for entry in phrase_items]
        result["phraseExamples"] = phrase_items

    if not result.get("example"):
        try:
            providers.append("Tatoeba")
            example = fetch_tatoeba_example(word)
            if example:
                result["example"] = example
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
            pass

    if not result.get("derivatives"):
        try:
            providers.append("Datamuse")
            stem = word.lower().rstrip("e")
            forms = []
            for candidate in datamuse_words({"sp": word + "*", "md": "dps", "max": 30}):
                value = str(candidate.get("word") or "").strip()
                if value and value != word and value.replace("-", "").isalpha() and (value.lower().startswith(word.lower()) or value.lower().startswith(stem)):
                    forms.append([value, translate_to_chinese(value) or "相关词形，待教师复核"])
                if len(forms) >= 4:
                    break
            existing = {entry[0] for entry in forms}
            forms.extend(entry for entry in simple_word_forms(word, str(result.get("part") or item.get("part") or "")) if entry[0] not in existing)
            if forms:
                result["derivatives"] = forms[:6]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
            pass

    for derivative in result.get("derivatives", []):
        if len(derivative) < 2 or not derivative[1] or derivative[1] == "相关词形":
            derivative[1] = translate_to_chinese(derivative[0]) or "相关词形，待教师复核"

    if phonetic_fallback_used or not result.get("phonetic") or not result.get("meaning"):
        needs_review = True
    if not result.get("derivatives") or not result.get("phraseExamples"):
        needs_review = True
    if any(not phrase.get("example") for phrase in result.get("phraseExamples", [])):
        needs_review = True

    result["enrichment"] = {
        "providers": list(dict.fromkeys(providers)),
        "needsReview": needs_review,
        "verifiedExampleCount": sum(1 for phrase in result.get("phraseExamples", []) if phrase.get("example")),
        "phraseCount": len(result.get("phraseExamples", []))
    }
    result["enriched"] = True
    return result


def enrich_words_batch(words: list[dict]) -> list[dict]:
    if not words:
        return []
    cache = load_enrichment_cache()
    results: list[dict | None] = [None] * len(words)
    pending = []
    for index, item in enumerate(words):
        normalized = normalize_word(item, index)
        key = "v9:" + normalized["word"].lower()
        cached = cache.get(key)
        if isinstance(cached, dict):
            results[index] = {**normalized, **cached, "word": normalized["word"], "id": normalized["id"]}
        else:
            pending.append((index, normalized))
    if pending:
        with ThreadPoolExecutor(max_workers=min(4, len(pending))) as executor:
            futures = {executor.submit(enrich_word_online, item): (index, item) for index, item in pending}
            for future in as_completed(futures):
                index, original = futures[future]
                try:
                    enriched = future.result()
                except Exception:
                    enriched = {**original, "enriched": False}
                results[index] = enriched
                cache["v9:" + original["word"].lower()] = enriched
        save_enrichment_cache(cache)
    return [entry or normalize_word(words[index], index) for index, entry in enumerate(results)]


class ClassroomHandler(SimpleHTTPRequestHandler):
    server_version = "WordMemoryClassroom/1.4"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("请求体为空或过大")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "time": now_iso()})
            return
        if parsed.path == "/api/audio":
            query = parse_qs(parsed.query)
            word = str((query.get("word") or [""])[0]).strip()[:100]
            if not word:
                self.send_json({"ok": False, "error": "缺少 word 参数"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                payload, content_type = get_word_audio(word)
                self.send_bytes(payload, content_type)
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                self.send_json({"ok": False, "error": f"发音获取失败：{exc}"}, HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/api/state":
            query = parse_qs(parsed.query)
            room_id = sanitize_room_id((query.get("room") or [None])[0])
            raw_since = (query.get("since") or [None])[0]
            try:
                since_version = int(raw_since) if raw_since is not None else None
            except (TypeError, ValueError):
                since_version = None
            with STATE_LOCK:
                state = load_room(room_id)
                if since_version is not None and since_version == state["version"]:
                    self.send_json({"ok": True, "changed": False, "version": state["version"]})
                else:
                    self.send_json({
                        "ok": True,
                        "changed": True,
                        "version": state["version"],
                        "state": deepcopy(state)
                    })
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/action", "/api/upload", "/api/enrich-batch"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            body = self.read_json_body()
            room_id = sanitize_room_id(body.get("room"))
            role = str(body.get("role") or "observer")
            client_id = str(body.get("clientId") or "anonymous")[:80]

            if parsed.path == "/api/enrich-batch":
                if role != "teacher":
                    self.send_json({"ok": False, "error": "只有教师端可以执行联网补全"}, HTTPStatus.FORBIDDEN)
                    return
                words = body.get("words") if isinstance(body.get("words"), list) else []
                if not words:
                    self.send_json({"ok": False, "error": "没有可补全的单词"}, HTTPStatus.BAD_REQUEST)
                    return
                self.send_json({"ok": True, "words": enrich_words_batch(words[:500])})
                return

            if parsed.path == "/api/upload":
                body["action"] = "replaceWords"
            action = str(body.get("action") or "")
            payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
            if parsed.path == "/api/upload":
                payload = {"words": body.get("words"), "batchName": body.get("batchName")}
            with STATE_LOCK:
                state = load_room(room_id)
                ok, message = apply_action(state, role, client_id, action, payload)
                if not ok:
                    self.send_json({"ok": False, "error": message}, HTTPStatus.FORBIDDEN if role != "teacher" else HTTPStatus.BAD_REQUEST)
                    return
                touch_and_bump(state)
                save_room(state)
                self.send_json({"ok": True, "state": deepcopy(state)})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            print(f"服务器错误: {exc!r}")
            self.send_json({"ok": False, "error": "服务器内部错误"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    parser = argparse.ArgumentParser(description="启动词汇互动课堂服务器")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="监听地址，默认允许局域网访问")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")), help="监听端口")
    args = parser.parse_args()
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), ClassroomHandler)
    print(f"词汇互动课堂已启动: http://127.0.0.1:{args.port}")
    print(f"局域网学生访问: http://<教师电脑IP>:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()












