import asyncio
import copy
import hashlib
import json
import math
import unicodedata

from sqlalchemy import select, update as update_rows

from .database import Work, WorkReviewState, utc_now
from .crawler import CATEGORY_LABELS, merge_source_metadata
from .providers import ProviderError
from .schemas import WorkInput


def content_hash(item):
    return hashlib.sha256(json.dumps(item.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def search_text(item):
    return f"{item.title}\n{item.original_intro}\n{item.summary}\n题材：{'、'.join(item.genres)}；主题：{'、'.join(item.themes)}"


def normalized_title(title):
    return "".join(c for c in unicodedata.normalize("NFKC", title).casefold() if c.isalnum())


async def import_works(raw, sessions, provider, settings, update=False, reembed=False, source_sync=False, progress=None, expected_hashes=None, expected_revisions=None):
    """Validate the complete batch and embed before a single atomic transaction."""
    from .reviewing import digest, merge_confirmed
    with sessions() as session:
        existing = {w.id: w for w in session.scalars(select(Work))}
    raw_sources, rechecks, expected = {}, {}, {}
    items = []
    discarded = 0
    for row in raw:
        data = copy.deepcopy(row)
        old = existing.get(data.get("id"))
        if old and old.review_state is None:
            raise ValueError("已有作品缺少审核状态，请检查升级")
        if expected_revisions is not None and (not old or expected_revisions.get(old.id) != old.review_state.revision):
            raise ValueError('作品资料在同步期间已改变，已保留较新的资料')
        # Re-embedding must only index the server's effective copy. A normal
        # import is merged with persisted confirmations before full validation.
        source = copy.deepcopy(data)
        if reembed and old:
            from .reviewing import work_data, validate_effective
            data = work_data(old)
            source = copy.deepcopy(old.review_state.source_snapshot["data"])
        if source_sync and old:
            data["source_meta"] = merge_source_metadata(old.source_meta, data.get("source_meta"))
        if reembed and old:
            item = validate_effective(data, old.review_state.confirmed_fields)
            rechecks[item.id] = list(old.review_state.recheck_fields)
        elif old:
            item, recheck = merge_confirmed(data, old.review_state)
            from .reviewing import source_fingerprint
            recheck = sorted(set(recheck) | {f for f,e in old.review_state.confirmed_fields.items() if source_fingerprint(source, f) != e["source_fingerprint"]})
            if source_sync and old.review_state.confirmed_fields and (source.get('source_meta') or {}).get('content_type') not in CATEGORY_LABELS.values():
                recheck = sorted(set(recheck) | {'content_type'})
            rechecks[item.id] = recheck
        else:
            item = WorkInput.model_validate(data)
        if source_sync and (not item.id.startswith('hongguo-') or not item.source_meta or item.source_meta.provider != 'hongguo'):
            raise ValueError('来源同步仅允许红果作品')
        if item.id in raw_sources and digest(raw_sources[item.id]) != digest(source):
            raise ValueError(f"同批次 ID 内容冲突：{item.id}")
        raw_sources[item.id] = source
        expected[item.id] = (old.content_hash, old.review_state.revision) if old else None
        if source_sync and (source.get("source_meta") or {}).get("content_type") not in CATEGORY_LABELS.values() and not (old and old.review_state.confirmed_fields):
            discarded += 1
            continue
        items.append(item)
    filtered_unclassified=discarded
    if source_sync:
        if any(not item.id.startswith('hongguo-') or not item.source_meta or item.source_meta.provider!='hongguo' for item in items):
            raise ValueError('来源同步仅允许红果作品')
        cleaned=[item for item in items if item.source_meta and item.source_meta.content_type in CATEGORY_LABELS.values()]
        filtered_unclassified+=len(items)-len(cleaned)
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
                    keep_content = old.source_meta and old.source_meta.get("categories") and not (raw_sources[item.id].get("source_meta") or {}).get("categories")
                    if old.review_status != "approved":
                        data.update(review_status=old.review_status, review_note=old.review_note)
                        held_count += 1
                        keep_content = True
                    if keep_content:
                        for field in ["title","original_intro","summary","genres","themes","pace","harem","romance","tragic","evidence"]:
                            data[field] = getattr(old, field)
                    if old.review_state.confirmed_fields:
                        from .reviewing import validate_effective
                        item = validate_effective(data, old.review_state.confirmed_fields)
                    else:
                        item = WorkInput.model_validate(data)
            if old and old.content_hash != content_hash(item) and not update:
                raise ValueError(f"作品已存在，更新需 --update：{item.id}")
            unchanged = old and old.content_hash == content_hash(item)
            vector_current = old and old.embedding_model == settings.embedding_model and old.embedding_dimension == settings.embedding_dimension and old.embedding is not None
            source_changed = old and digest(old.review_state.source_snapshot["data"]) != digest(raw_sources[item.id])
            if unchanged and not source_changed and not reembed and (settings.ai_mode == "baseline" or vector_current):
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
    with sessions() as session:
        if session.bind.dialect.name == "sqlite":
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        else:
            from sqlalchemy import text
            session.execute(text("SET LOCAL lock_timeout = '3s'"))
        try:
            _commit_import(session, staged, vectors, timestamps, unique, raw_sources, rechecks, expected,
                           settings, reembed, expected_hashes)
            session.commit()
        except BaseException:
            session.rollback()
            raise
    result = {"imported": len(staged), "skipped": skipped, "failed": 0}
    if source_sync:
        names = {}
        for item in items:
            names.setdefault(normalized_title(item.title), set()).add(item.id)
        same_titles.update(key for key, ids in names.items() if len(ids)>1)
        result.update(new=new_count, updated=updated_count, unchanged=skipped, embedded=len(pending),
                      review_held=held_count, same_title_groups=len(same_titles), removed=0,
                      filtered_unclassified=filtered_unclassified)
    return result


def _commit_import(session, staged, vectors, timestamps, unique, raw_sources, rechecks, expected, settings, reembed, expected_hashes):
    from .corrections import bump, invalidate_reports, lock_work
    from .reviewing import digest
    if reembed:
        db_ids = set(session.scalars(select(Work.id)))
        if db_ids - set(unique):
            raise ValueError("--reembed 必须包含整库作品，避免模型版本混用")
    # All writers lock states/works in the same order. Preparation is complete.
    prepared = sorted(zip(staged, vectors, timestamps, strict=True), key=lambda row:row[0].id)
    for item, vector, embedded_at in prepared:
        data = item.model_dump(mode="json")
        data.update(content_hash=content_hash(item), embedding=vector,
                    embedding_model=settings.embedding_model if vector is not None else None,
                    embedding_dimension=settings.embedding_dimension if vector is not None else None,
                    embedded_at=(embedded_at or utc_now()) if vector is not None else None)
        base = expected[item.id]
        if base is None:
            # Unique PK prevents a concurrent new record from being overwritten.
            work = Work(**data)
            session.add(work)
            session.flush()
            work.review_state.source_snapshot = {"kind":"import", "data":raw_sources[item.id]}
        else:
            work, state = lock_work(session,item.id)
            if state.revision != base[1] or work.content_hash != base[0]:
                raise ValueError('作品资料在同步期间已改变，已保留较新的资料')
            if expected_hashes is not None and expected_hashes.get(item.id) != work.content_hash:
                raise ValueError('作品资料在同步期间已改变，已保留较新的资料')
            result = session.execute(update_rows(Work).where(Work.id == item.id,
                Work.content_hash == base[0]).values(**data), execution_options={"synchronize_session":False})
            if result.rowcount != 1:
                raise ValueError('作品资料在同步期间已改变，已保留较新的资料')
            source = raw_sources[item.id]
            changed = data["content_hash"] != base[0] or digest(state.source_snapshot["data"]) != digest(source)
            if changed:
                before = state.revision
                bump(session,state,source_snapshot={"kind":"source_sync" if item.id.startswith("hongguo-") else "import", "data":source},
                    recheck_fields=rechecks.get(item.id, state.recheck_fields))
                invalidate_reports(session,item.id)
                import uuid
                from .database import WorkReviewEvent
                session.add(WorkReviewEvent(id=uuid.uuid4().hex,actor_key="import:local",actor_id=None,
                    work_id=item.id,operation_id=uuid.uuid4().hex,request_hash=digest(source),kind="source_update",
                    payload={"before_revision":before,"after_revision":state.revision,"recheck_fields":state.recheck_fields},created_at=utc_now()))
