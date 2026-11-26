# Podcast Transcriber (Apify Actor): build spec

**Date:** 26 Nov 2026 (Israel time). **Owner decision:** Dvir picked this build on 26 Nov ("build the podcast transcription tool"). **Author:** Gavriel (chief of staff). **Builder:** DOM + Claude Code only; no code is written by the bots.
**Status:** spec only. Nothing is built, pushed, published, priced or signed up for. All prices below are **proposals**; each one needs Dvir's yes before it goes live.
**Folder name in the repo:** `apify-actors/podcast-transcriber/` (Apify name `podcast-transcriber`, account looped_kite).
**Companion files:** `dom-request.md` (the build request, tests as the contract), `listing/` (Store text, README draft, example input), `fixtures/` (real, public-domain/public test material and real API answers), `raw/` (probe outputs and competitor data pulled 26 Nov 2026).

---

## 0. Summary and what Dvir must decide

1. **What it is.** Input: a podcast RSS feed, an Apple Podcasts link (used only to find the public RSS feed), or a direct audio file URL. Output per episode: transcript with timestamps, SRT/VTT/TXT/JSON files, optional speaker labels, summary, chapters and key quotes. If the publisher's feed already carries a transcript (`<podcast:transcript>`), it is used first at almost no cost.
2. **Engine.** Build one engine interface with three adapters. **Default for production: Groq `whisper-large-v3-turbo` at $0.04 per audio hour** (needs a sign-up). **Quality / speaker labels: AssemblyAI Universal-2 at $0.15 per hour (+$0.02 with speakers)**, with $50 of free credit at sign-up. **Works today with the keys we already hold: Gemini 3.5 Transcribe, measured $0.0053 per minute ($0.32 per hour)** on a real probe. The report's pick, OpenAI `gpt-4o-mini-transcribe` at $0.003/min, **must not be used**: OpenAI deprecated it and it shuts down on 26 Feb 2027, and its replacement `gpt-transcribe` returns no timestamps (probe, §5.2).
3. **Price (proposal).** $0.006 per audio minute (Free/Bronze), $0.0055 (Silver), $0.005 (Gold); +$0.003 per minute for speaker labels; $0.01 per episode for summary + chapters + quotes; $0.002 per episode when the publisher's own transcript is used. Same as the two market leaders (both $0.006), 8× below the one that still has the most users ($0.05).
4. **Money check.** On Groq: our cost about $0.05 per audio hour, we keep $0.288 of the $0.36 an hour costs the user → profit about **$0.236 per hour (82%)**. On AssemblyAI Universal-2: about $0.126 per hour (44%). **On Gemini only: a loss of $0.042 per hour at $0.006**; Gemini needs at least $0.0069/min, so the no-sign-up path means a price of $0.009 (profit $0.10 per hour, 24%).
5. **Biggest risks.** (a) Free-plan users bring us $0 and our speech-to-text bill is real, so the Actor caps free-plan runs (§9). (b) Copyright: we only fetch what a public RSS feed or a direct URL serves, never YouTube/Spotify/private feeds, and the user confirms rights with a checkbox (§7). (c) Demand is crowded: 15+ transcribers on Store; our edge is the podcast-first flow, not price (§8).

**Decisions needed from Dvir (through Gavriel). None is taken here.**

| # | Decision | Why | Recommendation |
|---|---|---|---|
| D1 | Open a Groq account (pay as you go, hard monthly cap) | Cheapest engine, 4× cheaper than the next one | Yes. Cap $20 per month. |
| D2 | Open an AssemblyAI account (free $50 credit, no card) | Speaker labels, big files, and $0 cash for the whole acceptance suite | Yes. |
| D3 | Put the engine keys on Apify as secret environment variables of this Actor | The Actor runs on Apify and must call the engines | Yes, secret type only; Gavriel sets them, nobody prints them. |
| D4 | Price per §8 | Goes live only with his yes | Approve at publish time (day 4), as in the report. |
| D5 | Apple Podcasts links accepted as input | Legal comfort, §7.3 | Yes: feed lookup only. |
| D6 | Publish | Per standing rule | After A-tests pass. |

Until D1/D2 are yes, DOM builds all three adapters against recorded answers and the Gemini adapter is the only one run live.

---

## 1. Positioning and demand evidence

Live Store data, pulled 26 Nov 2026 from `https://api.apify.com/v2/acts/<user>~<name>` and `https://api.apify.com/v2/store?search=...` (raw files: `raw/act-*.json`, `raw/competitors-audio.json`). "u30" = users in the last 30 days. Prices are the FREE-tier event price per audio minute.

| Actor | u30 | Price per audio minute | Other events | Notes |
|---|---|---|---|---|
| [memo23/video-audio-transcriber](https://apify.com/memo23/video-audio-transcriber) | 344 | $0.05 (also $0.0008 per second) | start $0.03 | Highest users, highest price, so some buyers do not shop on price. |
| [tidytools/audio-transcriber](https://apify.com/tidytools/audio-transcriber) | 314 | $0.006 (Gold $0.0048) | diarized $0.015/min, AI summary $0.01, content pack $0.10, subtitle language $0.002/min | |
| [steadyfetch/media-transcriber](https://apify.com/steadyfetch/media-transcriber) | 289 | $0.006 flat | none | Title says "Podcast Transcription". |
| [kaz_kakyo/audio-transcriber](https://apify.com/kaz_kakyo/audio-transcriber) | 78 | $0.01 ($0.004 bring-your-own-key) | chapters $0.01 | |
| [tidydata/audio-video-transcription](https://apify.com/tidydata/audio-video-transcription) | 66 | $0.005 (Gold $0.004) | none | |
| [spokentext/spotify-podcast-transcript](https://apify.com/spokentext/spotify-podcast-transcript) | 55 | $0.003 (Gold $0.0021) | | Podcast-first, but lists Spotify (legal risk we avoid). |
| [firsthand/audio-video-transcription](https://apify.com/firsthand/audio-video-transcription) | 49 | $0.005 (Gold $0.0045) | speaker $0.003/min, translation $0.002/min, summary $0.01 | |
| [amanatools/whisper-transcriber](https://apify.com/amanatools/whisper-transcriber) | 38 | $0.008 | file $0.005 | |
| [viralanalyzer/video-transcriber](https://apify.com/viralanalyzer/video-transcriber) | 36 | $0.015 | | |
| [hgservices/speech-to-text](https://apify.com/hgservices/speech-to-text) | 36 | $0.042 | video $0.09 | 5★ from 4 reviews. |
| [zenomastro/audio-video-to-text](https://apify.com/zenomastro/audio-video-to-text) | 33 | $0.015 | | |
| [fguiraud/audio-video-transcriber](https://apify.com/fguiraud/audio-video-transcriber) | 33 | $0.006 | speaker $0.003/min, insights $0.01 | |
| [eliai/audio-transcriber-whisper](https://apify.com/eliai/audio-transcriber-whisper) | 29 | $0.015 | | |
| [lergassy/whisper-transcriber](https://apify.com/lergassy/whisper-transcriber) | 24 | $0.005 ($0.004 BYOK) | speaker $0.006/min | |
| [pulse_extract/podcast-transcript-extractor](https://apify.com/pulse_extract/podcast-transcript-extractor) | 1 | $0.015 | episode $0.002 (no minute charge when the feed has its own transcript) | The closest to our idea (feed first, Whisper second). Listing text says Apple and Spotify; 1 user. |

Reading: median price about $0.006 per minute; the three leaders hold about 950 of roughly 1,450 summed u30 (users overlap across Actors, so the sum is an upper bound). **Podcast-first Actors are small** (spokentext 55, pulse_extract 1): the volume is in generic "any media" transcribers. So our edge is not a lower price. It is:
1. feed → latest N episodes → one clean row each (no URL hunting);
2. the publisher transcript is used first, and billed almost nothing;
3. summary + chapters + key quotes that are verified against the transcript (quotes must appear word for word);
4. timestamps and speaker labels in the same row, plus SRT/VTT files;
5. clear "what we refuse" rules, which makes the listing safer than the Spotify/YouTube-flavoured ones.

Honest base rate: the report grades this idea B and the Gemini review said "kill" because of thin margin and copycats. The margin problem is solved only with Groq or AssemblyAI (§6). **Proposed pass mark: the same as the Apify test (30 outside users in 30 days, or $20 earned); stop if fewer than 10 users. The date is Dvir's to set.**

---

## 2. Inputs

Input schema (`.actor/input_schema.json`). All descriptions at least 40 characters (the repo's listing test requires it). Only `sources` and `confirmRights` are required; both have a prefill.

| Field | Type, default, range | Meaning |
|---|---|---|
| `sources` (required) | array of strings, editor `stringList`, prefill = the example in §11 | One per line: (a) a podcast **RSS/Atom feed URL**, (b) an **Apple Podcasts** show or episode link (`podcasts.apple.com/...`, optional `?i=` episode id), (c) a **direct audio or video file URL** (mp3, m4a, aac, wav, ogg, opus, flac, mp4, webm). Type is detected from the content, not the extension. Missing `https://` is added for bare hosts. Anything else is not a valid source (see §4.1). |
| `maxEpisodesPerFeed` | integer, default 3, 1–100 | Newest first by `pubDate`; if the date is missing or unparseable, feed order. |
| `publishedAfter` | string `YYYY-MM-DD`, optional | Skip older episodes (applies before any download). |
| `language` | string, default `auto` | `auto` = detect from the audio. Never trust the feed `<language>` (see test A-05: a Hebrew show tagged `en-US`). Otherwise an ISO 639-1 code. |
| `preferPublisherTranscript` | boolean, default true | Use `<podcast:transcript>` (VTT, SRT, JSON, plain text) when present and valid. |
| `addOns` | array of enum `summary`, `chapters`, `keyQuotes`; default `[]` | Charged as one `summary` event per episode if any is chosen (§8). |
| `speakerLabels` | boolean, default false | Speaker turns (`spk_1`, `spk_2`, …). Routes to an engine that supports it. |
| `wordTimestamps` | boolean, default false | Adds a `words` array to the JSON file (not to the dataset row). |
| `outputFormats` | array of enum `txt`, `srt`, `vtt`, `json`; default `["txt","srt"]` | Files saved in the default key-value store, linked in `files`. |
| `maxAudioMinutesPerEpisode` | integer, default 240, 1–600 | Longer episodes are skipped with `episode_too_long`, not charged. |
| `maxTotalAudioMinutes` | integer, default 600, 1–6000 | Run-wide cost guard on STT minutes. |
| `downloadStallSeconds` | integer, default 30, 5–120 | No bytes for this long = `download_stall_timeout`. |
| `episodeTimeoutMinutes` | integer, default 45, 5–180 | Wall-clock cap per episode (download to result). |
| `confirmRights` (required) | boolean, prefill true | "I may transcribe these recordings (mine, licensed to me, or permitted personal/research/accessibility use)". If false: `Actor.fail` with a message, nothing charged. |

Empty `sources` → `Actor.fail(status_message=...)`, no charge (repo contract). Duplicates are merged after normalisation. Invalid lines are saved to key `INVALID_INPUTS` and not charged.

---

## 3. Output

### 3.1 Dataset row (one per episode, including failures)

Dataset schema (`.actor/dataset_schema.json`), every field typed and described; view = table. `required`: `source`, `status`.

| Field | Type | Notes |
|---|---|---|
| `source` | string | The input line this row came from. |
| `feedUrl`, `feedTitle` | string or null | |
| `episodeTitle`, `episodeGuid`, `episodeUrl` | string or null | |
| `publishedAt` | string (ISO 8601) or null | Null when the feed date is unparseable (the LibriVox feed literally says `file element=rss.pubDate`). |
| `audioUrl` | string | The enclosure that was fetched, after stripping nothing (no tracking-parameter changes). |
| `durationSeconds` | integer or null | **Measured with ffprobe on the downloaded file, never the feed tag** (the NASA feed has `length="0"`; LibriVox has padded whitespace in `itunes:duration`). |
| `language` | string or null | Detected, ISO 639-1. |
| `transcriptSource` | `stt` / `publisher` / null | |
| `engine` | string or null | e.g. `whisper-large-v3-turbo`, `universal-2`, `gemini-3.5-transcribe`, `publisher-vtt`. |
| `text` | string | Full transcript. |
| `segments` | array of `{start, end, text, speaker}` | Seconds from the start of the episode; `speaker` null unless `speakerLabels`. |
| `summary` | string or null | Same language as the transcript. |
| `chapters` | array of `{start, title}` | Ascending, inside `[0, durationSeconds]`. |
| `keyQuotes` | array of `{start, text}` | Each `text` must be a word-for-word substring of the transcript, or it is dropped. |
| `wordCount` | integer | |
| `files` | object | Key-value store URLs for the formats asked for. |
| `billedMinutes` | integer | `ceil(durationSeconds / 60)` when STT was used, else 0. |
| `status` | `ok` / `error` / `skipped` | |
| `errorCode`, `errorMessage` | string or null | Codes in §4.6. Messages never contain a key or a signed URL. |

### 3.2 Key-value store
`transcript-<n>.txt|srt|vtt|json` and `INVALID_INPUTS`. Audio is **never** stored in a dataset or key-value store, and temporary files are deleted after each episode, also on error.

### 3.3 Real example (probe on a public-domain LibriVox recording)
Source: `https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3` (2 min 47 s). Real Gemini 3.5 Transcribe answer, saved in `fixtures/stt-gemini-3.5-transcribe-meditations-intro.json`: 417 words, word timestamps from `0.800s` ("Introduction") to `160.100s` ("papersallowed.com"). Resulting first segments:
```json
{ "start": 0.8, "end": 3.4, "text": "Introduction to the Meditations of Marcus Aurelius.", "speaker": null }
{ "start": 4.0, "end": 5.5, "text": "This is an LibriVox recording.", "speaker": null }
```
(the model wrote "an LibriVox"; OpenAI `gpt-transcribe` wrote "a LibriVox" on the same clip, so accuracy is checked by test A-07, not by eyeballing).

---

## 4. Pipeline (the behaviour DOM builds)

For each source, in this order. Concurrency: 3 episodes at a time, max 2 downloads per host, at least 1 s between requests to one host (the repo's `shared/polite.py`), identifying User-Agent `PodcastTranscriberActor/0.1 (Apify Actor)`.

### 4.1 Resolve
1. Normalise the URL. Only `http`/`https`. **Block** private/loopback/link-local/metadata addresses (`localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254`, `::1`, `fc00::/7`), checked on the **resolved IP at every redirect hop** (SSRF: the Actor runs inside Apify's network). Max 5 redirects.
2. **Platform deny-list** (checked before any request): `youtube.com`, `youtu.be`, `spotify.com`, `soundcloud.com`, `tiktok.com`, `instagram.com`, `facebook.com`, `x.com`, `twitter.com`, `audible.com`, `music.apple.com`, `.m3u8` playlists. Row: `status: error`, `errorCode: unsupported_platform` (or `unsupported_stream`), message tells the user what to do (for Spotify: "Spotify does not publish audio files. If the show also has a public RSS feed, paste that."). **No request is made to those hosts.** Not charged.
3. **Apple Podcasts** (`podcasts.apple.com/<cc>/podcast/<slug>/id<digits>[?i=<trackId>]`): call `https://itunes.apple.com/lookup?id=<digits>&entity=podcast` once per show (cache; stay far under Apple's documented ~20 calls/minute), take `feedUrl`, then continue as an RSS feed. With `?i=` select that episode by `trackId` via `entity=podcastEpisode` lookup or by matching title. Nothing else from Apple is used (no artwork, no previews, no audio).
4. Fetch the URL with `GET`, stream, **cap 40 MB for a feed** (a real feed is 20 MB with 3,049 episodes: `https://feeds.simplecast.com/54nAGcIl`, checked 26 Nov), parse incrementally with a safe parser (`defusedxml` or an iterparse that stops after `maxEpisodesPerFeed` plus filter needs). Decide type by content: XML with `<rss>`/`<feed>` = feed; `audio/*`, `video/*`, or `application/octet-stream` that ffprobe says has an audio stream = file; HTML = error `not_a_feed`.

### 4.2 Pick episodes
Per item: enclosure URL (first `audio/*` or `video/*` enclosure; relative URLs resolved), title, guid, `pubDate` (lenient parse; failure = null), `podcast:transcript` links, `podcast:license` if present (copied to the row as `license`; not required). Apply `publishedAfter`, then `maxEpisodesPerFeed`.

### 4.3 Publisher transcript first
If `preferPublisherTranscript` and a `podcast:transcript` exists: fetch it (prefer `text/vtt`, then `application/x-subrip`, then `application/json`, then `text/plain`; `text/html` is ignored). Valid = non-empty after parsing, at least 20 words, cues ascending. Then: `transcriptSource: publisher`, `engine: publisher-vtt` (etc.), no audio download, **charge only the `publisher-transcript` event**. Invalid or fetch fails: fall through to audio. Real feed with the tag: `https://podnews.net/rss` (items carry `https://podnews.net/audio/podnewsYYMMDD.mp3.vtt`, `text/vtt`, `rel="captions"`; sample in `fixtures/publisher-transcript-podnews261126.vtt`).

### 4.4 Download, measure, budget check (before any paid call)
1. Stream the enclosure to disk. No bytes for `downloadStallSeconds` → `download_stall_timeout`. Hard cap `maxDownloadMB` = 700 (disk is twice the memory, so 1024 MB memory gives 2 GB disk). HTTP 401/403 → `audio_access_denied` (no retry storm: one retry max); 404/410 → `audio_not_found`; 429/5xx → backoff, 3 tries, then `audio_unavailable`. `Content-Type: text/html` → `not_audio`.
2. `ffprobe`: no audio stream → `not_audio`; encrypted/protected stream (ffprobe/ffmpeg report `encrypted`, `DRM`, `EXT-X-KEY`, FairPlay `.m4p`) → `drm_protected`. No attempt to bypass anything.
3. `durationSeconds` from ffprobe. Over `maxAudioMinutesPerEpisode` → `skipped`, `episode_too_long`. Over what is left of `maxTotalAudioMinutes` → `skipped`, `run_minute_cap`.
4. **Free-plan cap** (§9). **Budget check:** `charging_manager.calculate_max_event_charge_count_within_limit('audio-minute')` must be at least `ceil(duration/60)`, else `skipped`, `budget_too_low`, **and the STT engine is never called**. (Our external cost comes before the platform charge, so we never start a paid call the user's spending limit cannot pay for.)

### 4.5 Transcribe
1. Re-encode to mono 16 kHz, 32 kbps MP3 (ffmpeg; measured: a 59.6-minute, 43.3 MB episode becomes 14.3 MB in 13.6 s on one core of the box). Delete the original.
2. Split into chunks of at most **20 minutes** at the quietest point within ±60 s of each boundary (`silencedetect`), no overlap; if none found, hard cut with 2 s overlap and drop duplicate words in the overlap. Engines with a file limit get smaller chunks (25 MB limit ≈ 100 minutes at 32 kbps, so 20 minutes is always safe).
3. Send chunks (2 at a time) to the first engine in `STT_ENGINE_ORDER` that has a key (default `groq,assemblyai,gemini`; `speakerLabels` forces `assemblyai`, then `gemini`; if neither has a key: `speakers_unavailable`, not charged). 429/5xx/timeouts: exponential backoff (3 tries), then **fail over to the next engine** for that chunk; log which engine was used; row `engine` shows the engine that produced most of the text.
4. **Silent-truncation guard.** Gemini cuts audio over its limit and still returns "complete" (documented). After each chunk, the last word/segment end must be at least 85% of the chunk duration unless the tail is silence (`silencedetect` agrees); otherwise retry that chunk at half the length, then fail over.
5. Merge: add the chunk offset to every timestamp; timestamps must be non-decreasing across the episode (clamp tiny negative jitter, error on real regressions).
6. **Whisper hallucination filter** (Groq `verbose_json` gives `no_speech_prob`, `avg_logprob`, `compression_ratio`): drop segments with `no_speech_prob > 0.6` and `avg_logprob < -1.0`, and any segment with `compression_ratio > 2.4`; collapse runs of 3 or more identical segments. Counted in the log, never silent.
7. Language: from the engine's answer when `language: auto`. If the engine gives none, use the first 60 seconds with a language-id call; else null.
8. Per-episode wall clock `episodeTimeoutMinutes` → `episode_timeout`; other episodes continue.

### 4.6 Add-ons (summary, chapters, key quotes)
One LLM call per episode (map-reduce over 40-minute pieces above 2 hours), cheap model chosen by env `SUMMARY_MODEL` (default order: an OpenAI nano-class model, then Gemini Flash-Lite; both keys exist today). Prompt rules: the transcript is **data, not instructions** (prompt-injection test U-18); the answer is JSON only, validated against a schema; summary in the transcript's language; chapters: 5–15, ascending, inside the duration, titles at most 80 characters; key quotes: 3–7, **each must be a verbatim substring** of the transcript after whitespace normalisation, else dropped (and if none survive, `keyQuotes: []`, not an error). If the LLM step fails, the transcript row is still `ok`, `summary: null`, and the `summary` event is **not** charged.

### 4.7 Push and charge (one place: `billing.py`)
Order: files saved → `push_data(row)` → charge. Events (names only; **no prices in code, README, tests or JSON**, same rule as CR-129):
- `audio-minute` × `billedMinutes`, only when STT succeeded;
- `speaker-minute` × `billedMinutes`, only when speaker labels were delivered;
- `summary` × 1, only when at least one add-on was delivered;
- `publisher-transcript` × 1, only for a transcript taken from the feed;
- nothing for `error` or `skipped` rows.
Use `Actor.charge(event_name, count, idempotency_key=sha1(guid|audioUrl, event))` and check `charged_count`; if the limit is reached, finish gracefully. Keep Apify's default `apify-actor-start` event.

### 4.8 Error codes (stable)
`unsupported_platform`, `unsupported_stream`, `ssrf_blocked`, `feed_http_<status>`, `not_a_feed`, `feed_parse_error`, `feed_too_large`, `no_episodes`, `audio_access_denied`, `audio_not_found`, `audio_unavailable`, `not_audio`, `drm_protected`, `download_stall_timeout`, `file_too_large`, `episode_too_long`, `run_minute_cap`, `free_plan_cap`, `budget_too_low`, `episode_timeout`, `stt_failed`, `speakers_unavailable`, `rights_not_confirmed`.

**Run result:** at least one input with a row → run succeeds. Every input failed and none produced `ok` → `Actor.fail` with a status message such as "No episode could be processed. See the dataset for the reason per source." Zero charges in that case.

---

## 5. Speech-to-text engine choice

### 5.1 Price comparison (list prices read 26 Nov 2026)

| Engine | Per audio hour | Per minute | Timestamps | Speakers | Max per request / how it takes audio | Sign-up | Source |
|---|---|---|---|---|---|---|---|
| **Groq `whisper-large-v3-turbo`** | **$0.04** | $0.00067 | segment + word (`verbose_json`) | no | 25 MB free / 100 MB dev; also accepts a `url`; min billed 10 s; 216× real time | Yes | [Groq docs](https://console.groq.com/docs/speech-to-text) |
| Groq `whisper-large-v3` | $0.111 | $0.00185 | same | no | same | Yes | same |
| Cloudflare Workers AI whisper-large-v3-turbo | $0.031 | $0.00051 | n/a (not checked) | n/a | n/a | Yes | [aggregator, second-hand](https://tryabracadabra.com/ai-pricing/models/groq-whisper-large-v3-turbo/): not verified at source, not used |
| **AssemblyAI Universal-2** | **$0.15** | $0.0025 | word | **+$0.02/hr** | accepts upload or URL (file limits not checked); 99+ languages; $50 free credit, no card | Yes | [AssemblyAI pricing](https://www.assemblyai.com/pricing) |
| AssemblyAI-STT-3.7 | $0.21 | $0.0035 | word | +$0.02/hr | 32 languages incl. Hebrew; best published WER | Yes | same, and [models list](https://www.assemblyai.com/llms/models.md) |
| Deepgram Nova-3 (pre-recorded) | $0.258 | $0.0043 ($0.0052 multilingual) | yes | included | $200 free credit, no card; billed per second | Yes | [Deepgram pricing](https://deepgram.com/pricing) |
| ElevenLabs Scribe v2 batch | $0.20 | $0.0033 | yes | yes | | Yes | [VoiceCost, 25 Nov](https://voicecost.net/cheapest-speech-to-text.html) |
| Soniox async | $0.10 | $0.0017 | yes | | cheapest listed | Yes | [VoiceCost, 25 Nov](https://voicecost.net/cheapest-speech-to-text.html) |
| OpenAI `gpt-transcribe` | $0.27 | $0.0045 | **none** (json/text only; probe) | no | 25 MB | **No (key exists)** | [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [guide](https://developers.openai.com/api/docs/guides/speech-to-text) |
| OpenAI `gpt-4o-mini-transcribe` | $0.18 | $0.003 | none | no | | no | **Deprecated, shuts down 26 Feb 2027** |
| OpenAI `whisper-1` | $0.36 | $0.006 | segment + word | no | | no | **Deprecated, shuts down 26 Feb 2027**; the only OpenAI model with timestamps |
| **Gemini 3.5 Transcribe** | **$0.30 listed, $0.32 measured** | $0.005 listed, $0.0053 measured | word | yes (up to 8) | **30 min per request with timestamps or speakers; longer is silently cut**; 20-minute chunks at 32 kbps are about 4.8 MB; auto language | **No (key exists)** | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe), [guide](https://ai.google.dev/gemini-api/docs/generate-content/transcribe) |
| Self-hosted `faster-whisper` on Apify CPU | `base`: $0.038, `small`: $0.152 (estimates from measured speed) | | yes | no | Apify has no GPU; 1 CPU core per 4 GB | none | measured, §5.3 |

### 5.2 Probes we ran (our existing keys only; total spend about $0.033)
All on the same 2:47 public-domain recording (`fixtures/meditations-intro-30s.mp3` is its first 30 seconds):

| Probe | Result |
|---|---|
| Gemini 3.5 Transcribe, word timestamps on | HTTP 200 in 6.1 s. 4,186 audio tokens + 516 text tokens = $0.0084 + $0.0062 = **$0.0146 for 167 s ($0.0053/min)**. 417 words, each with start/end. Answer: `fixtures/stt-gemini-3.5-transcribe-meditations-intro.json`. |
| Gemini 3.5 Transcribe on a 60 s Hebrew clip (Kan Docs, first 60 s after 2:00) | HTTP 200 in about 10 s; correct Hebrew text with 115 timestamped words, language auto-detected (the feed tags the show `en-US`). 1,500 audio + 242 text tokens = about $0.0059. |
| OpenAI `gpt-transcribe`, default `json` | HTTP 200 in 6.0 s. Billing basis `usage: {type: duration, seconds: 168}` = $0.0126 at $0.0045/min. Returns `text`, `languages` and nothing else. `fixtures/stt-openai-gpt-transcribe-meditations-intro.json`. |
| OpenAI `gpt-transcribe`, `verbose_json` | **HTTP 400**: "response_format 'verbose_json' is not compatible with model … Use 'json' or 'text'". No charge. |

### 5.3 Self-hosted measured
`faster-whisper` 1.x, int8, beam 1, VAD on, one thread, on 5 minutes of the NASA episode: **`base` 20.9× real time, `small` 5.3× real time** (the box, not Apify; Apify gives 1 core per 4 GB). At $0.20 per compute unit (Apify Free/Starter, [Apify pricing](https://apify.com/pricing)): `base` = 0.19 CU per audio hour = $0.038, `small` = 0.76 CU = $0.152. `large-v3-turbo` on CPU was not measured and would be slower than `small`. Same cost as Groq at a much worse model, or 4× Groq at a similar-or-lower model. **Rejected.**

### 5.4 Choice
- **Production default: Groq turbo.** 4–8× cheaper than anything else with timestamps. Unknowns, to settle on the first live run after D1: the rate limit (one Groq table shows 7,200 audio seconds per hour and 28,800 per day for the base Developer limits, [Groq rate limits](https://console.groq.com/docs/rate-limits), while a third-party page quotes 400K per hour; **ask for a raised limit or fail over**), and Whisper's hallucinations on silence/music (filter in §4.5).
- **Quality / speakers: AssemblyAI Universal-2** (STT-3.7 for Hebrew and the other 31 languages when the language is known and accuracy matters). Speaker labels are +$0.02 per hour there, so the user price for speakers ($0.003/min) is almost pure margin.
- **Fail-over and today's live engine: Gemini 3.5 Transcribe** (key exists). Fine as fail-over, but not as the default at our price: break-even is $0.0069/min.
- **Not used:** OpenAI (no timestamps, or deprecated), Deepgram (cost $0.258/hr leaves 6% margin at our price, but is a sound fourth adapter later), self-hosted.
- The report's cost line ("$0.003 per minute from `gpt-4o-mini-transcribe`") is out of date on both counts: the model is being shut down, and the price assumed no timestamps.

---

## 6. Cost per hour of audio vs proposed price

Platform compute per audio hour (estimate, to be measured in A-tests): download 4 s + re-encode 13.6 s on one core measured on the box for 59.6 minutes; Apify gives about a quarter core per GB, so about 55 s at 1 GB, plus waiting on the engine. About 0.06 CU × $0.20 = **about $0.012 per audio hour** ([CU price](https://apify.com/pricing); [usage](https://docs.apify.com/platform/actors/running/usage-and-resources)). We keep 80% of the user's charge ([profit formula](https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs)). Summary: about $0.001 per 1-hour episode on a nano-class model (about 12,000 tokens in, 1,000 out at $0.05 / $0.40 per million, [OpenAI pricing](https://developers.openai.com/api/docs/pricing)); about $0.006 on Gemini 3.5 Flash-Lite ($0.30 / $2.50, [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)).

User pays $0.006 × 60 = **$0.36 per audio hour** (Bronze), we keep $0.288:

| Engine | STT cost / hour | + platform | Profit / hour | Margin on what we keep | Break-even price / minute |
|---|---|---|---|---|---|
| Groq turbo | $0.040 | $0.012 | **$0.236** | 82% | $0.0011 |
| Groq large-v3 | $0.111 | $0.012 | $0.165 | 57% | $0.0026 |
| AssemblyAI Universal-2 | $0.150 | $0.012 | $0.126 | 44% | $0.0034 |
| AssemblyAI Universal-2 + speakers (user pays +$0.18/hr more) | $0.170 | $0.012 | $0.106 + $0.144 from the speaker event | 37% | $0.0038 |
| AssemblyAI-STT-3.7 | $0.210 | $0.012 | $0.066 | 23% | $0.0046 |
| Deepgram Nova-3 | $0.258 | $0.012 | $0.018 | 6% | $0.0056 |
| Gemini 3.5 Transcribe (measured) | $0.318 | $0.012 | **−$0.042** | −15% | **$0.0069** |

At $0.009 per minute (the no-sign-up fallback price) Gemini gives +$0.102 per hour (24%), Groq +$0.380 (88%).
A 1-hour episode with summary at the recommended price: user pays $0.36 + $0.01 = **$0.37**; we keep $0.296; Groq cost about $0.053 → **about $0.243 profit**.
Report's old number for comparison: price $0.009 minus cost $0.003 = about $0.24 per hour. Our new number is the same profit at a lower price, on the engine that actually has timestamps.

---

## 7. Legal and terms check

*Not legal advice; Dvir may want a lawyer to read §7.2 before publish. Sources are cited so each point can be checked.*

### 7.1 What the Actor fetches
Only (a) a public RSS/Atom feed URL the user gives, (b) the audio enclosure that feed itself publishes, and (c) a direct file URL the user gives that opens without login. A podcast feed is published so that apps download the enclosure: the Actor does the same thing a podcast app does, one request per file, at a polite rate, with an honest User-Agent. No login, no cookies, no proxies, no paywall or DRM handling, no stream capture.

### 7.2 Copyright
A transcript is a copy of the spoken work. The publisher put the audio in a public feed for listening; transcribing it for personal use, accessibility, research or search is the normal use case, but republishing someone else's transcript can infringe. So: the README says so in plain words; `confirmRights` is a required checkbox; the Actor stores no audio and re-hosts nothing; `podcast:license` is copied into the row when the feed states one; takedown requests are answered within Apify's 3 business days ([Publishing Terms](https://docs.apify.com/legal/store-publishing-terms-and-conditions)). Publisher transcripts are fetched from the URL the publisher itself lists in its feed ([Podcasting 2.0 transcript tag](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md)).

### 7.3 Platform terms
| Platform | Decision | Basis |
|---|---|---|
| Public RSS feeds and their enclosures | **Allowed** | See 7.1. |
| Apple Podcasts links | **Allowed, lookup only.** Use the public iTunes lookup to get the feed URL; use nothing else from Apple. Stay far under ~20 calls per minute. | [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html) documents the lookup, the ~20 calls per minute limit and limits only "promo content" (previews, artwork). Apple's media terms limit use of Apple's own content to personal, non-commercial use ([Apple Media Services terms](https://www.apple.com/legal/internet-services/itunes/kr/terms-en.html)), so we do not touch Apple-hosted audio. |
| Apple Podcasts Subscriptions / private feeds | **Refused** (`audio_access_denied` or `not_audio`) | Content is licensed by the provider; paid. |
| Spotify | **Refused, no request to Spotify** | The [Developer Terms](https://developer.spotify.com/terms) ban facilitating "stream ripping" or other ways to make permanent copies of Spotify content and ban feeding Spotify content into AI models. Spotify does not publish audio files anyway. One competitor lists Spotify; we do not copy that risk. |
| YouTube | **Refused** | Same reasoning as the report (terms). |
| SoundCloud, TikTok, Instagram, Facebook, X, Audible, Apple Music | **Refused** | Terms; not public RSS audio. |
| HLS/streams, DRM | **Refused** | Not a public file; no circumvention. |
| Apify | Compliant | [Acceptable Use Policy](https://docs.apify.com/legal/acceptable-use-policy) forbids actions that "contravene … the rights of any third party" and undue server load (hence the per-host rate limit); Publishing Terms 2.2.4.2 forbid promoting off-platform products in the README (the README names no vendor links) and fake reviews. |

### 7.4 Privacy
Audio goes to the engine provider (Groq / AssemblyAI / Google) to be processed. The README says so. Gemini's paid tier states "Used to improve our products: No" ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)); **the Groq and AssemblyAI data-use terms were not read in this spec: check them before D1/D2 are signed.** Transcripts of interviews contain personal data; the user is the one who decides to process them (README, Your responsibility).

### 7.5 What stays out
No live scraping of Apple/Spotify pages, no search by show name (it would invite Spotify-style fuzzy matching), no translation in v0.1, no transcript editing.

---

## 8. Apify pay-per-event pricing proposal

Rule: no prices in code, README, tests or JSON; prices are set in Console by Gavriel after Dvir's yes. **Only paid-plan users bring revenue** ([Apify: free-plan users "don't bring you revenue"](https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs)): Free-tier prices below are what free users see; our margin comes from Bronze and up.

| Event | Charged when | Free | Bronze | Silver | Gold | Competitor reference |
|---|---|---|---|---|---|---|
| `audio-minute` | per started minute of audio that was transcribed by an engine (rounded up per episode) | $0.006 | $0.006 | $0.0055 | $0.005 | tidytools $0.006 (Gold $0.0048), steadyfetch $0.006, fguiraud $0.006, firsthand $0.005 (Gold $0.0045), tidydata $0.005 (Gold $0.004), memo23 $0.05, spokentext $0.003 |
| `speaker-minute` | per minute when speaker labels were delivered, on top of `audio-minute` | $0.003 | $0.003 | $0.003 | $0.0025 | firsthand $0.003, fguiraud $0.003, lergassy $0.006, tidytools $0.015 all-in diarized |
| `summary` | per episode with summary, chapters or key quotes delivered | $0.01 | $0.01 | $0.01 | $0.01 | tidytools $0.01, firsthand $0.01, fguiraud $0.01, kaz_kakyo chapters $0.01 |
| `publisher-transcript` | per episode where the feed's own transcript was used (no engine) | $0.002 | $0.002 | $0.002 | $0.002 | pulse_extract $0.002 per episode |
| `apify-actor-start` | Apify's default | keep default | | | | |

Why $0.006: it matches the two Actors with about 300 users each; going lower makes no one switch and cuts margin; going to memo23's $0.05 is not defensible. Floor check: Gold $0.005 × 0.8 = $0.004 against Groq cost about $0.0008 per minute (including platform at the Gold CU price of $0.13) and AssemblyAI Universal-2 about $0.0026 → both still profitable. Minimum run charge: set `minimalMaxTotalChargeUsd` so a run can pay for at least one short episode.
Worked examples at Bronze: a 30-minute episode = $0.18; a 3-hour episode = $1.08; a 5-minute publisher-transcript episode = $0.002; 100 episodes of one hour with summaries = $37.
**If Dvir says D1/D2 = no (Gemini only):** use `audio-minute` $0.009 everywhere except Gold $0.008, keep the rest; do not publish at $0.006.

---

## 9. Free plan, abuse and secrets

- **Free plan cost.** Free-plan runs bring $0 and Apify pays only their platform cost; **our engine bill is ours**. Rule: if `APIFY_USER_IS_PAYING` is not `1`, the Actor processes at most **15 audio minutes per run in total** (cost to us at most $0.01 on Groq, $0.04 on AssemblyAI, $0.08 on Gemini), publisher transcripts are unlimited, and the rest are `skipped` with `free_plan_cap` and a status message "Free-plan runs transcribe up to 15 minutes. Upgrade your Apify plan to transcribe full episodes." The README states it ([Apify requires being open about free-plan limits and exiting gracefully](https://docs.apify.com/platform/actors/monetize)). Operators (our own test account) bypass it through env `OPERATOR_USER_IDS` (a comma list set in Console, never in the repo).
- **Fraud ceiling.** The cap is per run, so many small free runs are possible. Mitigate with a hard monthly spend cap on each provider account (D1/D2) and a weekly look at the provider bill; if free-plan abuse shows, lower the cap to 5 minutes.
- **Secrets.** Keys are secret Actor environment variables: `GROQ_API_KEY`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` (summary), plus `STT_ENGINE_ORDER`, `SUMMARY_MODEL`, `OPERATOR_USER_IDS`. Never in git, input, dataset, logs, error messages or tests. A test captures all log output and asserts no key text appears (same pattern as the PageSpeed Actor). Provider URLs with signed parameters are never logged.
- **Bring-your-own-key** (later, v0.2): competitors sell it at about 60% of the normal price ($0.004 vs $0.01 at kaz_kakyo, $0.004 vs $0.005 at lergassy). It removes our engine risk. Not in v0.1.

---

## 10. Acceptance tests

Two layers. **The tests are the contract.**

### 10.1 Offline contract tests (CI, no network, no keys) — IDs `U-xx`
Listed in `dom-request.md`. They use recorded fixtures from `fixtures/` plus synthetic audio made with `ffmpeg` at test time (sine and silence), so no copyrighted audio is committed. Only `meditations-intro-30s.mp3` is a real recording (LibriVox, public domain).

### 10.2 Live acceptance on real public episodes — IDs `A-xx`
Run by Gavriel on Dvir's machine (or as private Apify runs) **after D1–D3**, against the built Actor, private and unpublished. Engine for the whole suite: the first one that has a key. Every pass criterion is mechanical. Budget for the whole suite, 325 audio minutes: Groq about $0.22, AssemblyAI about $0.81 (inside the $50 free credit, so $0 cash), Gemini about $1.72. **Any spend above a few cents needs Dvir's yes first.**

| ID | Case | Input (real, public) | Audio length | Pass criteria |
|---|---|---|---|---|
| **A-01** | Short English, direct URL, public domain | `https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3` | 2:47 (167 s) | `status ok`; `durationSeconds` 167 ± 2; text contains "Marcus Aurelius" and "George Long"; word count 380–460 (probe: 417); first segment starts within 0–3 s; last segment ends 150–168 s; `billedMinutes` 3; charged `audio-minute` × 3 and nothing else; result in under 90 s. |
| **A-02** | RSS feed with ugly data | `https://librivox.org/rss/1095`, `maxEpisodesPerFeed 2` | 2:47 + 16:25 | 2 rows `ok`; feed has `pubDate` text `file element=rss.pubDate` and `length="0"`: `publishedAt` is null, no crash; durations from ffprobe (about 167 s and about 985 s), not from the feed; order = feed order; the whitespace-padded `itunes:duration` is ignored. |
| **A-03** | About 1 hour, redirect chain, `length=0` | Enclosure `https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION5999466310.mp3` (NASA, "Capturing Artemis Return"), `addOns` all three | 59:38 (3,578 s) | `ok`; `billedMinutes` 60; last segment ends ≥ 3,520 s and ≤ 3,580 s; 100–200 words per minute overall; no timestamp regression; `summary` non-empty; 5–15 chapters ascending; every key quote is a substring of `text`; charged `audio-minute` × 60 + `summary` × 1; wall time under 8 minutes at 1 GB. |
| **A-04** | Long episode, chunking | Enclosure `https://media.blubrry.com/takeituneasy/ins.blubrry.com/takeituneasy/lex_ai_larry_lawton.mp3` (Lex Fridman Podcast #505, 149 MB, two redirects then 200) | 3:26:58 (12,418 s) | `ok`; about 11 chunks; last segment ends 12,300–12,420 s; no timestamp regression across chunk joins; no run of 5+ identical segments; 100–200 words per minute; `billedMinutes` 207; peak memory under 900 MB; finishes inside `episodeTimeoutMinutes`. Output is checked and thrown away, never published. |
| **A-05** | Non-English, feed language tag wrong | Enclosure of the newest Kan Docs episode "רציתי לצעוק תנו לי להיות": `https://traffic.omny.fm/d/clips/23f697a0-7e6a-4e96-a223-a82c00962b12/c40b8ac9-3853-41fc-a2bf-b02700be578d/4ac2bbc6-b8be-4a36-97a1-b4fe00d114ba/audio.mp3` (feed `https://www.omnycontent.com/d/playlist/23f697a0-7e6a-4e96-a223-a82c00962b12/c40b8ac9-3853-41fc-a2bf-b02700be578d/d2f0ee29-6047-4c3b-bab9-b02700c0b25e/podcast.rss` says `en-US`) | 31:43 (1,903 s) | `language` = `he`; at least 85% of letters are Hebrew letters; no English translation; timestamps ascending; `billedMinutes` 32. |
| **A-06** | Publisher transcript path | `https://podnews.net/rss`, `maxEpisodesPerFeed 1` | 4:48, **0 engine minutes** | `transcriptSource publisher`; no audio request made; charged only `publisher-transcript` × 1; segments equal the VTT cues (7,377 bytes sample in `fixtures/`). |
| **A-07** | Accuracy against a human-checked reference | Same Podnews episode with `preferPublisherTranscript false` | 4:48 | Word error rate against the publisher VTT of **12% or lower** (Groq quotes 12% WER for turbo; AssemblyAI quotes lower). If higher, report it, don't fail the build; it decides the engine order. |
| **A-08** | Broken feeds | (a) `https://www.iana.org/this-feed-does-not-exist.xml`; (b) `https://example.com/` (200 HTML); (c) mixed run of (a) + `https://librivox.org/rss/1095` with `maxEpisodesPerFeed 1`; (d) a run of only (a)+(b) | none | (a) row `feed_http_404`; (b) row `not_a_feed`; (c) run succeeds, 2 rows (1 error, 1 ok), charged for the ok one only; (d) run FAILED with the status message in §4.8, zero charges. Offline in U-tests: truncated XML, XML bomb, enclosure 404. |
| **A-09** | Timeouts | (a) `https://httpbin.org/delay/10` as an audio URL with `downloadStallSeconds 5`; (b) `episodeTimeoutMinutes 5` on A-04 | 0 / partial | (a) row `download_stall_timeout` within 15 s, no charge; (b) row `episode_timeout`, no charge, run continues with the next source. Engine hang/429 and the run-timeout path are covered offline (U-13, U-14). |
| **A-10** | Refusals | YouTube watch URL, Spotify show URL, `http://169.254.169.254/latest/meta-data/`, `https://httpbin.org/status/403` as audio | none | `unsupported_platform` (×2, **no outgoing request to those hosts**), `ssrf_blocked`, `audio_access_denied`; zero charges. Include one good source in the same run so the run itself succeeds (a run where every input fails is marked failed, §4.8). |
| **A-11** | Apple link | `https://podcasts.apple.com/us/podcast/houston-we-have-a-podcast/id1262594123`, `maxEpisodesPerFeed 1`, `maxAudioMinutesPerEpisode 1` | 0 | Resolves to the Megaphone feed through one lookup call; row `skipped` `episode_too_long`; zero charges; exactly one request to `itunes.apple.com`. |
| **A-12** | Huge feed, zero spend | `https://feeds.simplecast.com/54nAGcIl` (20 MB, 3,049 items), `maxEpisodesPerFeed 3`, `maxAudioMinutesPerEpisode 1` | 0 | Returns 3 rows in under 60 s, memory under 400 MB; feed never fully held in memory. |
| **A-13** | Spending limit | A-03 input with the run's max charge set to $0.10 | 0 | Row `skipped` `budget_too_low`; **engine never called** (engine dashboard shows no request); zero charges. |
| **A-14** | Cost truth | Sum of A-01…A-07 | 325 min | Our engine bill (from the provider dashboard) divided by billed minutes is within 15% of §6; Apify platform cost per audio hour (run Usage tab) at most $0.03. Result goes into `docs/` as the first margin measurement. |

---

## 11. Store listing draft

Files in `listing/`: `actor-text.json` (title, description, seoTitle, seoDescription), `README.draft.md`, `example-input.json`. Drafted to pass the repo's listing tests (title at most 59 characters, seoTitle at most 60, seoDescription at most 160, README title equals actor title, first screen at most 16 lines with `**Returns**`, `**Cost:**`, "Pricing tab" and a JSON example whose keys are input fields, no dollar amounts, none of the banned words, last section "Permissions" with the required sentence). Checked by hand against those regexes on 26 Nov: title 55, seoTitle 53, seoDescription 140 characters, first screen 11 lines, no "$digit", no banned words. Bots own README and these text keys; Claude Code copies them as the first draft.

- **Title (55):** Podcast Transcriber: RSS Feeds to Text, SRT and Summary
- **seoTitle (53):** Podcast Transcript Scraper: RSS to Text, SRT, Summary
- **seoDescription (140):** Transcribe podcast episodes from an RSS feed or audio URL. Get text, timestamps, SRT/VTT, speakers, summary and chapters. Public feeds only.
- **Categories:** chosen in Console at publish time (for example AI and Videos); Gavriel picks them with the price and publish steps.
- **Real `exampleRunInput`** (the input schema prefill; `tools/sync-store-meta.py` turns it into the Store example). A real, public-domain, 2:47 file, so a first run costs a fraction of a cent and finishes in under a minute; the same file is test A-01:
```json
{
  "sources": ["https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3"],
  "maxEpisodesPerFeed": 1,
  "language": "auto",
  "preferPublisherTranscript": true,
  "addOns": ["summary", "chapters"],
  "outputFormats": ["txt", "srt"],
  "confirmRights": true
}
```
- Logo: DOM adds a generator in the style of `tools/make_broken_link_logo.py` (same PNG rules: square, at least 256 px, valid CRC, reproduced byte for byte by the generator test).
- Tutorial for day 5 ("podcast to blog post"): after A-tests; text only, written by Gavriel.

---

## 12. Open risks

1. **Margin depends on D1/D2.** Without them: price $0.009 and a crowded top-of-market position (§8). 
2. **Groq limits unknown** until a key exists (§5.4). Fail-over covers it, but raises cost per minute.
3. **Free-plan abuse** (§9). 
4. **Copyright and takedowns.** Mitigated, not removed (§7.2). 
5. **Demand.** Podcast-first Actors have 1–55 users; the big numbers belong to generic transcribers. Judge at the agreed date.
6. **Model churn.** OpenAI is retiring its older transcription models, Gemini's new model is days old: the adapters are swappable by env order, tests don't name a vendor except in adapter tests.
7. **Third-party test hosts** (`httpbin.org`, `iana.org`, `example.com`) can change; A-08/A-09/A-10 have offline twins.

---

## 13. Sources (all opened 26 Nov 2026)

- OpenAI pricing and speech-to-text guide: https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/guides/speech-to-text
- Groq speech-to-text docs and rate limits: https://console.groq.com/docs/speech-to-text , https://console.groq.com/docs/rate-limits
- AssemblyAI pricing and model list: https://www.assemblyai.com/pricing , https://www.assemblyai.com/llms/models.md
- Deepgram pricing: https://deepgram.com/pricing
- Gemini pricing, model page, transcription guide: https://ai.google.dev/gemini-api/docs/pricing , https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe , https://ai.google.dev/gemini-api/docs/generate-content/transcribe
- Cheapest STT table: https://voicecost.net/cheapest-speech-to-text.html
- Apify: https://apify.com/pricing , https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs , https://docs.apify.com/sdk/python/docs/concepts/pay-per-event , https://docs.apify.com/platform/actors/running/usage-and-resources , https://docs.apify.com/legal/store-publishing-terms-and-conditions , https://docs.apify.com/legal/acceptable-use-policy , https://docs.apify.com/actors/monetize
- Competitor Actors: pages linked in §1; data via `https://api.apify.com/v2/acts/<user>~<name>` and `https://api.apify.com/v2/store`.
- Legal: https://developer.spotify.com/terms , https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html , https://www.apple.com/legal/internet-services/itunes/kr/terms-en.html , https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md
- Repo conventions: `DvirBaumel8/domain-trading` at `apify-actors/` (CR-129, `tests/test_contract.py`, `tests/test_listing.py`, `shared/polite.py`, `tools/sync-store-meta.py`, `ci/README.md`).
- Probe data and local measurements: `raw/` (competitor JSON, probe answers, feed checks, `fw-bench` numbers in §5.3).
