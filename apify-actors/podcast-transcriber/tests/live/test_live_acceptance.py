"""Live acceptance A-01 to A-14 (spec §10.2). Gavriel runs these on Dvir's machine; CI never does.

Skipped unless LIVE_TESTS=1. A-04 and A-14 also need LIVE_SPEND_OK=1 (set only after Dvir's yes). Keys come from the
environment (GROQ_API_KEY, ASSEMBLYAI_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY) and are never printed. Each test runs the
Actor locally with `apify run` and reads the local dataset. ENGINE_COST_PER_MINUTE (optional, the engine's list price per
audio minute, set by the operator) turns the billed minutes into a printed cost per audio hour; no price is kept in the repo.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = [pytest.mark.live, pytest.mark.skipif(os.environ.get("LIVE_TESTS") != "1", reason="live: set LIVE_TESTS=1")]
SPEND = pytest.mark.skipif(os.environ.get("LIVE_SPEND_OK") != "1", reason="spends more than a few cents: needs LIVE_SPEND_OK=1 after Dvir's yes")
MINUTES: list[int] = []

LIBRIVOX_MP3 = "https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3"
NASA_MP3 = "https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION5999466310.mp3"
LEX_MP3 = "https://media.blubrry.com/takeituneasy/ins.blubrry.com/takeituneasy/lex_ai_larry_lawton.mp3"
KAN_MP3 = ("https://traffic.omny.fm/d/clips/23f697a0-7e6a-4e96-a223-a82c00962b12/c40b8ac9-3853-41fc-a2bf-b02700be578d/"
           "4ac2bbc6-b8be-4a36-97a1-b4fe00d114ba/audio.mp3")


def actor(inp: dict, max_charge: str | None = None) -> tuple[list[dict], float, subprocess.CompletedProcess]:
    """Run the Actor locally; returns (dataset rows, seconds, process). The output is scrubbed of key values before use."""
    if not shutil.which("apify"):
        pytest.skip("apify CLI not installed")
    storage = ROOT / "storage"
    shutil.rmtree(storage, ignore_errors=True)
    kv = storage / "key_value_stores" / "default"
    kv.mkdir(parents=True)
    (kv / "INPUT.json").write_text(json.dumps({"confirmRights": True, **inp}))
    env = dict(os.environ, APIFY_USER_IS_PAYING="1")
    if max_charge:
        env["ACTOR_MAX_TOTAL_CHARGE_USD"] = max_charge
    t0 = time.monotonic()
    p = subprocess.run(["apify", "run"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=4 * 3600)
    took = time.monotonic() - t0
    for k in ("GROQ_API_KEY", "ASSEMBLYAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"):
        v = os.environ.get(k)
        assert not v or (v not in p.stdout and v not in p.stderr), f"{k} appeared in the run output"
    rows = [json.loads(f.read_text()) for f in sorted((storage / "datasets" / "default").glob("*.json"))]
    MINUTES.extend(r.get("billedMinutes") or 0 for r in rows)
    return rows, took, p


def words_per_minute(r):
    return r["wordCount"] / (r["durationSeconds"] / 60)


def no_regression(r):
    s = [x["start"] for x in r["segments"]]
    return s == sorted(s)


def test_a01_short_english_direct_url():
    rows, took, _ = actor({"sources": [LIBRIVOX_MP3]})
    r = rows[0]
    assert r["status"] == "ok" and abs(r["durationSeconds"] - 167) <= 2
    assert "Marcus Aurelius" in r["text"] and "George Long" in r["text"] and 380 <= r["wordCount"] <= 460
    assert 0 <= r["segments"][0]["start"] <= 3 and 150 <= r["segments"][-1]["end"] <= 168
    assert r["billedMinutes"] == 3 and took < 90


def test_a02_rss_with_ugly_data():
    rows, _t, _ = actor({"sources": ["https://librivox.org/rss/1095"], "maxEpisodesPerFeed": 2})
    assert [r["status"] for r in rows] == ["ok", "ok"] and all(r["publishedAt"] is None for r in rows)
    assert abs(rows[0]["durationSeconds"] - 167) <= 3 and abs(rows[1]["durationSeconds"] - 985) <= 5


def test_a03_one_hour_redirects_and_addons():
    rows, took, _ = actor({"sources": [NASA_MP3], "addOns": ["summary", "chapters", "keyQuotes"]})
    r = rows[0]
    assert r["status"] == "ok" and r["billedMinutes"] == 60 and 3520 <= r["segments"][-1]["end"] <= 3580
    assert 100 <= words_per_minute(r) <= 200 and no_regression(r) and r["summary"]
    assert 5 <= len(r["chapters"]) <= 15 and [c["start"] for c in r["chapters"]] == sorted(c["start"] for c in r["chapters"])
    assert all(" ".join(q["text"].split()) in " ".join(r["text"].split()) for q in r["keyQuotes"])
    assert took < 8 * 60


@SPEND
def test_a04_long_episode_chunking():
    rows, _t, _ = actor({"sources": [LEX_MP3], "maxAudioMinutesPerEpisode": 240, "episodeTimeoutMinutes": 180})
    r = rows[0]
    assert r["status"] == "ok" and 12300 <= r["segments"][-1]["end"] <= 12420 and no_regression(r) and r["billedMinutes"] == 207
    texts = [s["text"] for s in r["segments"]]
    assert not any(len(set(texts[i:i + 5])) == 1 for i in range(len(texts) - 4))
    assert 100 <= words_per_minute(r) <= 200


def test_a05_hebrew_with_wrong_feed_tag():
    rows, _t, _ = actor({"sources": [KAN_MP3]})
    r = rows[0]
    letters = [c for c in r["text"] if c.isalpha()]
    assert r["language"] == "he" and sum("֐" <= c <= "׿" for c in letters) / len(letters) >= 0.85
    assert no_regression(r) and r["billedMinutes"] == 32


def test_a06_publisher_transcript_path():
    rows, _t, p = actor({"sources": ["https://podnews.net/rss"], "maxEpisodesPerFeed": 1})
    r = rows[0]
    assert r["transcriptSource"] == "publisher" and r["billedMinutes"] == 0 and r["segments"]


def test_a07_accuracy_against_publisher_vtt():
    pub, _t, _ = actor({"sources": ["https://podnews.net/rss"], "maxEpisodesPerFeed": 1})
    stt, _t, _ = actor({"sources": ["https://podnews.net/rss"], "maxEpisodesPerFeed": 1, "preferPublisherTranscript": False})
    ref, hyp = norm(pub[0]["text"]), norm(stt[0]["text"])
    wer = edit_distance(ref, hyp) / max(1, len(ref))
    print(f"A-07 word error rate: {wer:.1%} (target 12% or lower; reported, not failed)")


def norm(t):
    return re.sub(r"[^\w\s']", " ", t.lower()).split()


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def test_a08_broken_feeds():
    rows, _t, _ = actor({"sources": ["https://www.iana.org/this-feed-does-not-exist.xml", "https://example.com/",
                                     "https://librivox.org/rss/1095"], "maxEpisodesPerFeed": 1})
    codes = [r["errorCode"] for r in rows]
    assert "feed_http_404" in codes and "not_a_feed" in codes and any(r["status"] == "ok" for r in rows)
    rows, _t, p = actor({"sources": ["https://www.iana.org/this-feed-does-not-exist.xml", "https://example.com/"]})
    assert p.returncode != 0 or "No episode could be processed" in p.stdout + p.stderr


def test_a09_timeouts():
    rows, took, _ = actor({"sources": ["https://httpbin.org/delay/10", LIBRIVOX_MP3], "downloadStallSeconds": 5})
    assert rows[0]["errorCode"] == "download_stall_timeout" and rows[0]["billedMinutes"] == 0


def test_a10_refusals():
    rows, _t, _ = actor({"sources": ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL",
                                     "http://169.254.169.254/latest/meta-data/", "https://httpbin.org/status/403", LIBRIVOX_MP3]})
    codes = [r["errorCode"] for r in rows]
    assert codes[:4] == ["unsupported_platform", "unsupported_platform", "ssrf_blocked", "audio_access_denied"]


def test_a11_apple_link():
    rows, _t, _ = actor({"sources": ["https://podcasts.apple.com/us/podcast/houston-we-have-a-podcast/id1262594123"],
                         "maxEpisodesPerFeed": 1, "maxAudioMinutesPerEpisode": 1})
    assert rows[0]["status"] == "skipped" and rows[0]["errorCode"] == "episode_too_long"


def test_a12_huge_feed_zero_spend():
    rows, took, _ = actor({"sources": ["https://feeds.simplecast.com/54nAGcIl"], "maxEpisodesPerFeed": 3, "maxAudioMinutesPerEpisode": 1})
    assert len(rows) == 3 and took < 60 and all(r["billedMinutes"] == 0 for r in rows)


def test_a13_spending_limit():
    rows, _t, _ = actor({"sources": [NASA_MP3]}, max_charge="0.10")
    assert rows[0]["status"] == "skipped" and rows[0]["errorCode"] == "budget_too_low"


@SPEND
def test_a14_cost_truth():
    total = sum(MINUTES)
    per_min = os.environ.get("ENGINE_COST_PER_MINUTE")
    print(f"A-14: billed audio minutes in this session: {total}")
    if per_min and total:
        print(f"A-14: engine cost per audio hour at the given list price: {float(per_min) * 60:.3f} (compare with the provider bill)")
