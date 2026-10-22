"""The new-catalog benchmark must not silently evaluate stale reference labels."""
import importlib.util
import pytest
from kiwi.config import ROOT
from kiwi.database import Work
from kiwi.importer import import_works

spec=importlib.util.spec_from_file_location('kiwi_evaluation',ROOT/'scripts/evaluate.py')
evaluation=importlib.util.module_from_spec(spec);spec.loader.exec_module(evaluation)


async def test_reference_matches_current_catalog_and_ignores_only_display_metadata(database,record,baseline_settings):
    await import_works([record],database,None,baseline_settings)
    fingerprint,_=evaluation.catalog_fingerprint(database)
    reference={'catalog_sha256':fingerprint,'cases':[{'preferences':{},'relevant_ids':[record['id']]}]}
    assert evaluation.validate_reference(reference,database)==(fingerprint,1)
    with database.begin() as session: session.get(Work,record['id']).cover_url='https://example.com/new.jpg'
    assert evaluation.validate_reference(reference,database)==(fingerprint,1)
    with database.begin() as session: session.get(Work,record['id']).summary+='changed'
    with pytest.raises(ValueError,match='内容已变化'): evaluation.validate_reference(reference,database)


async def test_reference_rejects_empty_or_unknown_ids(database,record,baseline_settings):
    await import_works([record],database,None,baseline_settings)
    fingerprint,_=evaluation.catalog_fingerprint(database)
    with pytest.raises(ValueError,match='参考集为空'): evaluation.validate_reference({'cases':[]},database)
    reference={'catalog_sha256':fingerprint,'cases':[{'preferences':{},'relevant_ids':['missing']}]}
    with pytest.raises(ValueError,match='不存在'): evaluation.validate_reference(reference,database)
