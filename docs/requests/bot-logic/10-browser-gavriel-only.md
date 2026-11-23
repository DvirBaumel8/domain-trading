# Browser work = Gavriel only

**Status:** Current as of 2026-11-23 (Dvir: money actions stay in the browser). Standing from 2026-10-27 (t973u / t974u, Asia/Jerusalem) still holds for who drives the browser.

## Rule

Money actions — **register, renew, bid, buy, list, and change a price** — stay in the **browser with Gavriel**, and each one needs **Dvir's own chat yes** for that exact action.

- No other bot drives marketplace or registrar websites (GoDaddy, Afternic, Porkbun, and the like).
- DOM is stateless and read-only (v7.1.0). **Only free read APIs move into DOM** (CR-115 and CR-116). Those reads do not spend money and do not list, bid, buy, register, or renew.
- Prefer a DOM read when one exists (wake `GET /health/ping` first, at https://domain-trading-api.onrender.com). If the step spends money or needs a click, hand it to Gavriel.

## Why (short)

Dvir: the app never spends money. Money stays in the browser with Gavriel. Free server-to-server reads can live in DOM.

## Pass/fail

- Pass: a money action is done by Gavriel in the browser after Dvir's chat yes on that action; reads go through DOM when a free read API exists.
- Fail: DOM or any other bot buys, bids, registers, renews, or lists; or a money action proceeds without Dvir's chat yes.
