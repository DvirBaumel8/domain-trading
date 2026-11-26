"""Broken Link Auditor: the Apify adapter."""
from __future__ import annotations

import asyncio

from apify import Actor, Event

from .runner import make_client, run


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}

        stop_event = asyncio.Event()

        def stop(_data=None) -> None:
            # Every row is already in the dataset (pushed right after its check): just start no new URL.
            stop_event.set()

        Actor.on(Event.ABORTING, stop)
        Actor.on(Event.MIGRATING, stop)

        async def push(row: dict, charge: bool) -> bool:
            if charge:
                res = await Actor.push_data(row, charged_event_name='result')
                return bool(res is not None and getattr(res, 'event_charge_limit_reached', False))
            await Actor.push_data(row)
            return False

        async with make_client() as client:
            async def save_invalid(items: list) -> None:
                await Actor.set_value('INVALID_INPUTS', items)  # never pushed to the dataset, so never charged

            ok, msg = await run(inp, client=client, push=push, set_status=Actor.set_status_message,
                                 debug_log=Actor.log.info, log=Actor.log.warning, save_invalid=save_invalid, stop_event=stop_event)
        if not ok:
            await Actor.fail(status_message=msg)
            return
        await Actor.set_status_message(msg)
