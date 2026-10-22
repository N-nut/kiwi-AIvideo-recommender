import asyncio
import hashlib
import json
import math
import unicodedata

from sqlalchemy import select

from .database import Work, utc_now
from .providers import ProviderError
from .schemas import WorkInput


def content_hash(item):
    return hashlib.sha256(json.dumps(item.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def search_text(item):
    return f"{item.title}\n{item.original_intro}\n{item.summary}\n题材：{'、'.join(item.genres)}；主题：{'、'.join(item.themes)}"


def normalized_title(title):
    return "".join(c for c in unicodedata.normalize("NFKC", title).casefold() if c.isalnum())


async def import_works(raw, sessions, provider, settings, update=False, reembed=False, replace_hongguo=False, progress=None):
    """Validate the complete batch and embed before a single atomic transaction."""
    items = [WorkInput.model_validate(row) for row in raw]
    unique, titles = {}, {}
    for item in items:
        if item.id in unique and content_hash(unique[item.id]) != content_hash(item):
            raise ValueError(f"同批次 ID 内容冲突：{item.id}")
        title = normalized_title(item.title)
        if title in titles and titles[title] != item.id:
            raise ValueError(f"疑似同名作品需人工确认：{item.title}")
        unique[item.id] = item
        titles[title] = item.id
    staged, vectors, timestamps, skipped = [], [], [], 0
    if replace_hongguo and (not unique or any(not i.startswith("hongguo-") for i in unique)):
        raise ValueError("来源同步必须是非空红果作品批次")
    with sessions() as session:
        existing = {w.id: w for w in session.scalars(select(Work))}
        for item in unique.values():
            old = existing.get(item.id)
            if any(normalized_title(w.title) == normalized_title(item.title) and w.id != item.id for w in existing.values()):
                raise ValueError(f"数据库存在疑似同名作品：{item.title}")
            if old and old.content_hash != content_hash(item) and not update:
                raise ValueError(f"作品已存在，更新需 --update：{item.id}")
            unchanged = old and old.content_hash == content_hash(item)
            vector_current = old and old.embedding_model == settings.embedding_model and old.embedding_dimension == settings.embedding_dimension and old.embedding is not None
            if unchanged and not reembed and (settings.ai_mode == "baseline" or vector_current):
                skipped += 1
                continue
            staged.append(item)
            # Heat, collection date and cover changes do not require new embeddings.
            reusable = not reembed and old and vector_current and search_text(old) == search_text(item)
            vectors.append(old.embedding if reusable else None)
            timestamps.append(old.embedded_at if reusable else None)
    if settings.ai_mode == "live" and staged:
        pending = [i for i, vector in enumerate(vectors) if vector is None]
        for start in range(0, len(pending), 8):
            indexes = pending[start:start + 8]
            batch = [staged[i] for i in indexes]
            if progress:
                progress(f"正在建立检索索引 {start}/{len(pending)}…")
            try:
                embedded = await asyncio.wait_for(provider.embed([search_text(w) for w in batch]), settings.request_timeout)
                if len(embedded) != len(indexes):
                    raise ValueError("向量数量错误，未写入任何资料")
                for index, vector in zip(indexes, embedded, strict=True):
                    vectors[index] = vector
            except TimeoutError as exc:
                raise ProviderError("embedding_timeout", "入库向量化超时，未写入任何资料") from exc
        if len(vectors) != len(staged) or any(v is None or len(v) != settings.embedding_dimension or not all(type(x) in (int,float) and math.isfinite(x) for x in v) or not any(v) for v in vectors):
            raise ValueError("向量数量、维度或数值错误，未写入任何资料")
    with sessions.begin() as session:
        if reembed:
            db_ids = set(session.scalars(select(Work.id)))
            if db_ids - set(unique):
                raise ValueError("--reembed 必须包含整库作品，避免模型版本混用")
        removed = 0
        if replace_hongguo:
            removed = session.query(Work).filter(Work.id.startswith("hongguo-"), Work.id.not_in(unique)).delete(synchronize_session=False)
        for item, vector, embedded_at in zip(staged, vectors, timestamps, strict=True):
            data = item.model_dump(mode="json")
            data.update(content_hash=content_hash(item), embedding=vector,
                        embedding_model=settings.embedding_model if vector is not None else None,
                        embedding_dimension=settings.embedding_dimension if vector is not None else None,
                        embedded_at=(embedded_at or utc_now()) if vector is not None else None)
            session.merge(Work(**data))
    result = {"imported": len(staged), "skipped": skipped, "failed": 0}
    if replace_hongguo:
        result["removed"] = removed
    return result
