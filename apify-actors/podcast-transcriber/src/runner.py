"""The run: input -> sources -> episodes -> rows. Everything outside (HTTP, Apify, ffmpeg, engines, clock) is injected."""
from __future__ import annotations

import asyncio
import math
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import billing as bill
from . import config, feeds, formats, inputs, media
from .addons import Summariser, delivered
from .download import download, looks_like_media
from .engines import chain
from .feeds import Episode
from .net import Net, SourceError
from .transcribe import Transcriber

SKIP_CODES = {"episode_too_long", "run_minute_cap", "free_plan_cap", "budget_too_low"}


@dataclass
class Deps:
    net: Net
    push: object                      # async (row) -> None
    set_value: object                 # async (key, value, content_type) -> None
    set_status: object                # async (msg) -> None
    billing: bill.Billing
    log: object = print
    paying: bool = True
    kv_store_id: str = ""
    media: object = media
    engines: object = None            # (speakers: bool) -> list[Engine]
    summariser: object = None
    clock: object = time.monotonic
    sleep: object = asyncio.sleep
    workdir: Path | None = None
    stats: dict = field(default_factory=dict)


def base_row(source: str, ep: Episode | None = None) -> dict:
    return {
        "source": source, "feedUrl": ep.feed_url if ep else None, "feedTitle": ep.feed_title if ep else None,
        "episodeTitle": ep.title if ep else None, "episodeGuid": ep.guid if ep else None, "episodeUrl": ep.url if ep else None,
        "publishedAt": ep.published.isoformat() if ep and ep.published else None, "audioUrl": ep.audio_url if ep else None,
        "durationSeconds": None, "language": None, "transcriptSource": None, "engine": None, "text": "", "segments": [],
        "summary": None, "chapters": [], "keyQuotes": [], "wordCount": 0, "files": {}, "billedMinutes": 0,
        "license": ep.license if ep else None, "status": "error", "errorCode": None, "errorMessage": None,
    }


def fail_row(row: dict, err: SourceError) -> dict:
    row.update(status="skipped" if err.code in SKIP_CODES else "error", errorCode=err.code, errorMessage=err.message,
               text="", segments=[], billedMinutes=0)
    return row


class Run:
    def __init__(self, opts: inputs.Options, deps: Deps):
        self.o, self.d = opts, deps
        self.lock = asyncio.Lock()
        self.used_minutes = 0
        self.free_minutes = 0
        self.n = 0
        self.rows: list[dict] = []
        self.apple = feeds.AppleResolver(deps.net)
        self.free_capped = False

    # ---------- sources ----------
    async def resolve(self, url: str) -> list[Episode]:
        net = self.d.net
        if feeds.APPLE.match(url):
            feed_url, hint = await self.apple.resolve(url)
            feed = await feeds.fetch_feed(net, feed_url)
            eps = feeds.match_hint(feed.episodes, hint) if hint else feeds.pick(feed.episodes, self.o.max_episodes, self.o.published_after)
            for e in eps:
                e.source = url
            if not eps:
                raise SourceError("no_episodes", "The feed has no episode with an audio file that matches.")
            return eps
        if feeds.is_media_url(url):
            await net.check(url)
            return [Episode(source=url, audio_url=url)]
        async with net.stream(url) as r:
            if r.status_code >= 400:
                raise SourceError(f"feed_http_{r.status_code}", f"The URL answered HTTP {r.status_code}.")
            ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
            if ctype.startswith(("audio/", "video/")):
                return [Episode(source=url, audio_url=getattr(r, "final_url", url))]
            it = r.aiter_bytes().__aiter__()
            first = b""
            try:
                while not first.strip():
                    first += await it.__anext__()
            except StopAsyncIteration:
                pass
            if ctype in ("application/octet-stream", "binary/octet-stream") or looks_like_media(first[:16]):
                if not first.lstrip().startswith(b"<"):
                    return [Episode(source=url, audio_url=getattr(r, "final_url", url))]
            feed = await feeds.fetch_feed(net, url, first=first, response=_Rest(r, it))
        eps = feeds.pick(feed.episodes, self.o.max_episodes, self.o.published_after)
        if not eps:
            raise SourceError("no_episodes", "The feed has no episode with an audio file.")
        return eps

    # ---------- episodes ----------
    async def publisher(self, ep: Episode, row: dict) -> bool:
        t = feeds.best_transcript(ep)
        if not (self.o.prefer_publisher and t):
            return False
        try:
            _r, body = await self.d.net.get_bytes(t["url"], config.TRANSCRIPT_CAP_BYTES)
        except SourceError as e:
            self.d.log(f"publisher transcript not used ({e.code})")
            return False
        segs = formats.parse_publisher(body, t["type"])
        if _r.status_code >= 400 or not formats.valid_publisher(segs):
            self.d.log("publisher transcript not usable; transcribing the audio")
            return False
        kind = {"text/vtt": "vtt", "application/json": "json", "text/plain": "text"}.get(t["type"], "srt")
        row.update(transcriptSource="publisher", engine=f"publisher-{kind}", segments=segs, text=formats.full_text(segs),
                   language=(t.get("language") or None), status="ok")
        if segs and segs[-1]["end"]:
            row["durationSeconds"] = int(round(segs[-1]["end"]))
        return True

    async def reserve(self, minutes: int, speakers: bool) -> None:
        async with self.lock:
            if minutes > self.o.max_episode_minutes:
                raise SourceError("episode_too_long", f"The episode is {minutes} minutes; the limit is {self.o.max_episode_minutes}.")
            if self.used_minutes + minutes > self.o.max_total_minutes:
                raise SourceError("run_minute_cap", f"This episode would pass maxTotalAudioMinutes ({self.o.max_total_minutes}).")
            if not self.d.paying and self.free_minutes + minutes > config.FREE_PLAN_MINUTES:
                self.free_capped = True
                raise SourceError("free_plan_cap", config.FREE_PLAN_MESSAGE)
            needs = {bill.AUDIO_MINUTE: minutes, bill.SPEAKER_MINUTE: minutes if speakers else 0}
            if not self.d.billing.reserve(needs):
                raise SourceError("budget_too_low", "Your run's maximum charge is too low for this episode. Raise it and run again.")
            self.used_minutes += minutes
            if not self.d.paying:
                self.free_minutes += minutes

    async def unreserve(self, minutes: int, speakers: bool) -> None:
        async with self.lock:
            self.used_minutes -= minutes
            if not self.d.paying:
                self.free_minutes -= minutes
            self.d.billing.release({bill.AUDIO_MINUTE: minutes, bill.SPEAKER_MINUTE: minutes if speakers else 0})

    async def audio(self, ep: Episode, row: dict, n: int, deadline: float) -> tuple[int, bool]:
        """Download, measure, reserve, transcribe. Returns (billed minutes, speakers delivered)."""
        o, d, m = self.o, self.d, self.d.media
        engines = d.engines(o.speakers)
        if not engines:
            if o.speakers:
                raise SourceError("speakers_unavailable", "Speaker labels need an engine that is not configured. Run without speakerLabels.")
            raise SourceError("stt_failed", "No speech-to-text engine is configured.")
        work = Path(tempfile.mkdtemp(prefix=f"ep{n}-", dir=d.workdir))
        minutes, reserved = 0, False
        try:
            src = await download(d.net, ep.audio_url, work / "original", stall_seconds=o.stall_seconds)
            duration = await m.probe(src)
            row["durationSeconds"] = int(round(duration))
            minutes = max(1, math.ceil(duration / 60))
            await self.reserve(minutes, o.speakers)
            reserved = True
            self.check(deadline)
            small = await m.reencode(src, work / "audio.mp3")
            src.unlink(missing_ok=True)
            sil = await m.silences(small)
            chunks = m.plan(duration, sil)
            tr = Transcriber(engines, sleep=d.sleep, cutter=m.cut, log=d.log)
            merged = await tr.run(small, chunks, sil, language=None if o.language == "auto" else o.language,
                                  speakers=o.speakers, words=o.words, workdir=work, duration=duration)
            self.check(deadline)
            got_speakers = o.speakers and any(s.get("speaker") for s in merged.segments)
            row.update(transcriptSource="stt", engine=merged.engine, segments=merged.segments, text=formats.full_text(merged.segments),
                       language=merged.language or (None if o.language == "auto" else o.language), billedMinutes=minutes, status="ok")
            row["_words"] = merged.words
            return minutes, got_speakers
        except BaseException:
            if reserved:
                await self.unreserve(minutes, o.speakers)
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def check(self, deadline: float) -> None:
        if self.d.clock() > deadline:
            raise SourceError("episode_timeout", f"The episode took longer than {self.o.episode_timeout_minutes} minutes.")

    async def save_files(self, row: dict, n: int) -> None:
        words = row.pop("_words", None)
        for fmt in self.o.formats:
            key = f"transcript-{n}.{fmt}"
            body = {"txt": formats.to_txt, "srt": formats.to_srt, "vtt": formats.to_vtt}[fmt](row["segments"]) if fmt != "json" \
                else formats.to_json(row, words if self.o.words else None)
            await self.d.set_value(key, body, formats.CONTENT_TYPES[fmt])
            sid = self.d.kv_store_id
            row["files"][fmt] = f"https://api.apify.com/v2/key-value-stores/{sid}/records/{key}" if sid else key

    async def episode(self, ep: Episode, n: int) -> dict:
        row = base_row(ep.source, ep)
        o, d = self.o, self.d
        ep_id = f"{ep.guid or ''}|{ep.audio_url or ''}|{ep.source}"
        timeout = o.episode_timeout_minutes * 60
        deadline = d.clock() + timeout
        minutes, speakers = 0, False
        try:
            async def work():
                if await self.publisher(ep, row):
                    return 0, False
                if not ep.audio_url:
                    raise SourceError("no_episodes", "The episode has no audio file.")
                return await self.audio(ep, row, n, deadline)
            minutes, speakers = await asyncio.wait_for(work(), timeout=timeout)
        except asyncio.TimeoutError:
            fail_row(row, SourceError("episode_timeout", f"The episode took longer than {o.episode_timeout_minutes} minutes."))
        except SourceError as e:
            fail_row(row, e)
        except Exception as e:  # noqa: BLE001 - never leak details (URLs, keys) from an unexpected error
            d.log(f"episode {n}: unexpected {type(e).__name__}")
            fail_row(row, SourceError("internal_error", f"Unexpected error ({type(e).__name__})."))
        if row["status"] != "ok":
            row.pop("_words", None)
        else:
            want = [a for a in ("summary", "chapters", "keyQuotes") if a in o.addons]
            extra = {"summary": None, "chapters": [], "keyQuotes": []}
            if want and d.summariser is not None:
                try:
                    extra = await d.summariser.run(row["segments"], row["durationSeconds"] or 0, want)
                except Exception as e:  # noqa: BLE001
                    d.log(f"add-ons failed ({type(e).__name__}); transcript kept")
            row.update(extra)
            row["wordCount"] = len(row["text"].split())
            await self.save_files(row, n)
        await d.push(row)
        if row["status"] == "ok":
            b = d.billing
            try:
                if row["transcriptSource"] == "publisher":
                    await b.charge(ep_id, bill.PUBLISHER_TRANSCRIPT, 1)
                else:
                    if await b.charge(ep_id, bill.AUDIO_MINUTE, minutes) and speakers:
                        await b.charge(ep_id, bill.SPEAKER_MINUTE, minutes)
                    if delivered(row) and not b.stopped:
                        await b.charge(ep_id, bill.SUMMARY, 1)
            finally:
                if row["transcriptSource"] == "stt":
                    b.release({bill.AUDIO_MINUTE: minutes, bill.SPEAKER_MINUTE: minutes if self.o.speakers else 0})
        return row

    async def go(self) -> tuple[bool, str]:
        d = self.d
        if self.o.invalid:
            await d.set_value("INVALID_INPUTS", self.o.invalid, "application/json")
        jobs: list[tuple[Episode, int]] = []
        for url in self.o.sources:
            try:
                eps = await self.resolve(url)
            except SourceError as e:
                row = fail_row(base_row(url), e)
                self.rows.append(row)
                await d.push(row)
                continue
            for ep in eps:
                self.n += 1
                jobs.append((ep, self.n))
        sem = asyncio.Semaphore(config.EPISODE_CONCURRENCY)

        async def one(ep, n):
            async with sem:
                return await self.episode(ep, n)
        self.rows += await asyncio.gather(*(one(ep, n) for ep, n in jobs))
        ok = sum(r["status"] == "ok" for r in self.rows)
        if not self.rows or all(r["status"] == "error" for r in self.rows):
            return False, config.ALL_FAILED_MESSAGE
        msg = f"{ok} of {len(self.rows)} episodes transcribed."
        if self.free_capped:
            msg += " " + config.FREE_PLAN_MESSAGE
        if d.billing.stopped:
            msg += " Stopped: your maximum charge for this run was reached."
        return True, msg


class _Rest:
    """The rest of an already-opened streaming response, after the first chunk was read."""

    def __init__(self, r, it):
        self.status_code, self.headers, self.final_url, self._it = r.status_code, r.headers, getattr(r, "final_url", None), it

    async def aiter_bytes(self):
        async for c in self._it:
            yield c


async def run(raw: dict, deps: Deps) -> tuple[bool, str]:
    """(ok, status message). An input error returns before any request is made."""
    try:
        opts = inputs.parse(raw or {})
    except inputs.InputError as e:
        return False, e.message
    if not opts.sources:
        if opts.invalid:
            await deps.set_value("INVALID_INPUTS", opts.invalid, "application/json")
        return False, "No valid source: each line must be an http or https URL. See INVALID_INPUTS."
    if deps.engines is None:
        deps.engines = lambda speakers: chain(deps.net.client, speakers, sleep=deps.sleep, log=deps.log)
    if deps.summariser is None and opts.addons:
        deps.summariser = Summariser(deps.net.client, log=deps.log)
    return await Run(opts, deps).go()

