"""Start the built application; environment setup is documented in README."""
import argparse
import asyncio
import json
import os
from pathlib import Path

from kiwi.config import ROOT, Settings
from kiwi.database import initialize, make_database
from kiwi.importer import import_works
from kiwi.providers import BaselineAI, LiveAI

parser=argparse.ArgumentParser()
parser.add_argument('--port',type=int,default=8000)
parser.add_argument('--baseline',action='store_true')
parser.add_argument('--skip-import',action='store_true')
args=parser.parse_args()
if args.baseline:os.environ['AI_MODE']='baseline'
settings=Settings()
if not (ROOT/'frontend/dist/index.html').is_file():
    raise SystemExit('请先运行 npm --prefix frontend ci 和 npm --prefix frontend run build')
engine,sessions=make_database(settings.database_url)
if engine.dialect.name=='sqlite':initialize(engine)
if not args.skip_import:
    raw=json.loads((ROOT/'data/works.json').read_text(encoding='utf-8'))
    if raw:
        print(asyncio.run(import_works(raw,sessions,LiveAI(settings) if settings.ai_mode=='live' else BaselineAI(),settings)))
engine.dispose()
import uvicorn
print(f'Kiwi: http://127.0.0.1:{args.port} ({settings.ai_mode})',flush=True)
uvicorn.run('kiwi.main:app',host='127.0.0.1',port=args.port,log_level='info')
