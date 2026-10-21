import math

from pgvector.sqlalchemy import Vector
from sqlalchemy import cast, exists, func, select
from sqlalchemy.dialects.postgresql import JSONB

from .database import Work


def array_has(column, value, dialect):
    if dialect == "postgresql":
        return cast(column, JSONB).contains([value])
    elements = func.json_each(column).table_valued("value")
    return exists(select(1).select_from(elements).where(elements.c.value == value))


def constrained_query(prefs, dialect):
    query = select(Work).where(Work.review_status == "approved")
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


def retrieve(session, prefs, vector, settings):
    dialect = session.bind.dialect.name
    query = constrained_query(prefs, dialect)
    if vector is None:
        from .rules import soft_matches
        rows = list(session.scalars(query))
        rows.sort(key=lambda w: (-len(soft_matches(w, prefs)[0]), w.id))
        return [(w, None) for w in rows[:10]]
    query = query.where(Work.embedding.is_not(None), Work.embedding_model == settings.embedding_model,
                        Work.embedding_dimension == settings.embedding_dimension)
    if dialect == "postgresql":
        distance = Work.embedding.cosine_distance(vector)
        rows = session.execute(query.add_columns(distance.label("distance")).order_by(distance, Work.id).limit(10))
        return [(w, 1.0 - float(d)) for w, d in rows]
    rows = [(w, cosine(w.embedding, vector)) for w in session.scalars(query)]
    return sorted(rows, key=lambda pair: (-pair[1], pair[0].id))[:10]
