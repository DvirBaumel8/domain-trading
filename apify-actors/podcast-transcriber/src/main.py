"""Podcast Transcriber: the Apify adapter. Charging happens only in billing.py."""
from __future__ import annotations

import httpx
from apify import Actor

from . import config
from .billing import Billing
from .net import Net
from .runner import Deps, run


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}

        async def push(row: dict) -> None:
            await Actor.push_data(row)

        async def set_value(key: str, value, content_type: str) -> None:
            await Actor.set_value(key, value, content_type=content_type)

        def log(msg: str) -> None:
            Actor.log.info(msg)

        async with httpx.AsyncClient(headers={"User-Agent": config.UA}, timeout=60, follow_redirects=False) as client:
            deps = Deps(net=Net(client), push=push, set_value=set_value, set_status=Actor.set_status_message,
                        billing=Billing(log=log), log=log, paying=config.is_paying(), kv_store_id=config.kv_store_id())
            ok, msg = await run(inp, deps)
        if not ok:
            await Actor.fail(status_message=msg)
            return
        await Actor.set_status_message(msg)
