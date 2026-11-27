# Scopes

The app requests the minimum. Anything not listed is not requested.

| Scope | Why |
|---|---|
| `locations.readonly` | Reads the sub-account's business name, website and address (city) from `GET /locations/{id}`. These are the only HighLevel fields the app needs, to know which business to ask AI engines about. Read-only: the app never changes a location. |

No contacts, conversations, opportunities, calendars or write scopes are requested.

Note: the Company-token calls used for bulk install (`/oauth/installedLocations`, `/oauth/locationToken`) are OAuth plumbing. Check in the Marketplace app settings whether HighLevel requires extra `oauth.*` scopes for them; if it does, add them here with a reason before submitting.
