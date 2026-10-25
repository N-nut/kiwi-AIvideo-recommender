import argparse
import asyncio
import json

from .config import ROOT, Settings
from .database import initialize, make_database
from .importer import import_works
from .providers import BaselineAI, LiveAI


def main():
    parser = argparse.ArgumentParser(description="Kiwi database and data import")
    parser.add_argument("command", choices=["init", "import", "import-previews"])
    parser.add_argument("--manifest")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--file", default=str(ROOT / "data/works.json"))
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--reembed", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    if args.command == "import-previews" and args.check_only and settings.database_url.startswith("sqlite:"):
        from pathlib import Path
        url = settings.database_url
        if not url.startswith("sqlite:///") or ":memory:" in url or not Path(url.removeprefix("sqlite:///")).is_file():
            print(json.dumps({"failed": 1, "stage": "database", "error": "database_not_initialized"}))
            raise SystemExit(1)
    engine, sessions = make_database(settings.database_url)
    if args.command == "import-previews":
        from .preview_importer import MediaError, import_previews
        if not args.manifest:
            parser.error("import-previews requires --manifest")
        try:
            result = import_previews(args.manifest, sessions, settings, args.check_only)
            print(json.dumps(result, ensure_ascii=False))
            raise SystemExit(1 if result["failed"] else 0)
        except MediaError as exc:
            print(json.dumps({"failed": 1, "stage": exc.stage, "error": exc.code}))
            raise SystemExit(1) from None
        finally:
            engine.dispose()
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
