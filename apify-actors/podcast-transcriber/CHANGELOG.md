# Changelog

## 0.1.0 (27 Nov 2026)

- First version, private and unpublished. RSS/Atom feeds, Apple Podcasts links (feed lookup only) and direct audio or video file URLs.
- Publisher transcript first (podcast:transcript in VTT, SRT, JSON or text), then speech-to-text with fail-over between engines.
- Long episodes are split at pauses and merged; timestamps are for the whole episode.
- Optional summary, chapters and key quotes; key quotes are checked word for word against the transcript.
- TXT, SRT, VTT and JSON files in the key-value store; failed and skipped episodes are not charged.
- Free-plan runs are capped to a short total length per run.
