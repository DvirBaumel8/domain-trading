"""Stream an enclosure to disk with a stall timeout and a size cap (spec §4.4.1)."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from . import config
from .net import Net, SourceError

SNIFF = (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xf1", b"\xff\xf9", b"RIFF", b"OggS", b"fLaC", b"\x1aE\xdf\xa3", b"#EXTM3U")


def looks_like_media(head: bytes) -> bool:
    return head.startswith(SNIFF) or head[4:8] == b"ftyp"


async def download(net: Net, url: str, dest: Path, *, stall_seconds: float, max_mb: int = config.MAX_DOWNLOAD_MB) -> Path:
    """Writes the body to `dest`. On any failure the partial file is removed before the error is raised."""
    cap = max_mb * 1024 * 1024
    try:
        async with net.download_slot(url):
            ctx = net.stream(url, timeout=stall_seconds, retries=3, auth_retries=1)
            try:
                r = await asyncio.wait_for(ctx.__aenter__(), timeout=stall_seconds * 4 + 5)
            except asyncio.TimeoutError:
                raise SourceError("download_stall_timeout", "The audio host did not answer in time.") from None
            try:
                code = r.status_code
                if code in (401, 403):
                    raise SourceError("audio_access_denied", f"The audio host refused access (HTTP {code}). Private or paid feeds are not supported.")
                if code in (404, 410):
                    raise SourceError("audio_not_found", f"The audio file was not found (HTTP {code}).")
                if code >= 400:
                    raise SourceError("audio_unavailable", f"The audio host answered HTTP {code}.")
                ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
                if ctype in ("text/html", "application/xhtml+xml"):
                    raise SourceError("not_audio", "The link returns a web page, not an audio file.")
                length = r.headers.get("content-length")
                if length and length.isdigit() and int(length) > cap:
                    raise SourceError("file_too_large", f"The file is larger than {max_mb} MB.")
                total = 0
                it = r.aiter_bytes().__aiter__()
                with open(dest, "wb") as fh:
                    while True:
                        try:
                            chunk = await asyncio.wait_for(it.__anext__(), timeout=stall_seconds)
                        except StopAsyncIteration:
                            break
                        except asyncio.TimeoutError:
                            raise SourceError("download_stall_timeout", f"No data for {int(stall_seconds)} s.") from None
                        except Exception as e:  # httpx read timeout surfaces here
                            if "Timeout" in type(e).__name__:
                                raise SourceError("download_stall_timeout", f"No data for {int(stall_seconds)} s.") from None
                            raise SourceError("audio_unavailable", f"The download broke off ({type(e).__name__}).") from None
                        total += len(chunk)
                        if total > cap:
                            raise SourceError("file_too_large", f"The file is larger than {max_mb} MB.")
                        fh.write(chunk)
                if total == 0:
                    raise SourceError("not_audio", "The audio file is empty.")
            finally:
                await ctx.__aexit__(None, None, None)
    except SourceError as e:
        _rm(dest)
        if e.code == "timeout":
            raise SourceError("download_stall_timeout", "The audio host did not answer in time.") from None
        if e.code in ("connection_failed", "too_many_redirects", "host_not_found"):
            raise SourceError("audio_unavailable", e.message) from None
        raise
    except BaseException:
        _rm(dest)
        raise
    return dest


def _rm(p: Path) -> None:
    try:
        os.remove(p)
    except FileNotFoundError:
        pass
