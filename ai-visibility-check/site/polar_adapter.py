"""The one place that knows Polar's webhook shape. A second payment provider later needs one file like this
and no change to the ledger, the slots or the portal: they only see the normalised event from `parse()`.

Normalised event (a plain dict, no provider field names):
  {"kind": "paid" | "refunded", "ref": opaque order id, "email": lower-case or "", "product_ids": [...],
   "paid_cents": int | None, "one_time": bool}
`quantity` or any other field in the payload is ignored: the product id decides how many reports a bundle has.
"""
import base64, hashlib, hmac, re, time

import products

TOLERANCE_SECONDS = 300


def verify(secret, headers, body):
    """Standard Webhooks signature: HMAC-SHA256 over '<id>.<timestamp>.<body>', base64, 'v1,' prefix."""
    if not secret:
        return False
    mid, ts, sig = headers.get("webhook-id", ""), headers.get("webhook-timestamp", ""), headers.get("webhook-signature", "")
    try:
        if abs(time.time() - int(ts)) > TOLERANCE_SECONDS:
            return False
    except ValueError:
        return False
    keys = []
    if secret.startswith("whsec_"):          # Standard Webhooks: key is the base64-decoded part after the prefix
        try:
            keys.append(base64.b64decode(secret[len("whsec_"):]))
        except ValueError:
            pass
    keys.append(secret.encode("utf-8"))      # legacy: the secret string itself
    msg = f"{mid}.{ts}.".encode() + body
    sigs = [c.split(",", 1)[1] for c in sig.split() if c.startswith("v1,")]
    ok = False
    for key in keys:
        want = base64.b64encode(hmac.new(key, msg, hashlib.sha256).digest()).decode()
        for s in sigs:
            ok = hmac.compare_digest(want, s) or ok
    return ok


def _ref(v):
    return re.sub(r"[^A-Za-z0-9_-]", "", str(v or ""))[:60]


def parse(event_type, data):
    """-> normalised event dict, or None when the event type is not one the agency feature uses."""
    kind = {"order.paid": "paid", "order.refunded": "refunded"}.get(event_type)
    if kind is None or not isinstance(data, dict):
        return None
    cust = data.get("customer") if isinstance(data.get("customer"), dict) else {}
    email = str(cust.get("email") or data.get("customer_email") or "").strip().lower()
    return {"kind": kind, "ref": _ref(data.get("id")), "email": email, "product_ids": products.product_ids(data),
            "paid_cents": products.paid_cents(data),
            "one_time": data.get("billing_reason") == products.BILLING_REASON_PURCHASE}
