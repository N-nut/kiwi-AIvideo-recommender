import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError, IntegrityError

from kiwi.database import PreviewJob, Work, WorkPreview, utc_now
from kiwi.preview_importer import MediaError, PreviewInput, encode, import_previews, probe, run_tool

ASSET = "a" * 32


def seed(sessions, record, kind="漫剧"):
    data = copy.deepcopy(record)
    data.update(source_meta={"content_type": kind}, content_hash="original-fingerprint")
    with sessions.begin() as session:
        session.add(Work(**data))


def ready(sessions, root, work_id="work-a", asset=ASSET):
    folder = root / asset
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "clip.mp4").write_bytes(b"0123456789" * 10)
    (folder / "poster.jpg").write_bytes(b"jpeg")
    now = utc_now()
    values = dict(work_id=work_id, asset_id=asset, status="ready", clip_kind="excerpt", video_path=f"{asset}/clip.mp4",
        poster_path=f"{asset}/poster.jpg", duration_ms=15000, width=720, height=1280, size_bytes=100,
        source_page_url="https://example.org/first-episode", usage_basis="test-only local fixture", source_hash="s"*64,
        processing_hash="p"*64, video_sha256="v"*64, checked_at=now, created_at=now, updated_at=now)
    with sessions.begin() as session:
        session.merge(WorkPreview(**values))
    return values


def test_public_states_and_private_fields(client, record, tmp_path):
    settings = client.app.state.settings
    settings.media_root = tmp_path
    sessions = client.app.state.sessions
    seed(sessions, record)
    url = "/api/v1/works/work-a/preview"
    response = client.get(url)
    assert response.status_code == 200 and response.json()["status"] == "missing"
    assert response.headers["cache-control"] == "no-store"
    for state in ("pending", "unavailable"):
        with sessions.begin() as session:
            session.merge(WorkPreview(work_id="work-a", status=state, clip_kind="excerpt", source_page_url="https://example.org/episode", usage_basis="awaiting verification", created_at=utc_now(), updated_at=utc_now()))
        data = client.get(url).json()
        assert data["status"] == state and data["preview"] is None
    ready(sessions, tmp_path)
    data = client.get(url).json()
    assert data["status"] == "ready" and data["message"] == "试看片段"
    assert data["preview"]["video_url"] == f"/api/v1/media/previews/{ASSET}/video"
    assert not set(data["preview"]) & {"video_path", "poster_path", "usage_basis", "source_hash", "processing_hash", "video_sha256"}
    (tmp_path / ASSET / "poster.jpg").unlink()
    assert client.get(url).json()["preview"]["poster_url"] is None
    with sessions.begin() as session:
        session.get(Work, "work-a").source_meta = {"content_type": "漫画"}
    assert client.get(url).json()["status"] == "not_applicable"
    assert client.get(f"/api/v1/media/previews/{ASSET}/video").status_code == 404
    with sessions.begin() as session:
        session.get(Work, "work-a").review_status = "pending"
    assert client.get(url).status_code == 404
    assert client.get("/api/v1/works/unknown/preview").status_code == 404


def test_automatic_preparation_is_distinct_from_unconfirmed_manual_media(client,record):
    sessions=client.app.state.sessions;seed(sessions,record)
    client.app.state.settings.preview_auto_enabled=True
    with sessions.begin() as session:
        session.add(PreviewJob(work_id='work-a',status='pending',source_key='s'*64,attempts=0,created_at=utc_now(),updated_at=utc_now()))
    result=client.get('/api/v1/works/work-a/preview').json()
    assert result['status']=='pending' and result['preparing'] and result['message']=='预览准备中'
    from kiwi.database import CatalogRefresh
    with sessions.begin() as session:
        session.add(CatalogRefresh(id='preview-service',payload={'error_code':'browser_unavailable'}))
    result=client.get('/api/v1/works/work-a/preview').json()
    assert result['status']=='unavailable' and not result['preparing']
    with sessions.begin() as session:session.delete(session.get(CatalogRefresh,'preview-service'))
    with sessions.begin() as session:session.get(PreviewJob,'work-a').status='unavailable'
    result=client.get('/api/v1/works/work-a/preview').json()
    assert result['status']=='unavailable' and not result['preparing']
    with sessions.begin() as session:
        session.delete(session.get(PreviewJob,'work-a'))
        session.add(WorkPreview(work_id='work-a',status='pending',clip_kind='excerpt',usage_basis='unconfirmed',source_page_url='https://example.org/source',created_at=utc_now(),updated_at=utc_now()))
    result=client.get('/api/v1/works/work-a/preview').json()
    assert result['status']=='pending' and not result['preparing'] and result['message']=='暂无视频预览'


def test_range_head_and_invalidated_assets(client, record, tmp_path):
    client.app.state.settings.media_root = tmp_path
    sessions = client.app.state.sessions
    seed(sessions, record)
    ready(sessions, tmp_path)
    url = f"/api/v1/media/previews/{ASSET}/video"
    full = client.get(url)
    assert full.status_code == 200 and full.content == b"0123456789" * 10
    assert full.headers["content-type"] == "video/mp4" and full.headers["accept-ranges"] == "bytes"
    assert full.headers["content-length"] == "100" and full.headers["cache-control"] == "no-store"
    for header, expected, content in [("bytes=2-5", "bytes 2-5/100", b"2345"), ("bytes=-3", "bytes 97-99/100", b"789"), ("bytes=97-", "bytes 97-99/100", b"789")]:
        part = client.get(url, headers={"Range": header})
        assert part.status_code == 206 and part.headers["content-range"] == expected and part.content == content
    invalid = client.get(url, headers={"Range": "bytes=100-"})
    assert invalid.status_code == 416 and invalid.headers["content-range"] == "bytes */100"
    head = client.head(url)
    assert head.status_code == 200 and head.content == b"" and head.headers["content-length"] == "100"
    assert client.head(url.replace("/video", "/poster")).headers["content-type"] == "image/jpeg"
    ready(sessions, tmp_path, asset="b" * 32)
    assert client.get(url).status_code == 404
    (tmp_path / ("b" * 32) / "clip.mp4").unlink()
    assert client.get("/api/v1/works/work-a/preview").json()["status"] == "unavailable"
    assert client.get(url.replace(ASSET, "b" * 32)).status_code == 404


@pytest.mark.parametrize("relative", ["../secret.mp4", "/tmp/private.mp4", ASSET + "/../../secret.mp4", ASSET + "/poster.jpg"])
def test_corrupt_database_paths_are_never_served(client, record, tmp_path, relative):
    client.app.state.settings.media_root = tmp_path
    seed(client.app.state.sessions, record)
    ready(client.app.state.sessions, tmp_path)
    with client.app.state.sessions.begin() as session:
        session.get(WorkPreview, "work-a").video_path = relative
    assert client.get(f"/api/v1/media/previews/{ASSET}/video").status_code == 404
    assert client.get("/api/v1/works/work-a/preview").json()["status"] == "unavailable"


def test_extra_fields_errors_and_nginx_delivery(client, record, tmp_path, monkeypatch):
    client.app.state.settings.media_root = tmp_path
    seed(client.app.state.sessions, record)
    ready(client.app.state.sessions, tmp_path)
    for url in ["/api/v1/works/work-a/preview?url=https://example.org", f"/api/v1/media/previews/{ASSET}/video?path=secret", "/api/v1/media/previews/invalid/video"]:
        response = client.get(url)
        assert response.status_code == 422 and response.json()["request_id"]
    client.app.state.settings.media_delivery_mode = "nginx"
    for method in (client.get, client.head):
        response = method(f"/api/v1/media/previews/{ASSET}/video")
        assert response.headers["x-accel-redirect"] == f"/_kiwi_previews/{ASSET}/clip.mp4"
        assert response.headers["cache-control"] == "no-store" and not response.content
    monkeypatch.setattr(client.app.state, "sessions", Mock(side_effect=SQLAlchemyError("secret connection details")))
    response = client.get("/api/v1/works/work-a/preview")
    assert response.status_code == 503 and response.json()["request_id"]
    assert "secret" not in response.text


def manifest(tmp_path, **changes):
    values = {"work_id": "work-a", "source_file": "source.mp4", "source_page_url": "https://example.org/episode", "usage_basis": "test-only permission",
              "clip_kind": "excerpt", "start_seconds": 0, "duration_seconds": 15, "work_confirmed": True, "usage_confirmed": True, **changes}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps([values]), encoding="utf-8")
    if not (tmp_path / "source.mp4").exists():
        (tmp_path / "source.mp4").write_bytes(b"source")
    return path


def mock_processing(monkeypatch):
    import kiwi.preview_importer as importer
    monkeypatch.setattr(importer, "probe", lambda *_: {"duration": 30})
    monkeypatch.setattr(importer, "run_tool", lambda *_: b"ffmpeg test-version\n")
    def fake_encode(item, source, stage, settings):
        (stage / "clip.mp4").write_bytes(b"test clip")
        (stage / "poster.jpg").write_bytes(b"test poster")
        return {"duration_ms":15000, "width":720, "height":1280, "size_bytes":9, "video_sha256":importer.digest(stage / "clip.mp4")}
    monkeypatch.setattr(importer, "encode", fake_encode)
    return importer


def test_check_only_publish_idempotence_and_pending_replacement(database, record, tmp_path, baseline_settings, monkeypatch):
    settings = baseline_settings
    settings.media_root = tmp_path / "media"
    seed(database, record)
    importer = mock_processing(monkeypatch)
    path = manifest(tmp_path)
    assert import_previews(path, database, settings, True)["ready"] == 1
    assert not settings.media_root.exists()
    with database() as session:
        assert session.get(WorkPreview, "work-a") is None
    assert import_previews(path, database, settings)["ready"] == 1
    with database() as session:
        asset = session.get(WorkPreview, "work-a").asset_id
        assert session.get(Work, "work-a").content_hash == "original-fingerprint"
    assert import_previews(path, database, settings)["skipped"] == 1
    path = manifest(tmp_path, usage_confirmed=False)
    assert import_previews(path, database, settings)["pending"] == 1
    with database() as session:
        assert session.get(WorkPreview, "work-a").asset_id == asset
    path = manifest(tmp_path, start_seconds=1)
    monkeypatch.setattr(importer, "encode", Mock(side_effect=MediaError("encode", "tool_failed")))
    report = import_previews(path, database, settings)
    assert report["failed"] == 1 and report["items"][0]["stage"] == "encode"
    with database() as session:
        assert session.get(WorkPreview, "work-a").asset_id == asset
    assert not list(tmp_path.glob(".preview-stage-*"))


def test_unconfirmed_media_stays_pending_and_bad_inputs_fail(database, record, tmp_path, baseline_settings, monkeypatch):
    settings = baseline_settings; settings.media_root = tmp_path / "media"
    seed(database, record); mock_processing(monkeypatch)
    path = manifest(tmp_path, work_confirmed=False)
    assert import_previews(path, database, settings)["pending"] == 1
    with database() as session:
        assert session.get(WorkPreview, "work-a").status == "pending"
    for changes in [{"source_file":"https://example.org/source.mp4"}, {"start_seconds":25}, {"work_id":"missing"}]:
        assert import_previews(manifest(tmp_path, **changes), database, settings)["failed"] == 1
    for changes in [{"duration_seconds":30}, {"source_page_url":"https://example.org/a?token=secret"}, {"usage_confirmed":"yes"}]:
        with pytest.raises(MediaError, match="invalid_manifest"):
            import_previews(manifest(tmp_path, **changes), database, settings)


def test_transaction_failure_retains_old_asset_and_journals_new_files(database, record, tmp_path, baseline_settings, monkeypatch):
    settings=baseline_settings; settings.media_root=tmp_path / "media"
    seed(database,record); mock_processing(monkeypatch)
    path=manifest(tmp_path); assert import_previews(path,database,settings)["ready"]==1
    with database() as session: old=session.get(WorkPreview,"work-a").asset_id
    from sqlalchemy.orm import Session
    monkeypatch.setattr(Session,"merge",Mock(side_effect=SQLAlchemyError("private SQL")))
    result=import_previews(manifest(tmp_path,start_seconds=1),database,settings)
    assert result["failed"]==1
    assert "private" not in json.dumps(result)
    assert (tmp_path / "preview-orphans.jsonl").is_file()
    with database() as session: assert session.get(WorkPreview,"work-a").asset_id==old


@pytest.mark.parametrize("exception,code", [(FileNotFoundError(),"tool_missing"),(subprocess.TimeoutExpired("probe",1),"tool_timeout")])
def test_tool_failures_are_sanitized(monkeypatch,exception,code):
    monkeypatch.setattr(subprocess,"run",Mock(side_effect=exception))
    with pytest.raises(MediaError) as error: run_tool(["tool","private-file"],1,"probe")
    assert error.value.code==code and "private-file" not in str(error.value)


def test_tool_nonzero_and_invalid_probe(monkeypatch,baseline_settings,tmp_path):
    monkeypatch.setattr(subprocess,"run",Mock(return_value=subprocess.CompletedProcess([],1,b"",b"secret path")))
    with pytest.raises(MediaError,match="tool_failed"):run_tool(["tool"],1,"encode")
    monkeypatch.setattr(subprocess,"run",Mock(return_value=subprocess.CompletedProcess([],0,b'{}',b"")))
    with pytest.raises(MediaError,match="invalid_media"):probe(tmp_path,baseline_settings)


@pytest.mark.parametrize("width,height,audio",[(640,360,False),(360,640,True)])
@pytest.mark.skipif(not (os.getenv("KIWI_TEST_FFMPEG") and os.getenv("KIWI_TEST_FFPROBE")), reason="Set explicit FFmpeg/ffprobe paths for real encoder checks")
def test_real_encode_and_output_validation(tmp_path,baseline_settings,width,height,audio):
    settings=baseline_settings;settings.ffmpeg_path=os.environ["KIWI_TEST_FFMPEG"];settings.ffprobe_path=os.environ["KIWI_TEST_FFPROBE"]
    source=tmp_path / "source.mp4"
    args=[settings.ffmpeg_path,"-nostdin","-v","error","-y","-f","lavfi","-i",f"testsrc2=size={width}x{height}:rate=24"]
    if audio:args += ["-f","lavfi","-i","sine=frequency=440:sample_rate=44100"]
    run_tool(args+["-t","16","-c:v","libx264","-pix_fmt","yuv420p",str(source)],30,"fixture")
    stage=tmp_path / "output";stage.mkdir()
    result=encode(PreviewInput.model_validate(json.loads(manifest(tmp_path).read_text())[0]),source,stage,settings)
    assert result["width"]==width and result["height"]==height and abs(result["duration_ms"]-15000)<=200
    data=(stage/"clip.mp4").read_bytes()
    assert data.index(b"moov")<data.index(b"mdat")
    assert bool(probe(stage/"clip.mp4",settings)["audio"])==audio


def test_database_rejects_incomplete_ready_record(database,record):
    seed(database,record)
    with pytest.raises(IntegrityError),database.begin() as session:
        session.add(WorkPreview(work_id="work-a",asset_id=ASSET,status="ready",clip_kind="trailer",video_path=f"{ASSET}/clip.mp4",source_page_url="https://example.org",usage_basis="test",created_at=utc_now(),updated_at=utc_now()))


def test_cli_check_only_never_creates_a_missing_database(tmp_path):
    missing=tmp_path / "absent" / "kiwi.db"
    result=subprocess.run([sys.executable,"-X","utf8","-m","kiwi","import-previews","--manifest",str(tmp_path / "manifest.json"),"--check-only"],
        env={**os.environ,"DATABASE_URL":f"sqlite:///{missing.as_posix()}"},capture_output=True,text=True,check=False)
    assert result.returncode==1 and json.loads(result.stdout)["error"]=="database_not_initialized"
    assert not missing.parent.exists()
