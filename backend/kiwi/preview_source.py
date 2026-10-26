"""Resolve the normal public first-episode player, then download bounded local input."""
import asyncio
import re
import json
import os
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

from .preview_importer import MediaError


def source_identity(work):
    match = re.fullmatch(r"hongguo-(\d{5,24})", work["id"])
    parsed = urlsplit(work["source_url"])
    if (not match or (work.get("source_meta") or {}).get("provider") != "hongguo"
            or parsed.scheme != "https" or parsed.hostname not in {"hongguoduanju.com", "www.hongguoduanju.com"}
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.path != "/detail" or parse_qs(parsed.query) != {"series_id": [match[1]]}):
        raise MediaError("source", "unsupported_source")
    return match[1]


def validate_media_url(value):
    try:
        parsed = urlsplit(value)
        allowed = bool(re.fullmatch(r"(?:v\d+-(?:hgweb|reading)\.qznovelvod\.com|[a-f0-9]{32,64}\.v\.smtcdns\.com)", parsed.hostname or "")) or (
            parsed.hostname in {"hongguoduanju.com", "www.hongguoduanju.com"} and bool(re.fullmatch(r"/video/public/\d{5,24}/(?:360p|480p|720p)\.mp4", parsed.path)))
        if (parsed.scheme != "https" or not allowed
                or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment):
            raise ValueError()
    except (ValueError, TypeError):
        raise MediaError("source", "media_host_rejected") from None
    return value


class HongguoPreviewSource:
    def __init__(self, settings):
        self.settings = settings
        self.process = self.reader = None
        self.pending = {}
        self.write_lock = asyncio.Lock()
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(settings.preview_fetch_timeout, connect=15), follow_redirects=False)

    async def start(self):
        from .config import ROOT
        environment = {**os.environ, "KIWI_PREVIEW_BROWSER":self.settings.preview_browser_channel}
        module = self.settings.preview_playwright_module
        if not module and (ROOT / "node_modules/playwright").is_dir():
            module = str(ROOT / "node_modules/playwright")
        if module:
            environment["KIWI_PLAYWRIGHT_MODULE"] = module
        try:
            self.process = await asyncio.create_subprocess_exec(self.settings.preview_node_path, str(Path(__file__).with_name("player_bridge.mjs")),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                env=environment, creationflags=0x08000000 if os.name=="nt" else 0)
            message=json.loads(await asyncio.wait_for(self.process.stdout.readline(),15))
            if message.get("type")!="ready":
                raise ValueError()
            self.reader=asyncio.create_task(self.read_responses())
        except Exception:
            await self.close()
            raise MediaError("source","browser_unavailable") from None

    async def read_responses(self):
        try:
            while line:=await self.process.stdout.readline():
                data=json.loads(line)
                future=self.pending.get(data.get("request_id"))
                if not future or future.done():
                    continue
                if data.get("error"):
                    error=MediaError("source",data["error"])
                    error.diagnostic=data.get('diagnostic')
                    future.set_exception(error)
                else:
                    future.set_result(data["info"])
        finally:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(MediaError("source","browser_unavailable"))

    async def resolve(self, work):
        series_id=source_identity(work)
        request_id=uuid.uuid4().hex
        future=asyncio.get_running_loop().create_future()
        self.pending[request_id]=future
        try:
            async with self.write_lock:
                self.process.stdin.write((json.dumps({"request_id":request_id,"series_id":series_id,"title":work["title"]},ensure_ascii=False)+"\n").encode())
                await self.process.stdin.drain()
            info=await asyncio.wait_for(future,60)
            if (str(info.get("series_id"))!=series_id or info.get("title")!=work["title"] or not info.get("episode_id")
                    or info["episode_id"]!=info.get("first_episode_id")):
                raise MediaError("source","episode_identity_mismatch")
            info["url"]=validate_media_url(info["url"])
            info["source_page_url"]=f"https://hongguoduanju.com/player/{series_id}/{info['episode_id']}"
            return info
        except MediaError:
            raise
        except Exception:
            raise MediaError("source","player_unavailable") from None
        finally:
            self.pending.pop(request_id,None)

    async def download(self, info, target):
        url = validate_media_url(info["url"])
        try:
            async with asyncio.timeout(self.settings.preview_fetch_timeout):
                for _ in range(4):
                    headers={"Referer":info.get("referer",info["source_page_url"])}
                    if info.get("user_agent"):
                        headers["User-Agent"]=info["user_agent"]
                    async with self.client.stream("GET", url, headers=headers) as response:
                        if response.status_code in (301, 302, 303, 307, 308):
                            from urllib.parse import urljoin
                            url = validate_media_url(urljoin(url, response.headers.get("location", "")))
                            continue
                        if response.status_code != 200:
                            raise MediaError("download", f"media_http_{response.status_code}")
                        length = response.headers.get("content-length")
                        if length and int(length) > self.settings.preview_source_max_bytes:
                            raise MediaError("download", "source_size_limit")
                        size = 0
                        with Path(target).open("wb") as stream:
                            async for chunk in response.aiter_bytes(64 * 1024):
                                size += len(chunk)
                                if size > self.settings.preview_source_max_bytes:
                                    raise MediaError("download", "source_size_limit")
                                stream.write(chunk)
                        if size == 0 or (length and size != int(length)):
                            raise MediaError("download", "incomplete_source")
                        return size
                raise MediaError("download", "redirect_limit")
        except MediaError:
            raise
        except Exception:
            raise MediaError("download", "download_failed") from None

    async def close(self):
        if self.process and self.process.returncode is None:
            try:
                self.process.stdin.write(b'{"type":"close"}\n')
                await self.process.stdin.drain()
                await asyncio.wait_for(self.process.wait(),10)
            except Exception:
                if self.process.returncode is None:
                    self.process.terminate()
                    await self.process.wait()
        if self.reader:
            await asyncio.gather(self.reader,return_exceptions=True)
        await self.client.aclose()
