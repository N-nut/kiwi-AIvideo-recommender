"""Read the public HTML of exactly the two user-selected Hongguo pages.

No script evaluation, private API, video download or browser session is needed.
The current scope is the visible first page of each source, not the entire site.
"""
import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit

import httpx

from .schemas import GENRES, THEMES, WorkInput

SOURCES = (
    "https://hongguoduanju.com/category/real-drama",
    "https://hongguoduanju.com/rank/hot-drama",
)


class CrawlError(Exception):
    pass


class PageData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.streams = []
        self.resolved = []
        self.active = False

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        self.active = True
        attrs = dict(attrs)
        if attrs.get("data-fn-name") == "mergeLoaderData":
            self.streams.append(attrs.get("data-fn-args", ""))
        if attrs.get("data-script-src") == "modern-run-router-data-fn":
            self.resolved.append(attrs.get("data-fn-args", ""))

    def handle_data(self, data):
        if self.active:
            self.scripts.append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False


def source_rows(html, source):
    """Parse plain JSON, including Modern.js streamed loader arguments."""
    page = PageData()
    page.feed(html)
    candidates = []
    try:
        for script in page.scripts:
            match = re.search(r"(?:window\.)?_ROUTER_DATA\s*=\s*", script)
            if match:
                data = json.JSONDecoder().raw_decode(script[match.end():])[0]
                candidates.extend(v for v in data.get("loaderData", {}).values() if isinstance(v, dict))
        for stream in page.streams:
            args = json.loads(stream)
            for entry in args[1]:
                if entry.get("key") == "content" and entry.get("routerDataFnName") == "p":
                    content = entry["routerDataFnArgs"][0]
                    for _ in range(3):
                        if not isinstance(content, str):
                            break
                        content = json.loads(content)
                    if isinstance(content, dict):
                        candidates.append(content)
        for resolved in page.resolved:
            args = json.loads(resolved)
            if len(args) == 3 and args[1] == "content" and isinstance(args[2], dict):
                candidates.append(args[2])
        key = "recommendList" if source == SOURCES[0] else "rankList"
        for candidate in candidates:
            content = candidate.get("content")
            rows = candidate.get(key) or (content.get(key) if isinstance(content, dict) else None)
            if isinstance(rows, list) and rows:
                if not 1 <= len(rows) <= 50:
                    raise CrawlError("来源页面作品数量异常，已停止更新")
                return rows
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        raise CrawlError("红果页面结构已变化，暂时无法解析，请稍后重试") from exc
    raise CrawlError("来源页面未返回作品，已保留原片库")


def safe_cover(value):
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or not url.hostname.endswith(".byteimg.com") or url.username or url.password:
        raise CrawlError("来源封面地址异常，已停止更新")
    return value


def normalize(row, source, collected_at):
    is_category = source == SOURCES[0]
    sid = str(row.get("series_id") if is_category else row.get("seriesId"))
    if not re.fullmatch(r"[0-9]{5,24}", sid):
        raise CrawlError("来源作品标识异常，已停止更新")
    title = row.get("series_name") if is_category else row.get("title")
    intro = row.get("series_intro") if is_category else row.get("description")
    tags = row.get("tags", [])
    if not isinstance(intro, str) or len(intro.strip()) < 5 or not isinstance(title, str) or not isinstance(tags, list) or any(not isinstance(t, str) or len(t) > 80 for t in tags):
        raise CrawlError("来源作品资料不完整，已停止更新")
    intro = intro.strip()
    tag_quote = "来源标签：" + "、".join(tags)
    # Preserve source labels verbatim as evidence for deterministic mappings.
    original = intro + ("\n\n" + tag_quote if tags else "")
    mappings = {"爱情": "恋爱", "都市爱情": "恋爱", "古风爱情": "古风", "古装": "古风", "古代": "古风",
                "喜剧": "搞笑", "轻喜剧": "搞笑", "修真": "修仙", "女性成长": "成长"}
    mapped = set(tags) | {mappings[t] for t in tags if t in mappings}
    genres, themes = [t for t in GENRES if t in mapped], [t for t in THEMES if t in mapped]
    evidence = [{"id": "summary-1", "field": "summary", "quote": intro[:500]}]
    for field, values in [("genres", genres), ("themes", themes)]:
        if values:
            evidence.append({"id": f"{field}-1", "field": field, "quote": tag_quote})
    romance = True if "恋爱" in genres else None
    if romance:
        evidence.append({"id": "romance-1", "field": "romance", "quote": tag_quote})
    kind = "真人剧" if is_category else next((t for t in ["AI剧", "漫剧", "真人剧"] if t in tags), "未标注")
    return WorkInput.model_validate({"id": f"hongguo-{sid}", "title": title.strip(), "original_intro": original,
        "summary": intro[:500], "genres": genres, "themes": themes, "romance": romance,
        "source_url": f"https://hongguoduanju.com/detail?series_id={sid}",
        "cover_url": safe_cover(row.get("series_cover" if is_category else "cover", "")),
        "source_meta": {"content_type": kind, "tags": tags, "pages": [source],
                        "rank": None if is_category else row.get("rank"),
                        "heat": None if is_category else row.get("heatText"),
                        "episode_count": row.get("episode_cnt") if is_category else None},
        "collected_at": collected_at, "evidence": evidence, "review_status": "approved",
        "review_note": "红果公开网页自动采集，来源标签按规则映射；按用户授权用于开发验证，待人工复核。未说明的剧情特征保持未知。"}).model_dump(mode="json")


async def collect_hongguo(progress=None, transport=None):
    rows = {}
    counts = []
    day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=10), follow_redirects=False,
                                 headers={"User-Agent": "KiwiCatalog/1.0 (public page metadata)"}, transport=transport) as client:
        for index, source in enumerate(SOURCES):
            if progress:
                progress(f"正在读取{'真人剧分类' if index == 0 else '红果热播榜'}…")
            response = None
            for attempt in range(2):
                try:
                    async with client.stream("GET", source) as upstream:
                        upstream.raise_for_status()
                        parts, size = [], 0
                        async for chunk in upstream.aiter_bytes():
                            size += len(chunk)
                            if size > 8_000_000:
                                raise CrawlError("来源页面过大，已停止更新")
                            parts.append(chunk)
                        response = b"".join(parts).decode("utf-8")
                    break
                except httpx.HTTPError as exc:
                    if attempt == 1 or isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500:
                        raise CrawlError("暂时无法访问红果页面，请稍后重试") from exc
                    await asyncio.sleep(0.5)
            page_rows = source_rows(response, source)
            counts.append({"url": source, "works": len(page_rows)})
            for raw in page_rows:
                item = normalize(raw, source, day)
                old = rows.get(item["id"])
                if old:
                    # Same series_id across both pages is one work, with both sources.
                    old["source_meta"].update(rank=item["source_meta"]["rank"], heat=item["source_meta"]["heat"])
                    if source not in old["source_meta"]["pages"]:
                        old["source_meta"]["pages"].append(source)
                else:
                    rows[item["id"]] = item
            if index == 0:
                await asyncio.sleep(0.35)
    return list(rows.values()), counts
