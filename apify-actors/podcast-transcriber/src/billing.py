"""The only place that charges. Event names only; prices live in Apify Console (spec §4.7)."""
from __future__ import annotations

import hashlib

from apify import Actor

AUDIO_MINUTE = "audio-minute"
SPEAKER_MINUTE = "speaker-minute"
SUMMARY = "summary"
PUBLISHER_TRANSCRIPT = "publisher-transcript"
EVENTS = (AUDIO_MINUTE, SPEAKER_MINUTE, SUMMARY, PUBLISHER_TRANSCRIPT)


def idempotency_key(episode_id: str, event: str) -> str:
    return hashlib.sha1(f"{episode_id}|{event}".encode()).hexdigest()


async def _apify_charge(event: str, count: int, key: str):
    return await Actor.charge(event, count=count, idempotency_key=key)


def _apify_max(event: str):
    try:
        return Actor.get_charging_manager().calculate_max_event_charge_count_within_limit(event)
    except Exception:  # noqa: BLE001 - no charging information (local run): no limit
        return None


class Billing:
    def __init__(self, charge_fn=_apify_charge, max_fn=_apify_max, log=print):
        self.charge_fn, self.max_fn, self.log = charge_fn, max_fn, log
        self.reserved: dict[str, int] = {}
        self.done: set[str] = set()
        self.stopped = False
        self.charged: list[tuple[str, int]] = []

    def room(self, event: str) -> float:
        """How many more events of this kind the user's limit allows, after what is reserved for running episodes."""
        m = self.max_fn(event)
        return float("inf") if m is None else m - self.reserved.get(event, 0)

    def reserve(self, needs: dict[str, int]) -> bool:
        if self.stopped or any(self.room(e) < n for e, n in needs.items() if n):
            return False
        for e, n in needs.items():
            self.reserved[e] = self.reserved.get(e, 0) + n
        return True

    def release(self, needs: dict[str, int]) -> None:
        for e, n in needs.items():
            self.reserved[e] = max(0, self.reserved.get(e, 0) - n)

    async def charge(self, episode_id: str, event: str, count: int) -> bool:
        """Charge once per (episode, event). Returns False (and stops the run gracefully) when fewer were charged."""
        if event not in EVENTS:
            raise ValueError(event)
        if count <= 0:
            return True
        if self.stopped:
            return False
        key = idempotency_key(episode_id, event)
        if key in self.done:
            return True
        res = await self.charge_fn(event, count, key)
        self.done.add(key)
        got = getattr(res, "charged_count", count) if res is not None else count
        self.charged.append((event, got))
        if got < count:
            self.log(f"charge limit reached: {event} {got} of {count}; stopping")
            self.stopped = True
            return False
        return True
