import math

from pgvector.sqlalchemy import Vector
from sqlalchemy import case, cast, exists, func, select
from sqlalchemy.dialects.postgresql import JSONB

from .database import UserWorkFeedback, Work


def array_has(column, value, dialect):
    if dialect == "postgresql":
        return cast(column, JSONB).contains([value])
    elements = func.json_each(column).table_valued("value")
    return exists(select(1).select_from(elements).where(elements.c.value == value))


def constrained_query(prefs, dialect, exclude_work_ids=(), user_id=None):
    query = select(Work).where(Work.review_status == "approved")
    if exclude_work_ids:
        query = query.where(Work.id.not_in(exclude_work_ids))
    if user_id is not None:
        query = query.where(~exists(select(1).where(UserWorkFeedback.user_id == user_id, UserWorkFeedback.work_id == Work.id)))
    for field in prefs.excluded_features:
        query = query.where(getattr(Work, field).is_(False))
    for genre in prefs.excluded_genres:
        query = query.where(~array_has(Work.genres, genre, dialect))
    for req in prefs.required:
        column = getattr(Work, req.field)
        query = query.where(array_has(column, req.value, dialect) if req.field in ("genres", "themes") else column == req.value)
    return query


def cosine(a, b):
    denominator = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b, strict=True)) / denominator if denominator else 0.0


def retrieve(session, prefs, vector, settings, *, exclude_work_ids=(), user_id=None, offset=0, limit=10):
    dialect = session.bind.dialect.name
    query = constrained_query(prefs, dialect, exclude_work_ids, user_id)
    if vector is None:
        soft = prefs.soft_preferences
        conditions = [array_has(Work.genres, g, dialect) for g in soft.genres] + [array_has(Work.themes, t, dialect) for t in soft.themes]
        if soft.pace:
            conditions.append(Work.pace == soft.pace)
        score = sum((case((condition, 1), else_=0) for condition in conditions), 0)
        order = [score.desc(), Work.id] if conditions else [Work.id]
        return [(w, None) for w in session.scalars(query.order_by(*order).offset(offset).limit(limit))]
    query = query.where(Work.embedding.is_not(None), Work.embedding_model == settings.embedding_model,
                        Work.embedding_dimension == settings.embedding_dimension)
    if dialect == "postgresql":
        distance = Work.embedding.cosine_distance(vector)
        rows = session.execute(query.add_columns(distance.label("distance")).order_by(distance, Work.id).offset(offset).limit(limit))
        return [(w, 1.0 - float(d)) for w, d in rows]
    rows = [(w, cosine(w.embedding, vector)) for w in session.scalars(query)]
    return sorted(rows, key=lambda pair: (-pair[1], pair[0].id))[offset:offset+limit]
