"""Bounded live understanding smoke test with synthetic preferences only."""
import asyncio
import json
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from kiwi.config import ROOT, Settings
from kiwi.providers import LiveAI, REFINEMENT_PROMPT_VERSION
from kiwi.refinement import merge_refinement
from kiwi.schemas import Preferences


async def main():
    settings = Settings(ai_mode="live")
    if not settings.configured:
        raise RuntimeError("Live provider is not configured")
    base = Preferences(soft_preferences={"genres": ["修仙"]}, excluded_features=["harem"])
    report = {"date": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(), "mode": "live", "model": settings.deepseek_model, "prompt_version": REFINEMENT_PROMPT_VERSION,
              "synthetic_preferences": True, "embedding_calls": 0, "cases": []}
    for text, expected in [("加点重生", "ready"), ("一定要节奏快", "ready"), ("偏好题材改成都市，其他不变", "ready"),
                           ("取消不要后宫", "ready"), ("加点修仙", "no_change"), ("加点重生，必须完结", "needs_confirmation")]:
        provider = LiveAI(settings)
        start = time.perf_counter()
        try:
            plan = await asyncio.wait_for(provider.refine(base, text), settings.request_timeout)
            outcome = merge_refinement(base, text, plan)
            row = {"text": text, "expected": expected, "status": outcome["status"], "passed": outcome["status"] == expected}
        except Exception as exc:
            row = {"text": text, "expected": expected, "status": "error", "passed": False, "error_type": type(exc).__name__, "error_code": getattr(exc, "code", None)}
        row.update(calls=provider.calls, tokens=provider.tokens, elapsed_ms=round((time.perf_counter() - start) * 1000, 2))
        report["cases"].append(row)
    report["passed"] = all(row["passed"] for row in report["cases"])
    report["usage"] = {"calls": sum(row["calls"] for row in report["cases"]), "tokens": sum(row["tokens"] for row in report["cases"])}
    (ROOT / "docs/refinement-live-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


asyncio.run(main())
