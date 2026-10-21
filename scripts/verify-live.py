import asyncio
import json
from pathlib import Path

from kiwi.config import ROOT, Settings
from kiwi.database import make_database
from kiwi.providers import LiveAI
from kiwi.schemas import RecommendationRequest
from kiwi.service import recommend


async def main():
    settings = Settings()
    provider = LiveAI(settings)
    prefs = await asyncio.wait_for(provider.parse("只看末世，想要系统。"), settings.request_timeout)
    _, sessions = make_database(settings.database_url)
    result = await asyncio.wait_for(recommend(RecommendationRequest(preferences=prefs), sessions, provider, settings, "live-smoke"), settings.request_timeout)
    (ROOT / ".local/live-smoke.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": result["status"], "titles": [w["title"] for w in result["items"]],
        "reason_modes": [w["reason_mode"] for w in result["items"]], "timings_ms": result["timings_ms"], "warnings": result["warnings"]}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
