"""Broken Link Auditor: the Apify adapter."""
from __future__ import annotations

from apify import Actor

from .runner import make_client, run


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}

        async def push(row: dict, charge: bool) -> bool:
            if charge:
                res = await Actor.push_data(row, charged_event_name='result')
                return bool(res is not None and getattr(res, 'event_charge_limit_reached', False))
            await Actor.push_data(row)
            return False

        async def invalid_input_exit(msg: str) -> None:
            """Bad input is not a failed run: status message plus a STATUS record (never pushed, so never charged), exit 0."""
            await Actor.set_status_message(msg)
            await Actor.set_value('STATUS', {'ok': False, 'reason': 'invalid_input', 'message': msg})

        async with make_client() as client:
            async def save_invalid(items: list) -> None:
                await Actor.set_value('INVALID_INPUTS', items)  # never pushed to the dataset, so never charged

            ok, msg = await run(inp, client=client, push=push, set_status=Actor.set_status_message,
                                 debug_log=Actor.log.info, log=Actor.log.warning, save_invalid=save_invalid)
        if not ok:
            await invalid_input_exit(msg)
            return
        await Actor.set_status_message(msg)
