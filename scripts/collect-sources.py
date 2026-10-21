"""Small, bounded official-source collection. Output is a review draft, never auto-approved."""
import json
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / "data/source-cache"
target.mkdir(parents=True, exist_ok=True)
client = httpx.Client(timeout=20, headers={"User-Agent": "Mozilla/5.0"})
queue, seen, rows = [45128], set(), []
while queue and len(rows) < 36:
    sid = queue.pop(0)
    if sid in seen:
        continue
    seen.add(sid)
    time.sleep(0.35)
    try:
        body = client.get("https://api.bilibili.com/pgc/view/web/season", params={"season_id": sid}).json()
        data = body.get("result", {})
        title, intro = data.get("title", ""), data.get("evaluate", "").strip()
        if ("动态漫" in title or "动态漫画" in title) and len(intro) > 10:
            rows.append({"id": f"bili-{sid}", "title": title, "original_intro": intro,
                         "source_url": f"https://www.bilibili.com/bangumi/play/ss{sid}",
                         "collected_at": "2026-10-21"})
            print(f"{len(rows):02} {sid} {title}", flush=True)
        related = client.get("https://api.bilibili.com/pgc/season/web/related/recommend", params={"season_id": sid}).json()
        for row in related.get("data", {}).get("season", []):
            if "动态漫" in row.get("title", "") and row["season_id"] not in seen:
                queue.append(row["season_id"])
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        print(f"Failed {sid}: {type(exc).__name__}", flush=True)
    (target / "official.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Collected {len(rows)} official descriptions; review before importing.")

