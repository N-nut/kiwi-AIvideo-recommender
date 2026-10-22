"""Bounded collection of public Hongguo category and ranking pages."""
import asyncio
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlsplit

import httpx
from pydantic import ValidationError

from .config import Settings
from .schemas import GENRES, THEMES, RefreshRequest, WorkInput

CATEGORY_LABELS = {"real-drama": "真人剧", "comic-drama": "漫剧", "ai-drama": "AI剧", "comic": "漫画"}
SOURCE_URLS = {key: f"https://hongguoduanju.com/category/{key}" for key in CATEGORY_LABELS}
RANK_URL = "https://hongguoduanju.com/rank/hot-drama"
SOURCE_URLS["rank"] = RANK_URL


class CrawlError(Exception):
    pass


class PageData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts, self.streams, self.resolved = [], [], []
        self.active = False

    def handle_starttag(self, tag, attrs):
        if tag == "script":
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


def page_url(key, number):
    if key not in SOURCE_URLS or type(number) is not int or not 1 <= number <= 1000:
        raise CrawlError("来源类别或页码异常")
    return SOURCE_URLS[key] + (f"?page={number}" if number > 1 else "")


def parse_page(html, key, number=1):
    page = PageData()
    try:
        page.feed(html)
        candidates = []
        for script in page.scripts:
            match = re.search(r"(?:window\.)?_ROUTER_DATA\s*=\s*", script)
            if match:
                data = json.JSONDecoder().raw_decode(script[match.end():])[0]
                candidates.extend(v for v in data.get("loaderData", {}).values() if isinstance(v, dict))
        for stream in page.streams:
            for entry in json.loads(stream)[1]:
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
        list_key = "rankList" if key == "rank" else "recommendList"
        for candidate in candidates:
            content = candidate.get("content")
            if isinstance(content, dict):
                candidates.append(content)
            if list_key not in candidate:
                continue
            rows, pagination = candidate[list_key], candidate.get("pagination")
            if candidate.get("isSuccess") is False or not isinstance(rows, list) or len(rows) > 50 or not isinstance(pagination, dict):
                raise CrawlError("来源页面作品或分页信息异常")
            current, total = pagination.get("pageNum"), pagination.get("totalPages")
            if type(current) is not int or current != number or type(total) is not int or not 0 <= total <= 1000 or current > max(total, 1):
                raise CrawlError("来源分页与请求不一致，已停止更新")
            next_url = pagination.get("nextUrl")
            if next_url:
                parsed, base = urlsplit(next_url), urlsplit(SOURCE_URLS[key])
                if (parsed.scheme != "https" or parsed.netloc != base.netloc or parsed.path != base.path
                    or parse_qs(parsed.query) != {"page": [str(number + 1)]} or parsed.fragment or number >= total):
                    raise CrawlError("来源下一页地址异常，已停止更新")
            if not rows and not (number == 1 and total <= 1 and pagination.get("total") == 0):
                raise CrawlError("来源页面意外为空，已保留原片库")
            return rows, total
    except (ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
        raise CrawlError("红果页面结构已变化，暂时无法解析") from exc
    raise CrawlError("来源页面缺少作品数据，已保留原片库")


def safe_cover(value):
    if not isinstance(value, str):
        raise CrawlError("来源封面地址异常")
    try:
        url = urlsplit(value)
        if url.scheme != "https" or not url.hostname or not url.hostname.endswith(".byteimg.com") or url.username or url.password or url.port not in (None, 443):
            raise ValueError()
    except ValueError as exc:
        raise CrawlError("来源封面地址异常") from exc
    return value


def normalize(row, key, collected_at, source_page=None):
    if key not in SOURCE_URLS or not isinstance(row, dict):
        raise CrawlError("来源作品格式异常")
    category = key != "rank"
    sid = str(row.get("series_id") if category else row.get("seriesId"))
    if not re.fullmatch(r"[0-9]{5,24}", sid):
        raise CrawlError("来源作品标识异常")
    title = row.get("series_name") if category else row.get("title")
    intro = row.get("series_intro") if category else row.get("description")
    tags = row.get("tags", [])
    if not isinstance(intro, str) or len(intro.strip()) < 5 or not isinstance(title, str) or not isinstance(tags, list) or any(not isinstance(t, str) or len(t) > 80 for t in tags):
        raise CrawlError(f"来源作品资料不完整（{sid}）")
    intro, tags = intro.strip(), list(dict.fromkeys(tags))
    tag_quote = "来源标签：" + "、".join(tags)
    mappings = {"爱情": "恋爱", "都市爱情": "恋爱", "古风爱情": "古风", "古装": "古风", "古代": "古风",
                "喜剧": "搞笑", "轻喜剧": "搞笑", "修真": "修仙", "武侠仙侠": "武侠", "都市日常": "都市",
                "都市脑洞": "都市", "女性成长": "成长"}
    mapped = set(tags) | {mappings[t] for t in tags if t in mappings}
    genres, themes = [t for t in GENRES if t in mapped], [t for t in THEMES if t in mapped]
    evidence = [{"id": "summary-1", "field": "summary", "quote": intro[:500]}]
    for field, values in [("genres", genres), ("themes", themes)]:
        if values:
            evidence.append({"id": f"{field}-1", "field": field, "quote": tag_quote})
    romance = True if "恋爱" in genres else None
    if romance:
        evidence.append({"id": "romance-1", "field": "romance", "quote": tag_quote})
    kind = CATEGORY_LABELS[key] if category else next((t for t in ["AI剧", "漫剧", "真人剧"] if t in tags), "未标注")
    comic = key == "comic"
    count = row.get("episode_cnt") if category else row.get("episodeCount")
    try:
        return WorkInput.model_validate({"id": f"hongguo-{'comic-' if comic else ''}{sid}", "title": title.strip(),
            "original_intro": intro + ("\n\n" + tag_quote if tags else ""), "summary": intro[:500],
            "genres": genres, "themes": themes, "romance": romance,
            "source_url": f"https://hongguoduanju.com/comic/{sid}" if comic else f"https://hongguoduanju.com/detail?series_id={sid}",
            "cover_url": safe_cover(row.get("series_cover" if category else "cover", "")),
            "source_meta": {"content_type": kind, "tags": tags, "pages": [source_page or SOURCE_URLS[key]],
                "categories": [key] if category else [], "rank": row.get("rank") if not category else None,
                "heat": row.get("heatText") if not category else None,
                "episode_count": None if comic else count, "chapter_count": count if comic else None},
            "collected_at": collected_at, "evidence": evidence, "review_status": "approved",
            "review_note": "红果公开网页自动采集，来源标签按规则映射；按用户授权用于开发验证，待人工复核。未说明的剧情特征保持未知。"}).model_dump(mode="json")
    except ValidationError as exc:
        raise CrawlError(f"作品资料格式异常（{sid}），未更新原库") from exc


def merge_source_metadata(old, new):
    """Keep provenance across both pages and later limited refreshes."""
    if not old:
        return new
    result = {**old, **new}
    result["pages"] = list(dict.fromkeys(new.get("pages", []) + old.get("pages", [])))[:100]
    result["categories"] = list(dict.fromkeys(old.get("categories", []) + new.get("categories", [])))
    old_kind, new_kind = old.get("content_type", "未标注"), new.get("content_type", "未标注")
    if new_kind == "未标注" or old.get("categories") and not new.get("categories"):
        result["content_type"] = old_kind
    elif old.get("categories") and new.get("categories") and old_kind != new_kind:
        result["content_type"] = old_kind
        result["classification_note"] = "来源分类存在差异，待人工核对"
    for field in ["episode_count", "chapter_count"]:
        if new.get(field) is None:
            result[field] = old.get(field)
    # Category-only refreshes must not erase ranking information.
    for field in ["rank", "heat"]:
        if not any('/rank/' in p for p in new.get("pages", [])) and new.get(field) is None:
            result[field] = old.get(field)
    return result


async def read_page(client, url):
    for attempt in range(2):
        try:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                parts, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 8_000_000:
                        raise CrawlError("来源页面过大，已停止更新")
                    parts.append(chunk)
                return b"".join(parts).decode("utf-8")
        except httpx.HTTPError as exc:
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            if status == 429 and attempt == 0:
                try:
                    delay = max(0.5, float(exc.response.headers.get("Retry-After", "1")))
                except ValueError:
                    delay = 1
                if delay > 10:
                    raise CrawlError("红果访问限流，请稍后重试") from exc
                await asyncio.sleep(delay)
            elif attempt == 1 or status is not None and status < 500:
                raise CrawlError("暂时无法访问红果页面，请稍后重试") from exc
            else:
                await asyncio.sleep(0.5)
        except UnicodeError as exc:
            raise CrawlError("来源页面编码异常") from exc


async def collect_hongguo(scope=None, progress=None, *, settings=None, transport=None):
    scope = RefreshRequest.model_validate(scope or {}) if not isinstance(scope, RefreshRequest) else scope
    settings = settings or Settings()
    keys = list(scope.categories) + (["rank"] if scope.include_hot_rank else [])
    rows, counts = {}, []
    raw_count, pages_done, coverage = 0, 0, "complete"
    day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=10), follow_redirects=False,
                                 headers={"User-Agent": "KiwiCatalog/1.0 (public page metadata)"}, transport=transport) as client:
        for key in keys:
            seen = set()
            stats = {"category": key, "label": CATEGORY_LABELS.get(key, "红果热播榜"), "url": SOURCE_URLS[key],
                     "pages": 0, "records": 0, "coverage": "limited"}
            counts.append(stats)
            for number in range(1, settings.crawl_pages_per_source + 1):
                if pages_done >= settings.crawl_max_pages or len(rows) >= settings.crawl_max_works:
                    coverage = "limited"
                    break
                if pages_done:
                    await asyncio.sleep(settings.crawl_interval)
                state = {"stage": "fetching", "category": stats["label"], "current_page": number,
                         "pages_done": pages_done, "raw_count": raw_count, "unique_count": len(rows),
                         "message": f"正在读取{stats['label']} · 第 {number} 页"}
                if progress:
                    progress(state)
                url = page_url(key, number)
                page_rows, total = parse_page(await read_page(client, url), key, number)
                fingerprint = hashlib.sha256(json.dumps(sorted(str(r.get('series_id', r.get('seriesId', ''))) for r in page_rows)).encode()).hexdigest()
                if page_rows and fingerprint in seen:
                    raise CrawlError("来源连续返回重复页面，已保留原片库")
                seen.add(fingerprint)
                pages_done += 1
                stats["pages"] += 1
                stats["records"] += len(page_rows)
                raw_count += len(page_rows)
                truncated = False
                for raw in page_rows:
                    item = normalize(raw, key, day, url)
                    old = rows.get(item["id"])
                    if old:
                        old["source_meta"] = merge_source_metadata(old["source_meta"], item["source_meta"])
                    elif len(rows) < settings.crawl_max_works:
                        rows[item["id"]] = item
                    else:
                        coverage = "limited"
                        truncated = True
                stats["coverage"] = "complete" if number >= total and not truncated else "limited"
                if progress:
                    progress({**state, "pages_done": pages_done, "raw_count": raw_count, "unique_count": len(rows)})
                if number >= total:
                    break
            if stats["coverage"] == "limited":
                coverage = "limited"
    # Resolve types from all selected category pages before discarding unknowns.
    # A genre such as 修仙 is not evidence for a content type such as 漫剧.
    cleaned=[row for row in rows.values() if row['source_meta']['content_type'] in CATEGORY_LABELS.values()]
    filtered=len(rows)-len(cleaned)
    if progress:
        progress({'stage':'cleaning','message':f'资料清洗完成，跳过 {filtered} 部类型不明作品',
                  'pages_done':pages_done,'raw_count':raw_count,'unique_count':len(cleaned),'filtered_unclassified':filtered})
    return cleaned, {"sources": counts, "coverage": coverage, "pages_done": pages_done,
                     "raw_count": raw_count, "discovered_count":len(rows), "unique_count":len(cleaned),
                     "filtered_unclassified":filtered}
