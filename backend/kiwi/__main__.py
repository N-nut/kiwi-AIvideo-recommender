import argparse
import asyncio
import json

from .config import ROOT, Settings
from .database import initialize, make_database
from .importer import import_works
from .providers import BaselineAI, LiveAI


def main():
    parser = argparse.ArgumentParser(description="Kiwi database and data import")
    parser.add_argument("command", choices=["init", "import"])
    parser.add_argument("--file", default=str(ROOT / "data/works.json"))
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--reembed", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    engine, sessions = make_database(settings.database_url)
    initialize(engine)
    if args.command == "import":
        from pathlib import Path
        data = json.loads(Path(args.file).read_text(encoding="utf-8"))
        provider = LiveAI(settings) if settings.ai_mode == "live" else BaselineAI()
        try:
            print(json.dumps(asyncio.run(import_works(data, sessions, provider, settings, args.update, args.reembed)), ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"imported": 0, "failed": len(data), "error": str(exc)}, ensure_ascii=False))
            raise SystemExit(1) from None
    else:
        print("Database initialized")


if __name__ == "__main__":
    main()
