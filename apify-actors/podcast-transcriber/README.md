# Podcast Transcriber: RSS Feeds to Text, SRT and Summary

Turn podcast episodes into searchable text. Give it a podcast RSS feed, an Apple Podcasts link or a direct audio file URL. If the publisher already ships a transcript in the feed, the Actor uses it. Otherwise it transcribes the audio.

**Returns** one row per episode: `episodeTitle`, `publishedAt`, `durationSeconds`, `language`, `transcriptSource`, `text`, `segments` (start, end, text, speaker), `summary`, `chapters`, `keyQuotes`, `files` (TXT, SRT, VTT, JSON in the key-value store), `status` and `errorCode`.

**Cost:** pay per event: audio minutes transcribed, plus optional add-ons. Episodes that fail are not charged. See the Pricing tab for current prices.

```json
{ "sources": ["https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3"], "maxEpisodesPerFeed": 1, "addOns": ["summary", "chapters"], "confirmRights": true }
```

## What you can feed it

- A podcast **RSS feed URL**. The newest episodes are read from the feed (you choose how many, and from which date).
- An **Apple Podcasts** show or episode link. The Actor only looks up the show's public RSS feed and then works from the feed.
- A **direct link to an audio or video file** (MP3, M4A, WAV, OGG, FLAC, MP4, WebM) that anyone can open without logging in.

## What it will not do

- No YouTube, Spotify, SoundCloud, TikTok or Instagram links. Their terms do not allow it, and Spotify does not publish audio files.
- No private, paid or password-protected feeds, and nothing with copy protection (DRM). Those links are skipped with a clear error code and are not charged.
- It does not store or re-publish audio. Audio is downloaded to the run, processed, and deleted.

## Example output (abridged, real run on a public-domain recording)

```json
{
  "episodeTitle": "Introduction",
  "durationSeconds": 167,
  "language": "en",
  "transcriptSource": "stt",
  "text": "Introduction to the Meditations of Marcus Aurelius. This is a LibriVox recording. All LibriVox recordings are in the public domain. ...",
  "segments": [
    { "start": 0.8, "end": 3.4, "text": "Introduction to the Meditations of Marcus Aurelius.", "speaker": null },
    { "start": 4.0, "end": 5.5, "text": "This is a LibriVox recording.", "speaker": null }
  ],
  "status": "ok"
}
```

## Input

- **Sources**: one per line: feed URLs, Apple Podcasts links or direct file links.
- **Max episodes per feed** and **Published after**: how far back to go in a feed.
- **Language**: leave on auto. The Actor detects the spoken language itself and does not trust the language tag of the feed.
- **Prefer the publisher's transcript**: on by default. Uses the transcript from the feed when there is one.
- **Add-ons**: summary, chapters, key quotes (key quotes are checked against the transcript word for word).
- **Speaker labels** and **word timestamps**: optional.
- **Safety caps**: longest episode, total minutes per run, download stall time.

## Limits and honest notes

- Runs on the Apify free plan are capped to a short total length per run, because the speech-to-text step has a real cost to the author. The cap and the reason are shown in the run status message.
- Long episodes are split at pauses and merged again. Timestamps are for the whole episode.
- Speech-to-text can make mistakes with names, accents, music and cross-talk. Check anything you publish.
- The audio is sent to a third-party speech-to-text service to be processed. Do not use this Actor for recordings that must not leave your control.

## Your responsibility

You confirm with a checkbox that you may transcribe the recordings you submit: they are yours, licensed to you, or you use them for personal, research or accessibility purposes where the law allows it. A transcript is a copy of the speech. Do not republish other people's transcripts without permission.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also writes transcript files to its default key-value store.

## Deploying from the repo

`.actor/actor.json` passes `ASSEMBLYAI_API_KEY` to the run as the Apify account secret `@assemblyaiApiKey`. That secret must already exist in the Apify account under the name `assemblyaiApiKey` before a push, or the run will not receive `ASSEMBLYAI_API_KEY`. No secret value is kept in this repo. If the key is missing, the AssemblyAI engine is skipped while another engine still has a key; if no engine has a key, the run ends as `stt_failed`.
