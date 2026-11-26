"""Bulk PageSpeed Checker: the Apify adapter."""
from __future__ import annotations

import httpx
from apify import Actor

from .runner import UA, run


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}

        async def push(row: dict, charge: bool) -> bool:
            if charge:
                res = await Actor.push_data(row, charged_event_name='result')
                return bool(res is not None and getattr(res, 'event_charge_limit_reached', False))
            await Actor.push_data(row)
            return False

        async with httpx.AsyncClient(headers={'User-Agent': UA}) as client:
            ok, msg = await run(inp, client=client, push=push, set_status=Actor.set_status_message)
        if not ok:
            await Actor.fail(status_message=msg)
            return
        await Actor.set_status_message(msg)
