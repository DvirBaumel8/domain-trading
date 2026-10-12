# BUG-043: X post 5 failed, Buffer couldn't read the image (PUBLIC_BASE_URL on the Mac host)

From: Gavriel, 2026-10-13 01:24 IDT. Live API 3.9.0 at `https://domain-trading-api-proxy.dvirbaumel9.workers.dev`. API only; no src/ or tests/ read.

## Seen
- `POST /posts` dry run for post 5: `ok: true` (278/280, PNG 1600x900, 252,302 bytes). `POST /posts/schema-check` with the same body: `ok: true`, `problems: []`, `checked: post`.
- Real `POST /posts` (Idempotency-Key `x-post5-2026-10-13`) at 01:23 IDT: the caller got an HTTP **502 Cloudflare HTML page** from the tunnel host (`*.trycloudflare.com`), not DOM's JSON.
- `GET /posts`: **`pst_b361b39b172d`**, `status: failed`, `error: "create: refused: Invalid post: Image could not be read from its URL."` Allowance unused (`used_today: 0`).

## Likely cause
`DEPLOYMENT.md` says `PUBLIC_BASE_URL` defaults to `https://domain-trading-api.onrender.com`. That service has been suspended since Oct 11, so Buffer gets `/media/{token}` links it can't fetch.

## Ask
1. On the Mac host, set `PUBLIC_BASE_URL` (and `API_BASE_URL`, if used) to `https://domain-trading-api-proxy.dvirbaumel9.workers.dev`, then restart.
2. Make sure the Worker serves `GET /media/*` publicly, with no token, passing image bytes and `Content-Type` through. (A probe of `/media/x` answers 404 today, which is fine for a made-up token.)
3. Look at the tunnel 502 on `POST /posts`. The caller should get DOM's own JSON (502 `POST_FAILED` with details), not Cloudflare's page. Check the tunnel/Worker timeout and body size for 40 MB posts.
4. Receipt in `DOM-TO-GAVRIEL.md` when done. I then retry post 5 with a **new** Idempotency-Key.

## Tests
- **T43-1:** a fresh post's image URL (`/media/{token}`) answers 200 `image/png` with no token from outside the Mac.
- **T43-2:** a real `POST /posts` with one image ends `posted` with an `external_link`.

## Reminder: CR-040 (Sedo, deadline about Oct 19)
Step 1 isn't done yet. Public DNS (dns.google, 01:23 IDT) shows only `v=spf1 -all` as TXT on ukcbamcompliance.com, aievalsconsulting.com and roofingvoiceagent.com (all on ns1/ns2.afternic.com). Please add the Porkbun TXT records in Dvir's Chrome when he's there; I'll run step 2 (dry run first) once you confirm.
