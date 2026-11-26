"""AI Brand Mention Check: the Apify adapter."""
from __future__ import annotations

from decimal import Decimal

import httpx
from apify import Actor

from . import config, providers
from .runner import Pricing, run

UA = "AIBrandMentionCheck/0.1 (Apify actor)"


def read_pricing() -> Pricing:
    """The price of one result and of the start, and the user's maximum charge, from the platform at run time."""
    max_total = config.max_total_charge_usd()
    try:
        info = Actor.get_charging_manager().get_pricing_info()
        prices = dict(getattr(info, "per_event_prices", None) or {})
        if max_total is None and getattr(info, "max_total_charge_usd", None) is not None and Decimal(info.max_total_charge_usd).is_finite():
            max_total = Decimal(info.max_total_charge_usd)
    except Exception:  # noqa: BLE001 - no charging information (local run): no pre-run price check
        prices = {}
    result = prices.get(config.RESULT_EVENT)
    return Pricing(Decimal(result) if result is not None else None, Decimal(prices.get(config.START_EVENT) or 0), max_total)


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        try:
            fake = config.use_fake_providers()
        except config.ConfigError as e:
            await Actor.fail(status_message=str(e))
            return

        async def push(row: dict, charge: bool) -> bool:
            if charge:
                res = await Actor.push_data(row, charged_event_name='result')
                return bool(res is not None and getattr(res, 'event_charge_limit_reached', False))
            await Actor.push_data(row)
            return False

        async def set_summary(data: dict) -> None:
            await Actor.set_value('SUMMARY', data)

        transport = providers.fake_transport() if fake else None
        async with httpx.AsyncClient(headers={'User-Agent': UA}, transport=transport, timeout=config.CALL_TIMEOUT_SECS + 10) as client:
            ok, msg = await run(inp, client=client, push=push, set_status=Actor.set_status_message,
                                set_summary=set_summary, pricing=read_pricing())
        if not ok:
            await Actor.fail(status_message=msg)
            return
        await Actor.set_status_message(msg)
