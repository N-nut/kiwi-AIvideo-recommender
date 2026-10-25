"""Serial offline media preparation. No remote input or web write endpoints."""
import hashlib
import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, StrictBool, field_validator

from .database import Work, WorkPreview, utc_now
from .previews import DRAMA_TYPES, ready_file
from .schemas import StrictModel

log = logging.getLogger("kiwi.media")
PROFILE = {"version": 1, "codec": "libx264", "audio": "aac", "crf": 23, "pixel_format": "yuv420p", "long_edge": 1280, "short_edge": 720}


class MediaError(Exception):
    def __init__(self, stage, code):
        self.stage, self.code = stage, code
        super().__init__(code)


class PreviewInput(StrictModel):
    work_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    source_file: str = Field(min_length=1, max_length=2000)
    source_page_url: str = Field(min_length=1, max_length=2000)
    usage_basis: str = Field(min_length=1, max_length=2000)
    clip_kind: str = Field(pattern=r"^(trailer|excerpt)$")
    start_seconds: float = Field(default=0, ge=0, allow_inf_nan=False)
    duration_seconds: float = Field(default=15, ge=10, le=20, allow_inf_nan=False)
    work_confirmed: StrictBool = False
    usage_confirmed: StrictBool = False

    @field_validator("source_page_url")
    @classmethod
    def public_page(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("需要不含凭据的 HTTPS 来源页")
        # Stable work IDs are allowed; media tokens are not public source pages.
        from urllib.parse import parse_qs
        if any(key.lower() not in {"series_id", "id", "episode"} for key in parse_qs(parsed.query)):
            raise ValueError("来源页不能包含临时媒体令牌")
        return value

    @field_validator("usage_basis")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("需要记录使用依据")
        return value.strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run_tool(args, timeout, stage):
    try:
        result = subprocess.run([str(arg) for arg in args], shell=False, stdin=subprocess.DEVNULL,
            capture_output=True, timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except FileNotFoundError:
        raise MediaError(stage, "tool_missing") from None
    except subprocess.TimeoutExpired:
        raise MediaError(stage, "tool_timeout") from None
    except OSError:
        raise MediaError(stage, "tool_unavailable") from None
    if result.returncode:
        raise MediaError(stage, "tool_failed")
    return result.stdout


def probe(path, settings):
    raw = run_tool([settings.ffprobe_path, "-v", "error", "-protocol_whitelist", "file", "-show_format", "-show_streams", "-of", "json", path], settings.preview_probe_timeout, "probe")
    try:
        data = json.loads(raw)
        streams = data["streams"]
        video = next(s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic"))
        duration = float(data["format"]["duration"])
        if not math.isfinite(duration) or duration <= 0 or int(video["width"]) < 2 or int(video["height"]) < 2:
            raise ValueError()
        return {"duration": duration, "video": video, "audio": [s for s in streams if s.get("codec_type") == "audio"], "format": data["format"]}
    except (ValueError, KeyError, TypeError, StopIteration):
        raise MediaError("probe", "invalid_media") from None


def validate_source(item, parent, settings):
    value = item.source_file
    if "://" in value or value.startswith(("\\\\", "//")):
        raise MediaError("source", "local_file_required")
    path = Path(value)
    path = path if path.is_absolute() else parent / path
    if path.is_symlink() or not path.is_file() or path.suffix.lower() not in {".mp4", ".mov", ".mkv", ".webm", ".avi"}:
        raise MediaError("source", "invalid_local_file")
    path = path.resolve()
    if not 0 < path.stat().st_size <= settings.preview_source_max_bytes:
        raise MediaError("source", "source_size_limit")
    info = probe(path, settings)
    if item.start_seconds + item.duration_seconds > info["duration"] + 0.05:
        raise MediaError("source", "clip_out_of_bounds")
    return path, info


def encode(item, source, stage, settings):
    started = time.monotonic()
    # fit both orientations without stretching or upscaling, output even pixels.
    factor = "min(1,min(1280/max(iw,ih),720/min(iw,ih)))"
    scale = f"scale=w='trunc(iw*{factor}/2)*2':h='trunc(ih*{factor}/2)*2',setsar=1"
    video, poster = stage / "clip.mp4", stage / "poster.jpg"
    run_tool([settings.ffmpeg_path, "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-ss", item.start_seconds,
        "-i", source, "-t", item.duration_seconds, "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1",
        "-vf", scale, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-fs", settings.preview_output_max_bytes + 1, video], settings.preview_process_timeout, "encode")
    remaining = settings.preview_process_timeout - (time.monotonic() - started)
    if remaining <= 0:
        raise MediaError("poster", "tool_timeout")
    run_tool([settings.ffmpeg_path, "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-i", video,
              "-frames:v", "1", "-q:v", "3", poster], remaining, "poster")
    measured = probe(video, settings)
    track = measured["video"]
    width, height = int(track["width"]), int(track["height"])
    if (track.get("codec_name") != "h264" or track.get("pix_fmt") != "yuv420p" or max(width, height) > 1280 or min(width, height) > 720
            or abs(measured["duration"] - item.duration_seconds) > 0.2 or video.stat().st_size > settings.preview_output_max_bytes
            or not poster.is_file() or poster.stat().st_size == 0 or any(a.get("codec_name") != "aac" for a in measured["audio"])):
        raise MediaError("validate_output", "invalid_output")
    return {"duration_ms": round(measured["duration"] * 1000), "width": width, "height": height,
            "size_bytes": video.stat().st_size, "video_sha256": digest(video)}


def import_previews(manifest, sessions, settings, check_only=False):
    manifest = Path(manifest).resolve()
    try:
        raw = json.loads(manifest.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, list) or not 1 <= len(raw) <= 100:
            raise ValueError()
        items = [PreviewInput.model_validate(row) for row in raw]
        if len({i.work_id for i in items}) != len(items):
            raise ValueError()
    except (OSError, ValueError):
        raise MediaError("manifest", "invalid_manifest") from None
    report = {"check_only": check_only, "ready": 0, "pending": 0, "skipped": 0, "failed": 0, "items": []}
    root = settings.media_root.resolve()
    lock = root.parent / f".{root.name}.import.lock"
    acquired = False
    if not check_only:
        root.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            acquired = True
        except FileExistsError:
            raise MediaError("publish", "import_busy") from None
    try:
        for item in items:
            started = time.monotonic()
            stage_path = published = None
            try:
                with sessions() as session:
                    work = session.get(Work, item.work_id)
                    if not work or work.review_status != "approved" or (work.source_meta or {}).get("content_type") not in DRAMA_TYPES:
                        raise MediaError("work", "invalid_work")
                source, info = validate_source(item, manifest.parent, settings)
                source_hash = digest(source)
                processing_hash = hashlib.sha256(json.dumps({"profile": PROFILE, "start": item.start_seconds, "duration": item.duration_seconds}, sort_keys=True).encode()).hexdigest()
                confirmed = item.work_confirmed and item.usage_confirmed
                state = "ready" if confirmed else "pending"
                if check_only:
                    report[state] += 1
                    report["items"].append({"work_id": item.work_id, "status": state, "source_duration_ms": round(info["duration"] * 1000)})
                    continue
                with sessions() as session:
                    old = session.get(WorkPreview, item.work_id)
                    if not confirmed:
                        # An unconfirmed replacement never disables an existing clip.
                        if not old or old.status != "ready":
                            now = utc_now()
                            session.merge(WorkPreview(work_id=item.work_id, status="pending", clip_kind=item.clip_kind, source_page_url=item.source_page_url,
                                usage_basis=item.usage_basis, created_at=old.created_at if old else now, updated_at=now))
                            session.commit()
                        report["pending"] += 1
                        report["items"].append({"work_id": item.work_id, "status": "pending"})
                        continue
                    if (old and ready_file(old, settings) and old.source_hash == source_hash and old.processing_hash == processing_hash
                            and old.clip_kind == item.clip_kind and old.source_page_url == item.source_page_url and old.usage_basis == item.usage_basis
                            and digest(ready_file(old, settings)) == old.video_sha256):
                        report["skipped"] += 1
                        report["items"].append({"work_id": item.work_id, "status": "skipped"})
                        continue
                for tool in (settings.ffmpeg_path, settings.ffprobe_path):
                    version = run_tool([tool, "-version"], settings.preview_probe_timeout, "version").decode(errors="replace").splitlines()[0]
                    log.info(json.dumps({"stage": "version", "version": version}))
                stage_path = Path(tempfile.mkdtemp(prefix=".preview-stage-", dir=root.parent))
                measured = encode(item, source, stage_path, settings)
                if digest(source) != source_hash:
                    raise MediaError("source", "source_changed")
                asset = uuid.uuid4().hex
                published = root / asset
                stage_path.rename(published)
                stage_path = None
                with sessions.begin() as session:
                    # Recheck work eligibility inside the short publishing transaction.
                    work = session.get(Work, item.work_id)
                    if not work or work.review_status != "approved" or (work.source_meta or {}).get("content_type") not in DRAMA_TYPES:
                        raise MediaError("publish", "invalid_work")
                    old = session.get(WorkPreview, item.work_id)
                    now = utc_now()
                    session.merge(WorkPreview(work_id=item.work_id, asset_id=asset, status="ready", clip_kind=item.clip_kind,
                        video_path=f"{asset}/clip.mp4", poster_path=f"{asset}/poster.jpg", source_page_url=item.source_page_url,
                        usage_basis=item.usage_basis, source_hash=source_hash, processing_hash=processing_hash, checked_at=now,
                        created_at=old.created_at if old else now, updated_at=now, **measured))
                published = None
                report["ready"] += 1
                result = {"work_id": item.work_id, "status": "ready", **{k:v for k,v in measured.items() if k != "video_sha256"}, "elapsed_ms": round((time.monotonic()-started)*1000)}
                report["items"].append(result)
                log.info(json.dumps(result))
            except Exception as exc:
                report["failed"] += 1
                report["items"].append({"work_id": item.work_id, "status": "failed", "stage": getattr(exc, "stage", "publish"), "error": getattr(exc, "code", type(exc).__name__)})
                if published:
                    # Nonpublic journal; retained files are never exposed without a current row.
                    with (root.parent / "preview-orphans.jsonl").open("a", encoding="utf-8") as stream:
                        stream.write(json.dumps({"asset_id": published.name, "work_id": item.work_id, "status": "pending_cleanup"}) + "\n")
            finally:
                if stage_path:
                    shutil.rmtree(stage_path)
    finally:
        if acquired:
            lock.unlink()
    return report
