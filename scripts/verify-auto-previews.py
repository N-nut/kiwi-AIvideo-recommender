"""A real first episode for a new work in an isolated catalogue update.

The collector uses a captured public work record; media resolving, downloading,
encoding and HTTP delivery are real. No business accounts are copied.
"""
import json
import logging
import time
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from kiwi.config import ROOT, Settings
from kiwi.database import Work, WorkPreview, make_database, public_work
from kiwi.main import create_app
from kiwi.preview_importer import probe


def main():
    settings=Settings()
    engine,sessions=make_database(settings.database_url)
    with sessions() as session:
        work=session.get(Work,'hongguo-7694653385668037657')
        if not work:
            work=session.scalar(select(Work).where(Work.review_status=='approved',Work.source_meta['content_type'].as_string()=='漫剧').order_by(Work.id))
        assert work
        row={**public_work(work),'review_status':'approved'}
    engine.dispose()
    folder=ROOT/'.local'/f'auto-preview-validation-{uuid4().hex[:10]}'
    folder.mkdir(parents=True)
    test_settings=settings.model_copy(update={'ai_mode':'baseline','database_url':f'sqlite:///{(folder/"kiwi.db").as_posix()}',
        'media_root':folder/'media','preview_auto_enabled':True,'preview_workers':1,'preview_attempts':3,'preview_retry_seconds':1})
    async def collector(scope,progress,settings):
        return [row],{'sources':[],'coverage':'complete','pages_done':1,'raw_count':1,'unique_count':1}
    app=create_app(test_settings,collector=collector)
    logging.getLogger('kiwi').setLevel(logging.WARNING)
    started=time.monotonic()
    with TestClient(app) as client:
        assert client.get('/api/v1/works').json()['total']==0
        response=client.post('/api/v1/catalog/refresh',json={'categories':['real-drama']})
        assert response.status_code==202
        while time.monotonic()-started<240:
            state=client.get('/api/v1/catalog/refresh').json()
            if state['status']=='failed':raise AssertionError(state['message'])
            if state['status']=='succeeded':break
            time.sleep(.2)
        assert state['result']['new']==1 and state['result']['previews_queued']==1
        observed_preparing=False
        while time.monotonic()-started<240:
            metadata=client.get(f'/api/v1/works/{row["id"]}/preview').json()
            observed_preparing |= metadata['preparing']
            if metadata['status']=='ready':break
            if metadata['status']=='unavailable':raise AssertionError(app.state.previews.state())
            time.sleep(1)
        assert metadata['status']=='ready'
        video=client.get(metadata['preview']['video_url'])
        part=client.get(metadata['preview']['video_url'],headers={'Range':'bytes=0-31'})
        assert video.status_code==200 and part.status_code==206 and len(part.content)==32
        assert client.head(metadata['preview']['video_url']).content==b''
        with app.state.sessions() as session:
            preview=session.get(WorkPreview,row['id']);info=probe(test_settings.media_root/preview.video_path,test_settings)
        assert info['video']['codec_name']=='h264' and any(track['codec_name']=='aac' for track in info['audio'])
        app.state.catalog.save(finished_at=None)
        client.post('/api/v1/catalog/refresh',json={'categories':['real-drama']})
        for _ in range(100):
            state=client.get('/api/v1/catalog/refresh').json()
            if state['status']!='running':break
            time.sleep(.1)
        assert state['status']=='succeeded' and state['result']['new']==0 and state['result']['previews_queued']==0
        report={'work_id':row['id'],'title':row['title'],'collector':'captured official metadata fixture','media':'real public first episode',
            'new_work_automatically_prepared':True,'preparing_state_observed':observed_preparing,'repeat_update_reused_asset':True,
            'duration_ms':metadata['preview']['duration_ms'],'audio_codecs':[track['codec_name'] for track in info['audio']],
            'range_status':part.status_code,'elapsed_seconds':round(time.monotonic()-started,2),'business_database_modified':False}
    (ROOT/'docs/auto-preview-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':main()
