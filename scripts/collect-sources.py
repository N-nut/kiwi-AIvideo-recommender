"""Optional CLI export of the same two public pages used by the home button."""
import asyncio
import json
from kiwi.config import ROOT
from kiwi.crawler import collect_hongguo


async def main():
    rows, sources = await collect_hongguo(print)
    target = ROOT/'data/source-cache/hongguo.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n',encoding='utf-8')
    print(f'{len(rows)} works exported to {target}')


if __name__ == '__main__':
    asyncio.run(main())
