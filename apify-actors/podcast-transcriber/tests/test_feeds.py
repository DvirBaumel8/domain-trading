"""U-06 to U-10: real feeds, feed failures, Apple links, episode selection, publisher transcripts."""
import tracemalloc
from datetime import date, datetime, timezone

import httpx
import pytest

from helpers import FIX, Clock, FakeEngine, FakeMedia, Web, audio, deps, net, run, xml
from src import feeds, formats
from src.feeds import Episode
from src.net import SourceError
from src.runner import run as run_actor

LIBRIVOX = "https://librivox.org/rss/1095"


def parse(name, base="https://feeds.example.org/feed.xml"):
    web = Web()
    web.add(base, xml(name))
    return run(feeds.fetch_feed(net(web), base))


def test_u06_librivox_dates_null_order_kept():
    f = parse("feed-librivox-meditations.xml", LIBRIVOX)
    assert len(f.episodes) == 3
    assert all(e.published is None for e in f.episodes)
    assert [e.audio_url.rsplit("_", 2)[-2] for e in f.episodes] == ["00", "01", "02"] or \
        [e.audio_url for e in f.episodes] == sorted(e.audio_url for e in f.episodes)
    assert feeds.pick(f.episodes, 3, None) == f.episodes  # feed order kept when dates are missing


def test_u06_nasa_three_items_redirect_host():
    f = parse("feed-nasa-megaphone-length0.xml")
    assert len(f.episodes) == 3
    assert all(e.audio_url.startswith("https://traffic.megaphone.fm/") for e in f.episodes)
    assert all(e.published for e in f.episodes)


def test_u06_kan_hebrew_titles_and_language_tag_not_used():
    f = parse("feed-kan-hebrew-lang-tag-en.xml")
    assert f.episodes and f.episodes[0].title == "רציתי לצעוק תנו לי להיות"
    assert f.language_tag == "en-US"
    assert "Ã" not in (f.title or "") and "כאן דוקו" in f.title


def test_u06_kan_language_tag_never_reaches_the_row(tmp_path):
    web = Web()
    web.add("https://feeds.example.org/kan.rss", xml("feed-kan-hebrew-lang-tag-en.xml"))
    web.add("https://traffic.omny.fm/d/clips/23f697a0-7e6a-4e96-a223-a82c00962b12/c40b8ac9-3853-41fc-a2bf-b02700be578d/4ac2bbc6-b8be-4a36-97a1-b4fe00d114ba/audio.mp3", audio())
    from src.engines import Result
    eng = FakeEngine(behave=lambda c: Result([{"start": 0.0, "end": 100.0, "text": "שלום עולם", "speaker": None}], None, None, "m"))
    d, out = deps(web, engines=[eng], fake_media=FakeMedia(110), tmp=tmp_path)
    run(run_actor({"confirmRights": True, "maxEpisodesPerFeed": 1, "sources": ["https://feeds.example.org/kan.rss"]}, d))
    assert out.rows[0]["status"] == "ok" and out.rows[0]["language"] is None


def test_u06_podnews_transcript_tags():
    f = parse("feed-podnews-with-transcript-tag.xml", "https://podnews.net/rss")
    assert len(f.episodes) == 3
    for e in f.episodes:
        assert len(e.transcripts) >= 1
        t = feeds.best_transcript(e)
        assert t["type"] == "text/vtt" and t["rel"] == "captions" and t["url"].endswith(".mp3.vtt")


def _fail(body, status=200, ctype="application/rss+xml"):
    web = Web()
    web.add("https://feeds.example.org/f", httpx.Response(status, content=body, headers={"content-type": ctype}))
    with pytest.raises(SourceError) as e:
        run(feeds.fetch_feed(net(web), "https://feeds.example.org/f"))
    return e.value.code


def test_u07_feed_failures():
    assert _fail(b"nope", 404) == "feed_http_404"
    assert _fail(b"<!DOCTYPE html><html><body>hi</body></html>", 200, "text/html") == "not_a_feed"
    assert _fail(b"<html><body>x</body></html>", 200, "text/html") == "not_a_feed"
    assert _fail(b"<rss><channel><item><title>a</title>") == "feed_parse_error"


def test_u07_billion_laughs_rejected_memory_flat():
    bomb = b"""<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
<!ENTITY lol9 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">]><rss><channel><title>&lol9;</title></channel></rss>"""
    tracemalloc.start()
    try:
        assert _fail(bomb) == "feed_parse_error"
        _cur, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 20 * 1024 * 1024


def test_u07_feed_too_large_stops_reading():
    sent = [0]

    async def body():
        yield b"<rss><channel>"
        while True:
            sent[0] += 1
            yield b"<item><title>" + b"x" * (1024 * 1024) + b"</title></item>"

    web = Web()
    web.add("https://feeds.example.org/big", httpx.Response(200, content=body(), headers={"content-type": "application/rss+xml"}))
    with pytest.raises(SourceError) as e:
        run(feeds.fetch_feed(net(web), "https://feeds.example.org/big"))
    assert e.value.code == "feed_too_large" and sent[0] <= 42


def test_u07_no_enclosure_relative_url_first_audio_wins(tmp_path):
    web = Web()
    web.add("https://feeds.example.org/none", xml("<rss><channel><item><title>a</title></item></channel></rss>"))
    d, out = deps(web, tmp=tmp_path)
    run(run_actor({"confirmRights": True, "sources": ["https://feeds.example.org/none"]}, d))
    assert out.rows[0]["errorCode"] == "no_episodes"
    f = run(feeds.fetch_feed(net(_web(
        '<rss><channel><item><title>a</title><enclosure url="cover.jpg" type="image/jpeg"/>'
        '<enclosure url="ep1.mp3" type="audio/mpeg"/><enclosure url="ep1.mp4" type="video/mp4"/></item></channel></rss>')),
        "https://feeds.example.org/show/feed.xml"))
    assert f.episodes[0].audio_url == "https://feeds.example.org/show/ep1.mp3"


def _web(text):
    w = Web()
    w.add("https://feeds.example.org/show/feed.xml", xml(text))
    return w


APPLE = "https://podcasts.apple.com/us/podcast/houston-we-have-a-podcast/id1262594123"


def _apple_web(with_episode=False):
    web = Web()
    results = [{"wrapperType": "track", "kind": "podcast", "feedUrl": "https://feeds.megaphone.fm/nasa"}]
    if with_episode:
        results.append({"wrapperType": "podcastEpisode", "trackId": 1000700000002, "trackName": "Capturing Artemis Return"})
    web.add("https://itunes.apple.com/lookup", httpx.Response(200, json={"resultCount": len(results), "results": results}))
    web.add("https://feeds.megaphone.fm/nasa", xml("feed-nasa-megaphone-length0.xml"))
    return web


def test_u08_apple_link_one_lookup_per_show(tmp_path):
    web = _apple_web()
    d, out = deps(web, fake_media=FakeMedia(3600), tmp=tmp_path)
    for n in ("5999466310", "1369565567", "4098454952"):
        web.add(f"https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION{n}.mp3", audio())
    run(run_actor({"confirmRights": True, "maxEpisodesPerFeed": 1, "maxAudioMinutesPerEpisode": 1,
                   "sources": [APPLE, APPLE + "?uo=4"]}, d))
    apple = [r for r in web.requests if r.url.host.endswith("apple.com")]
    assert len(apple) == 1 and apple[0].url.host == "itunes.apple.com" and apple[0].url.params["id"] == "1262594123"
    assert out.rows[0]["errorCode"] == "episode_too_long" and out.rows[0]["status"] == "skipped"
    assert out.charges.calls == []


def test_u08_apple_episode_selection_by_track_id():
    web = _apple_web(with_episode=True)
    f = feeds.AppleResolver(net(web))
    feed_url, hint = run(f.resolve(APPLE + "?i=1000700000002"))
    parsed = run(feeds.fetch_feed(net(web), feed_url))
    hit = feeds.match_hint(parsed.episodes, hint)
    assert feed_url == "https://feeds.megaphone.fm/nasa" and len(hit) == 1
    assert hit[0].title == "Capturing Artemis Return"
    assert len([r for r in web.requests if r.url.host == "itunes.apple.com"]) == 1


def test_u08_apple_rate_limit_twenty_per_minute():
    clock = Clock()
    web = Web()
    web.add("https://itunes.apple.com/lookup", httpx.Response(200, json={"results": [{"feedUrl": "https://f.example.org/x"}]}))
    n = net(web, clock, interval=0.0)
    r = feeds.AppleResolver(n)
    for i in range(25):
        run(r.resolve(f"https://podcasts.apple.com/us/podcast/x/id{i}"))
    times = list(n.apple.times)
    assert len(web.requests) == 25
    assert any(s >= 30 for s in clock.sleeps)  # the 21st lookup waited for the window
    assert len(times) <= 20


def ep(title, when=None, pos=0):
    return Episode(source="s", audio_url=f"https://a.example.org/{title}.mp3", title=title,
                   published=datetime(*when, tzinfo=timezone.utc) if when else None, position=pos)


def test_u09_episode_selection():
    eps = [ep("old", (2020, 1, 1), 0), ep("new", (2026, 11, 1), 1), ep("mid", (2024, 5, 5), 2)]
    assert [e.title for e in feeds.pick(eps, 2, None)] == ["new", "mid"]
    assert [e.title for e in feeds.pick(eps, 5, date(2024, 1, 1))] == ["new", "mid"]
    mixed = [ep("a", None, 0), ep("b", (2026, 1, 1), 1), ep("c", None, 2)]
    assert [e.title for e in feeds.pick(mixed, 3, None)] == ["a", "b", "c"]
    assert feeds.parse_date("file element=rss.pubDate") is None


def test_u09_filters_apply_before_any_download(tmp_path):
    web = Web()
    web.add("https://feeds.example.org/nasa", xml("feed-nasa-megaphone-length0.xml"))
    d, out = deps(web, tmp=tmp_path)
    run(run_actor({"confirmRights": True, "publishedAfter": "2099-01-01", "sources": ["https://feeds.example.org/nasa"]}, d))
    assert [r.url.host for r in web.requests] == ["feeds.example.org"]
    assert out.rows[0]["errorCode"] == "no_episodes"


PODNEWS_AUDIO = "https://op3.dev/e,pg=9b024349-ccf0-5f69-a609-6b82873eab3c/podnews.net/audio/podnews261126.mp3"
VTT = (FIX / "publisher-transcript-podnews261126.vtt").read_bytes()


def test_u10_formats_parse():
    segs = formats.parse_publisher(VTT, "text/vtt")
    assert len(segs) == VTT.decode().count("-->")
    assert segs[0]["start"] == 0.58 and segs[0]["end"] == 4.6
    srt = b"1\n00:00:01,000 --> 00:00:02,500\nHello there friend.\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line.\n"
    assert [s["text"] for s in formats.parse_publisher(srt, "application/x-subrip")] == ["Hello there friend.", "Second line."]
    js = b'{"version":"1.0.0","segments":[{"speaker":"Ann","startTime":0.5,"endTime":1.5,"body":"Hi all"}]}'
    assert formats.parse_publisher(js, "application/json")[0] == {"start": 0.5, "end": 1.5, "text": "Hi all", "speaker": "Ann"}
    assert formats.parse_publisher(b"plain words here", "text/plain")[0]["text"] == "plain words here"
    assert formats.parse_publisher(b"<html><body>x</body></html>", "text/html") == []
    assert not formats.valid_publisher(formats.parse_publisher(b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nToo short.\n", "text/vtt"))
    back = b"WEBVTT\n\n00:00:05.000 --> 00:00:06.000\n" + b"word " * 15 + b"\n\n00:00:01.000 --> 00:00:02.000\n" + b"word " * 15 + b"\n"
    assert not formats.valid_publisher(formats.parse_publisher(back, "text/vtt"))
    assert not formats.valid_publisher([])


def _podnews(tmp_path, vtt_resp):
    web = Web()
    web.add("https://podnews.net/rss", xml("feed-podnews-with-transcript-tag.xml"))
    web.add("https://podnews.net/audio/podnews261126.mp3.vtt", vtt_resp)
    d, out = deps(web, tmp=tmp_path)
    run(run_actor({"confirmRights": True, "maxEpisodesPerFeed": 1, "sources": ["https://podnews.net/rss"]}, d))
    return web, out


def test_u10_publisher_transcript_used_no_audio_request(tmp_path):
    web, out = _podnews(tmp_path, httpx.Response(200, content=VTT, headers={"content-type": "text/vtt"}))
    row = out.rows[0]
    assert row["status"] == "ok" and row["transcriptSource"] == "publisher" and row["engine"] == "publisher-vtt"
    assert len(row["segments"]) == VTT.decode().count("-->")
    assert [str(r.url) for r in web.requests] == ["https://podnews.net/rss", "https://podnews.net/audio/podnews261126.mp3.vtt"]
    assert out.charges.events() == [("publisher-transcript", 1)]
    assert row["billedMinutes"] == 0


@pytest.mark.parametrize("bad", [b"", b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nshort\n", b"<html>x</html>"])
def test_u10_invalid_publisher_transcript_falls_back_to_audio(tmp_path, bad):
    web = Web()
    web.add("https://podnews.net/rss", xml("feed-podnews-with-transcript-tag.xml"))
    web.add("https://podnews.net/audio/podnews261126.mp3.vtt", httpx.Response(200, content=bad, headers={"content-type": "text/vtt"}))
    web.add(PODNEWS_AUDIO, audio())
    d, out = deps(web, tmp=tmp_path)
    run(run_actor({"confirmRights": True, "maxEpisodesPerFeed": 1, "sources": ["https://podnews.net/rss"]}, d))
    assert out.rows[0]["transcriptSource"] == "stt"
    assert PODNEWS_AUDIO in [str(r.url) for r in web.requests]
    assert ("publisher-transcript", 1) not in out.charges.events()
