# AI Visibility Check

Private repo for the AI Visibility Check website (operator: Dvir Baumel). Not the public domain-trading repo.

The site is a small Python server (`site/server.py`) plus static pages. Deploy is a Render **free** web service; see `render.yaml`. Payment links stay empty until Polar is connected. Orders: set `ORDERS_REPO` + `ORDERS_GITHUB_TOKEN` (private repo; unset = local `private-orders/`), `ORDER_ALERT_WEBHOOK_URL`, `POLAR_WEBHOOK_SECRET`; Polar webhook URL is `/api/polar/webhook` (event `order.paid`). Tests: `python3 -m unittest discover -s tests`.
