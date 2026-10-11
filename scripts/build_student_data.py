import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import enrich_words_batch  # noqa: E402

INPUT = ROOT / "teacher-words.txt"
OUTPUT = ROOT / "student-data.json"
LINE_RE = re.compile(r"^\s*(?:\d+[.、)]\s*)?(?P<word>[A-Za-z][A-Za-z'’-]*)\s*(?:\((?P<part>[^)]*)\))?\s*(?P<meaning>.*?)\s*$")


def parse_words(text: str) -> list[dict]:
    words = []
    current_day = 1
    seen = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        day_match = re.match(r"^DAY\s*(\d+)$", line, re.IGNORECASE)
        if day_match:
            current_day = max(1, int(day_match.group(1)))
            continue
        match = LINE_RE.match(line)
        if not match:
            continue
        word = match.group("word").strip()
        key = word.lower()
        if not word or key in seen:
            continue
        seen.add(key)
        words.append({
            "id": key,
            "day": current_day,
            "word": word,
            "part": (match.group("part") or "").strip(),
            "meaning": (match.group("meaning") or "").strip()
        })
    return words


def main() -> None:
    if not INPUT.exists():
        raise SystemExit("找不到 teacher-words.txt，请先在仓库根目录创建该文件并粘贴词表。")
    words = parse_words(INPUT.read_text(encoding="utf-8"))
    if not words:
        raise SystemExit("teacher-words.txt 中没有识别到单词。请使用“单词 + 词性 + 中文释义”的格式。")
    enriched = enrich_words_batch(words)
    grouped = {}
    for word in enriched:
        grouped.setdefault(int(word.get("day") or 1), []).append(word)
    today = datetime.now().astimezone().date()
    date_label = today.strftime("%m-%d")
    banks = []
    for day, day_words in sorted(grouped.items()):
        banks.append({
            "id": f"day-{day}",
            "label": f"Day{day} · {date_label} · {len(day_words)} 词",
            "date": today.isoformat(),
            "words": day_words
        })
    payload = {
        "version": 1,
        "title": "像素词汇农场",
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "activeBankId": banks[0]["id"],
        "banks": banks
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成 {OUTPUT.name}：{len(words)} 个单词，{len(banks)} 个 Day")


if __name__ == "__main__":
    main()