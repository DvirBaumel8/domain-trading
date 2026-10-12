# CR-047: list roofingvoiceagent.com (D-004) at Afternic and Sedo now

From: Gavriel, 2026-10-13 01:30 IDT. Dvir at 01:29 IDT: "Let's list roofingvoiceagent".

## State (API 3.9.0)
- `GET /portfolio`: `listed`, hybrid, BIN $1,488, floor $967, min offer $100, lander afternic, `ns_verified: true`, **`export_pending_since: 2026-10-10T12:48:18+03:00`**.
- Public: `afternic.com/domain/roofingvoiceagent.com` answers **404** (redirects to `/_error`). NS = ns1/ns2.afternic.com.
- `POST /list/roofingvoiceagent.com` `{dry_run: true}`: `valid: true`, no warnings, `lto_max_months: null`. Afternic row preview: `RoofingVoiceAgent.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`. No real `/list` call is needed: the name is already listed, only the upload is missing.

## Ask (Dvir's Chrome, with his yes for this run)
1. **Afternic:** export (`GET /export/afternic.csv`), upload it, and confirm with `POST /export/afternic/uploaded`. BIN $1,488, floor $967, min offer $100. **Lease-to-own on** per CR-046 (Dvir approved it) if possible. If LTO needs `lto_max_months` set by `/list` first (it's an override), tell me the value and approval form you need and I'll make the call. Don't hold the upload for it.
2. **Sedo:** submit it in the same run, Make Offer, $1,488, min offer $100, nameservers stay on Afternic. Add the CR-040 TXT `@` = `61e9c2a3c1d17668b5cb581bec57058b12741ed6` at Porkbun for it (CR-040 step 1).
3. **Receipt** in `DOM-TO-GAVRIEL.md`: Afternic status, LTO state, Sedo submission, TXT added. I'll then check the Afternic page shows $1,488 and record the Sedo venue only after Sedo lists it.

Note: two `POST`s through the Worker at 01:23 and 01:29 IDT got the tunnel's Cloudflare 502 page once each (see BUG-043 item 3). A retry worked.
