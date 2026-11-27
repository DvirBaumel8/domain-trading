"""All settings, read from env on every call (tests can change env). A missing key means `not_configured`, never a crash."""
import os

VERSION = "0.1.0"
NOT_CONFIGURED = "not_configured"
CONFIGURED = "configured"

# feature -> env names that must all be set
FEATURES = {
    "oauth": ("GHL_CLIENT_ID", "GHL_CLIENT_SECRET"),
    "sso": ("GHL_SHARED_SECRET",),
    "webhooks": ("GHL_WEBHOOK_PUBLIC_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "perplexity": ("PERPLEXITY_API_KEY",),
}


def _str(name, default=""):
    return (os.environ.get(name) or default).strip()


def _num(name, default, cast=float):
    try:
        return cast(_str(name) or default)
    except ValueError:
        return cast(default)


def get():
    """Snapshot of every setting. Secrets are returned as given ('' when unset); never log or return this dict."""
    return {
        "GHL_CLIENT_ID": _str("GHL_CLIENT_ID"),
        "GHL_CLIENT_SECRET": _str("GHL_CLIENT_SECRET"),
        "GHL_SHARED_SECRET": _str("GHL_SHARED_SECRET"),
        "GHL_WEBHOOK_PUBLIC_KEY": _str("GHL_WEBHOOK_PUBLIC_KEY"),
        "DATABASE_URL": _str("DATABASE_URL", "sqlite:///ghl-app.db"),
        "OPENAI_API_KEY": _str("OPENAI_API_KEY"),
        "ANTHROPIC_API_KEY": _str("ANTHROPIC_API_KEY"),
        "PERPLEXITY_API_KEY": _str("PERPLEXITY_API_KEY"),
        "GHL_MONTHLY_CAP_USD": _num("GHL_MONTHLY_CAP_USD", "20"),
        "GHL_PER_LOCATION_CAP_USD": _num("GHL_PER_LOCATION_CAP_USD", "2"),
        "GHL_TRIAL_MAX_LOCATIONS": _num("GHL_TRIAL_MAX_LOCATIONS", "3", int),
        "GHL_APP_ENABLED": _str("GHL_APP_ENABLED", "0") in ("1", "true", "yes"),
    }


def status(feature):
    """'configured' or 'not_configured' for one feature in FEATURES."""
    cfg = get()
    return CONFIGURED if all(cfg[k] for k in FEATURES[feature]) else NOT_CONFIGURED


def all_status():
    return {f: status(f) for f in FEATURES}
