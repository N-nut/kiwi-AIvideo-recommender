import asyncio
import hashlib
import json
import math
import unicodedata

from sqlalchemy import select, update as update_rows

from .database import Work, utc_now
from .crawler import CATEGORY_LABELS, merge_source_metadata
from .providers import ProviderError
from .schemas import WorkInput


def content_hash(item):
    return hashlib.sha256(json.dumps(item.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def search_text(item):
    return f"{item.title}\n{item.original_intro}\n{item.summary}\n题材：{'、'.join(item.genres)}；主题：{'、'.join(item.themes)}"


def normalized_title(title):
    return "".join(c for c in unicodedata.normalize("NFKC", title).casefold() if c.isalnum())


async def import_works(raw, sessions, provider, settings, update=False, reembed=False, source_sync=False, progress=None, expected_hashes=None):
    """Validate the complete batch and embed before a single atomic transaction."""
    items = [WorkInput.model_validate(row) for row in raw]
    filtered_unclassified=0
    if source_sync:
        if any(not item.id.startswith('hongguo-') or not item.source_meta or item.source_meta.provider!='hongguo' for item in items):
            raise ValueError('来源同步仅允许红果作品')
        cleaned=[item for item in items if item.source_meta and item.source_meta.content_type in CATEGORY_LABELS.values()]
        filtered_unclassified=len(items)-len(cleaned)
        items=cleaned
    unique, titles = {}, {}
    for item in items:
        if item.id in unique and content_hash(unique[item.id]) != content_hash(item):
            raise ValueError(f"同批次 ID 内容冲突：{item.id}")
        title = normalized_title(item.title)
        if title in titles and titles[title] != item.id and not source_sync:
            raise ValueError(f"疑似同名作品需人工确认：{item.title}")
        unique[item.id] = item
        titles[title] = item.id
    staged, vectors, timestamps, skipped = [], [], [], 0
    new_count, updated_count, held_count, same_titles = 0, 0, 0, set()
    with sessions() as session:
        existing = {w.id: w for w in session.scalars(select(Work))}
        for item in unique.values():
            old = existing.get(item.id)
            same_name = any(normalized_title(w.title) == normalized_title(item.title) and w.id != item.id for w in existing.values())
            if same_name and not source_sync:
                raise ValueError(f"数据库存在疑似同名作品：{item.title}")
            if source_sync:
                if same_name:
                    same_titles.add(normalized_title(item.title))
                if old:
                    data = item.model_dump(mode="json")
                    data["source_meta"] = merge_source_metadata(old.source_meta, data["source_meta"])
                    # Ranking metadata must not replace richer category evidence.
                    keep_content = old.source_meta and old.source_meta.get("categories") and not item.source_meta.categories
                    if old.review_status != "approved":
                        data.update(review_status=old.review_status, review_note=old.review_note)
                        held_count += 1
                        keep_content = True
                    if keep_content:
                        for field in ["title","original_intro","summary","genres","themes","pace","harem","romance","tragic","evidence"]:
                            data[field] = getattr(old, field)
                    item = WorkInput.model_validate(data)
            if old and old.content_hash != content_hash(item) and not update:
                raise ValueError(f"作品已存在，更新需 --update：{item.id}")
            unchanged = old and old.content_hash == content_hash(item)
            vector_current = old and old.embedding_model == settings.embedding_model and old.embedding_dimension == settings.embedding_dimension and old.embedding is not None
            if unchanged and not reembed and (settings.ai_mode == "baseline" or vector_current):
                skipped += 1
                continue
            staged.append(item)
            if old:
                updated_count += 1
            else:
                new_count += 1
            # Heat, collection date and cover changes do not require new embeddings.
            reusable = not reembed and old and vector_current and search_text(old) == search_text(item)
            vectors.append(old.embedding if reusable else None)
            timestamps.append(old.embedded_at if reusable else None)
    pending = []
    if settings.ai_mode == "live" and staged:
        pending = [i for i, vector in enumerate(vectors) if vector is None]
        for start in range(0, len(pending), 8):
            indexes = pending[start:start + 8]
            batch = [staged[i] for i in indexes]
            if progress:
                progress({"stage":"indexing", "indexed":start, "index_total":len(pending), "message":f"正在建立检索索引 {start}/{len(pending)}…"})
            try:
                embedded = await asyncio.wait_for(provider.embed([search_text(w) for w in batch]), settings.request_timeout)
                if len(embedded) != len(indexes):
                    raise ValueError("向量数量错误，未写入任何资料")
                for index, vector in zip(indexes, embedded, strict=True):
                    vectors[index] = vector
                if progress:
                    progress({"stage":"indexing", "indexed":start+len(indexes), "index_total":len(pending), "message":f"正在建立检索索引 {start+len(indexes)}/{len(pending)}…"})
            except TimeoutError as exc:
                raise ProviderError("embedding_timeout", "入库向量化超时，未写入任何资料") from exc
        if len(vectors) != len(staged) or any(v is None or len(v) != settings.embedding_dimension or not all(type(x) in (int,float) and math.isfinite(x) for x in v) or not any(v) for v in vectors):
            raise ValueError("向量数量、维度或数值错误，未写入任何资料")
    if progress:
        progress({"stage":"committing", "message":"正在保存已校验资料…"})
    with sessions.begin() as session:
        if reembed:
            db_ids = set(session.scalars(select(Work.id)))
            if db_ids - set(unique):
                raise ValueError("--reembed 必须包含整库作品，避免模型版本混用")
        for item, vector, embedded_at in zip(staged, vectors, timestamps, strict=True):
            data = item.model_dump(mode="json")
            data.update(content_hash=content_hash(item), embedding=vector,
                        embedding_model=settings.embedding_model if vector is not None else None,
                        embedding_dimension=settings.embedding_dimension if vector is not None else None,
                        embedded_at=(embedded_at or utc_now()) if vector is not None else None)
            if expected_hashes is None:
                session.merge(Work(**data))
            else:
                # Compare and update in one SQL statement on SQLite and PostgreSQL.
                result = session.execute(update_rows(Work).where(Work.id == item.id,
                    Work.content_hash == expected_hashes.get(item.id), Work.review_status == 'approved').values(**data))
                if result.rowcount != 1:
                    raise ValueError('作品资料在同步期间已改变，已保留较新的资料')
    result = {"imported": len(staged), "skipped": skipped, "failed": 0}
    if source_sync:
        # Source refresh is always upsert; unseen and unselected works survive.
        names = {}
        for item in items:
            names.setdefault(normalized_title(item.title), set()).add(item.id)
        same_titles.update(key for key, ids in names.items() if len(ids)>1)
        result.update(new=new_count, updated=updated_count, unchanged=skipped, embedded=len(pending),
                      review_held=held_count, same_title_groups=len(same_titles), removed=0,
                      filtered_unclassified=filtered_unclassified)
    return result
