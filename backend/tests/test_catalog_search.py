import copy
from kiwi.database import Work


def test_title_search_paging_filters_and_review_visibility(client,record):
    with client.app.state.sessions.begin() as session:
        for index in range(17):
            row=copy.deepcopy(record)
            row.update(id=f'search-{index:02}',title=f'少年修仙 第 {index} 章',content_hash='a'*64,
                source_meta={'content_type':'漫剧' if index%2==0 else '真人剧'},genres=['修仙'])
            session.add(Work(**row))
        row=copy.deepcopy(record)
        row.update(id='hidden',title='少年未审核作品',review_status='pending',content_hash='b'*64)
        session.add(Work(**row))
    first=client.get('/api/v1/works',params={'q':'  少年修仙  '}).json()
    second=client.get('/api/v1/works',params={'q':'少年修仙','page':2}).json()
    assert first['total']==second['total']==17
    assert len(first['items'])==12 and len(second['items'])==5
    assert not set(w['id'] for w in first['items'])&set(w['id'] for w in second['items'])
    assert client.get('/api/v1/works',params={'q':'少年','genre':'修仙','content_type':'漫剧'}).json()['total']==9
    assert client.get('/api/v1/works',params={'q':'少年','genre':'都市'}).json()['total']==0
    assert client.get('/api/v1/works',params={'q':'少年','content_type':'漫画'}).json()['items']==[]
    assert client.get('/api/v1/works',params={'q':'   '}).json()['total']==17
    assert client.get('/api/v1/works',params={'q':'不存在的名称'}).json()['total']==0


def test_title_search_treats_like_wildcards_as_literal_and_validates_length(client,record):
    with client.app.state.sessions.begin() as session:
        for index,title in enumerate(['100% Kiwi_短剧','100倍 KiwiA短剧','路径\\短剧']):
            row=copy.deepcopy(record);row.update(id=f'literal-{index}',title=title,content_hash='c'*64)
            session.add(Work(**row))
    for query in ['kiwi_','%','_']:
        data=client.get('/api/v1/works',params={'q':query}).json()
        assert data['total']==1 and data['items'][0]['id']=='literal-0'
    assert client.get('/api/v1/works',params={'q':'\\'}).json()['items'][0]['id']=='literal-2'
    assert client.get('/api/v1/works',params={'q':"' OR 1=1 --"}).json()['total']==0
    assert client.get('/api/v1/works',params={'q':'a'*101}).status_code==422
