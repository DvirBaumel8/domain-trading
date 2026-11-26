# AI Visibility Check — model plan and API key setup

Research date: 26 November 2026, Asia/Jerusalem.  
Scope: research only. No accounts opened, no spend, no keys created.  
Goal: the $149 report should reflect what a real consumer sees today in ChatGPT, Perplexity, Google Gemini / AI Mode, and Claude.ai — not the cheapest API model.

Every price and default below is from an official page, with the URL. Token costs are estimates until a real paid run reports `usage`.

---

## 1. What the code does today

Repo: `DvirBaumel8/domain-trading`, folder `ai-visibility-check/`.  
A $149 “check” order runs **30 prompts × 2 repeats × 4 engines = 240 calls**. See `engine/aivis/order.py` (`TIERS["check"] = (30, 2)`, lines 32–34) and `PAID_ENGINES` (lines 28–30).

The mock run charged a fixed estimate of **$5.88 per order** (`/workspace/company/avc-mock-run/summary.json`). That number is not a measured bill. It is:

| Engine | Calls | Code estimate per call | Subtotal |
|---|---:|---:|---:|
| OpenAI | 60 | $0.058 | $3.48 |
| Perplexity | 60 | $0.004 | $0.24 |
| Gemini | 60 | $0.016 | $0.96 |
| Claude | 60 | $0.020 | $1.20 |
| **Total** | **240** | | **$5.88** |

Source of those per-call figures: `engine/aivis/providers/paid.py` lines 22–27. The OpenAI figure was measured on **chat-latest**, not on `gpt-5-mini` (comment at lines 5–6).

How each provider is called, and whether search is on:

| Engine | File:lines | Model in code | Endpoint | Search / grounding |
|---|---|---|---|---|
| OpenAI | `paid.py` 58–72 | `gpt-5-mini` | `POST https://api.openai.com/v1/responses` | **On.** `tools: [{type: "web_search", user_location: approximate, country: US, city}]` |
| Perplexity | `paid.py` 75–84 | `sonar` | `POST https://api.perplexity.ai/chat/completions` | **Not passed as a tool.** Relies on Sonar’s built-in search. Chat Completions support officially ended 27 Sep 2026; sync calls are being rewritten as Agent API requests. |
| Gemini | `paid.py` 87–98 | `gemini-3.8-flash` | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | **On.** `tools: [{google_search: {}}]` |
| Claude | `paid.py` 101–115 | `claude-haiku-4-5` | `POST https://api.anthropic.com/v1/messages` | **On.** `tools: [{type: "web_search_20250305", name: "web_search", max_uses: 2}]` |

Prompt text is short (dentist sample: average 56 characters, about 14 tokens). Almost all cost is search fees plus retrieved search tokens, not the question itself.

---

## 2. What consumers actually see today (official)

### ChatGPT

- **Plus, Pro, Business, Enterprise (Chat tab, rolling out from 23 Nov 2026):** default is **GPT-6.2**, “powered by a version of GPT-6.2 Sol … tuned for everyday conversation.” Officially better at “finding answers to difficult questions on the web.”  
  Source: [ChatGPT release notes, 23 Nov 2026](https://help.openai.com/en/articles/6825453-chatgpt-release-notes).
- **Free and Go:** default is **GPT-5.6 Luna**. They do not get GPT-6.2 / GPT-5.6 Sol. Instant and the Think button both use Luna.  
  Source: [GPT-6 and other models in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt) (Help Center, updated 26 Nov 2026).  
  Note: an [7 Oct 2026 OpenAI blog](https://openai.com/index/gpt-6-for-everyone/) said GPT-6 Luna was rolling out to Free and Go. The Help Center page updated today still names **GPT-5.6 Luna**. This plan follows the Help Center.
- **Search:** available on Free, Go, Plus, Pro, and even signed-out users. ChatGPT “may search the web automatically when your question would benefit from current information.” Users can also turn Web search on before sending. It uses approximate location (IP, optional device location) for local results.  
  Source: [Searching the web with ChatGPT](https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt).

Closest API match for Plus Chat: `gpt-6.2-sol` + Responses API `web_search` + `user_location`. The consumer model is a chat-tuned variant; the API model is the official Sol id, not a perfect clone.  
Closest API match for Free Chat: `gpt-5.6-luna` + the same `web_search` tool.

`gpt-5-mini` (today’s code) is the wrong product match, and it **shuts down on 11 Dec 2026**. Official replacement for that API id is `gpt-6.1-terra`, which is a Work/Codex model, not the Chat default.  
Source: [OpenAI deprecations](https://platform.openai.com/docs/deprecations).

### Perplexity

- The consumer product always answers with live web search.
- Official Free (Standard) plan: “practically unlimited basic searches” and “very limited amount of Pro Search.”  
  Source: [Which Perplexity subscription plan is right for you?](https://www.perplexity.ai/help-center/en/articles/11187416-which-perplexity-subscription-plan-is-right-for-you) (Help Center snippet retrieved 26 Nov 2026; the full page timed out on fetch).
- Official first-party model for lightweight grounded search is **Sonar**. In the Agent API the id is `perplexity/sonar`.  
  Sources: [Sonar models](https://docs.perplexity.ai/docs/sonar/models), [Agent API Models](https://docs.perplexity.ai/docs/agent-api/models).
- The model-picker Help article could not be loaded today, so this plan does not claim a word-for-word “the Free default is Sonar” quote. The closest documented API match for Free **basic Search** is still `perplexity/sonar`. Pro users can choose other models and use Pro Search more often; that is a known gap.

### Google Gemini app, AI Mode, and AI Overviews

- **AI Mode in Search:** Gemini 4 Hydrogen is the new default for all users, and is “being used for your hardest questions in AI Overviews.”  
  Sources: [Introducing Gemini 4 Hydrogen](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/) (updated 16 Nov 2026); Google Search VP quoted in that launch coverage. Everyday AI Overviews may still use a faster model for simpler queries — Google has not published a complete Overviews routing table.
- **Gemini app, no paid Google AI plan:** the only Chat option is **Auto**. Auto “select[s] Hydrogen or a fast, lightweight model, as well as the appropriate thinking level … while conserving your usage.” Local-business questions that need current web results should usually route to Hydrogen, but Auto is not Hydrogen on every prompt.  
  Source: [About Gemini models](https://support.google.com/gemini/answer/18648722?hl=en).

Closest API match: `gemini-4-hydrogen` with `tools: [{google_search: {}}]`.  
Official API price: **$1.50 / $7.50 per 1M input/output**, including thinking tokens. Grounding is **not available on the free API tier**. Paid tier: 5,000 free Search grounding requests per month (shared across Gemini 3 and newer), then $14 per 1,000, with a 1,500 requests/day cap on the Gemini Developer API. Retrieved grounding context is not charged as input tokens.  
Source: [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing).

The existing company Gemini key used by domain-trading-api is a **free, no-billing** key. Grounding is not available on the free tier, and that key must not be reused for this product. AVC needs its own paid AI Studio project.

### Claude.ai

- **Pro, Max, Ultra, and Team:** official default is **Claude Opus 5.5**.  
  Source: [Using Claude Opus 5.5 as your daily driver](https://claude.com/resources/articles/using-claude-opus-5-5-as-your-daily-driver-for-knowledge-work).
- **Free:** Opus is **not** included. Sonnet and Haiku are.  
  Source: [Claude plans & pricing](https://claude.com/pricing) (Models and usage table: Opus = No on Free, Yes on Pro+).
- “Anyone can chat with Claude using Sonnet 5.5 on Claude.ai.”  
  Source: [Claude Sonnet 5.5](https://www.anthropic.com/claude/sonnet).
- **Web search** is included on Free and paid plans.  
  Source: [Claude pricing, feature table](https://claude.com/pricing).

Closest API match for Free / everyone: `claude-sonnet-5-5` + `web_search` (the code’s `web_search_20250305` tool still works; newer tool versions exist).  
Closest API match for Pro default: `claude-opus-5-5` + the same tool, effort Medium (official default for Opus 5.5).

`claude-haiku-4-5` (today’s code) is a legacy model, not what Claude.ai shows by default. Current Haiku is `claude-haiku-5-5`.  
Source: [Claude Haiku 4.5 overview](https://platform.claude.com/docs/en/models/haiku-4-5/overview) (legacy); [Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview).

---

## 3. Comparison table (accuracy first)

Prices are official standard-tier rates per 1M tokens, plus the official search/grounding fee. “Mid cost / order” uses the assumptions in §4 (60 calls, 1 search, mid token sizes). “High” is also in §4.

| Consumer surface | Official default (with search) | Closest API equivalent | Official token price (in / out per 1M) | Official search / grounding fee | Mid cost / order (60 calls) | Cheaper “good enough” contrast (still a real consumer or official small model) |
|---|---|---|---|---|---:|---|
| ChatGPT Plus / Pro Chat | GPT-6.2 (chat-tuned GPT-6.2 Sol), auto web search | `gpt-6.2-sol` + Responses `web_search` + `user_location` | $2 / $10. [Pricing](https://platform.openai.com/docs/pricing). [Introducing GPT-6.2](https://openai.com/index/introducing-gpt-6-2-astra-sol/). | $10 per 1,000 web-search calls + search-content tokens at the model input rate. [Pricing](https://platform.openai.com/docs/pricing) | **~$1.50** | Free/Go default: `gpt-5.6-luna` + same search, $0.20 / $1.20 → **~$0.70**. This is not a downgrade for Free users; it is what they actually see. |
| ChatGPT Free / Go Chat | GPT-5.6 Luna, auto web search | `gpt-5.6-luna` + `web_search` | $0.20 / $1.20. [Pricing](https://platform.openai.com/docs/pricing) | Same $10 / 1,000 calls + content tokens | **~$0.70** | `gpt-6-luna` ($0.10 / $0.50) is cheaper in the API but is not the named Free Chat default. |
| Perplexity Free (basic Search) | Basic Search (very limited Pro Search). Closest first-party model: Sonar | `perplexity/sonar` on the Agent API, with web search | $0.25 / $2.50. [Agent API Models](https://docs.perplexity.ai/docs/agent-api/models) | `web_search` $2.50 per 1,000 calls ($0.0025 each); Fast Search $1 per 1,000. [Pricing](https://docs.perplexity.ai/guides/pricing) | **~$0.26** | Same model is already the cheap first-party search model. Do not swap in a generic `effort: "fast"` Agent call — that may run a non-Sonar model (official examples have used other labs’ models). |
| Google AI Mode (all users); hardest AI Overviews; Gemini app Auto for many live questions | Gemini 4 Hydrogen (AI Mode default). Gemini app Auto may pick Hydrogen or a lightweight model | `gemini-4-hydrogen` + `google_search` on a **paid** key | $1.50 / $7.50, including thinking tokens. [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Hydrogen launch](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/) | Grounding not on free tier. Paid: 5,000 free searches/month, then $14 / 1,000. Daily cap 1,500 RPD. Grounding context not billed as input. | **~$1.07 after the free quota**, **~$0.23 inside it**. Higher if default “high” thinking emits many output tokens (see §4). | Code’s `gemini-3.8-flash` ($0.75 / $3.75 through 31 Dec 2026, then $1.50 / $7.50) is a previous Flash model, not the current consumer default. Officially Hydrogen is the upgrade from 3.8 Flash. |
| Claude.ai Free | Sonnet + Haiku available; Opus not included. Sonnet 5.5 is the current Sonnet anyone can use on Claude.ai, with web search | `claude-sonnet-5-5` + `web_search`, `max_uses: 2` | $2 / $10. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | $10 per 1,000 searches + search results billed as input tokens. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | **~$1.50** | `claude-haiku-5-5` ($0.10 / $0.50) is on the Free plan but is not the default daily model. Mid cost would be ~$0.65, almost all of it the search fee. |
| Claude.ai Pro / Max / Ultra / Team | Opus 5.5 (official default), web search, Medium effort | `claude-opus-5-5` + `web_search`, effort Medium | $4 / $20. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | Same $10 / 1,000 searches + tokens | **~$2.40 mid; ~$6.00 high** | Sonnet 5.5 (~$1.50) is the Free-plan match, not a fake stand-in. |

---

## 4. Cost math (today’s official prices)

**Call count (from code):** 30 prompts × 2 repeats = 60 calls per engine, 240 total.

**Token assumptions** (prompts are ~14 tokens; search content dominates):

| Band | Searches / call | Search-content input tokens | Output tokens (incl. thinking) |
|---|---:|---:|---:|
| Mid | 1 | 5,000 (OpenAI / Claude). Perplexity mid uses 2,000 in / 500 out, as in the code comment. Gemini grounding context is not charged as input. | 500 |
| High | 2 (Claude already allows `max_uses: 2`) | 10,000 | 1,000. For Hydrogen, also show a “high thinking” case of 3,000 output tokens, because the official default thinking level is **high**. |

Formula, per call:  
`search_fee × searches + (input_tokens × input_rate / 1e6) + (output_tokens × output_rate / 1e6)`.

### Recommended accuracy set (Plus ChatGPT + Free Perplexity + Hydrogen + Claude Sonnet)

| Engine | Mid per call | Mid × 60 | High per call | High × 60 |
|---|---:|---:|---:|---:|
| `gpt-6.2-sol` + search | $0.01 + (5000×$2/1M=$0.01) + (500×$10/1M=$0.005) = **$0.025** | **$1.50** | $0.02 + $0.02 + $0.010 = **$0.050** | **$3.00** |
| `perplexity/sonar` + 1–2 searches | $0.0025 + (2000×$0.25/1M=$0.0005) + (500×$2.50/1M=$0.00125) = **$0.00425** | **$0.26** | $0.005 + $0.0005 + $0.0025 ≈ **$0.008** | **$0.48** |
| `gemini-4-hydrogen` + grounding | After quota: $0.014 + (500×$7.50/1M=$0.00375) = **$0.018**. Inside 5,000 free: **~$0.004** | **$1.07** after quota; **$0.23** inside | 2 searches + 3,000 thinking out: $0.028 + $0.0225 = **$0.0505** | **$3.03** |
| `claude-sonnet-5-5` + search | $0.01 + (5000×$2/1M=$0.01) + (500×$10/1M=$0.005) = **$0.025** | **$1.50** | $0.02 + $0.02 + $0.010 = **$0.050** | **$3.00** |
| **Order total** | | **~$4.33** after Gemini quota (**~$3.49** inside it) | | **~$9.51** in the high-thinking case |

The current order cap is **$8.00** (`DEFAULT_CAP_USD` in `order.py` line 31). Mid fits. The high-thinking case **does not**. See the cap recommendation in §5.

### If the Claude column uses the Pro default (Opus 5.5)

- Mid: $0.01 + (5000×$4/1M=$0.02) + (500×$20/1M=$0.01) = **$0.04 × 60 = $2.40**
- High (2 searches, 10k in, 2,000 out): $0.02 + $0.04 + $0.04 = **$0.10 × 60 = $6.00**
- Order total with Sol + Sonar + Hydrogen + Opus: mid **~$5.23**, high **~$12.50** — the high case overshoots an $8 cap by a wide margin.

### Code’s current cheap set, repriced (for contrast only)

These are **not** the consumer defaults.

| Engine in code | Mid × 60 at today’s prices | Notes |
|---|---:|---|
| `gpt-5-mini` + search | ~$0.74 | Shuts down 11 Dec 2026. |
| `sonar` + search | ~$0.26 | This one *is* the right Perplexity match. |
| `gemini-3.8-flash` + grounding | ~$0.96 after quota (code’s own estimate) | Previous Flash, not Hydrogen. |
| `claude-haiku-4-5` + search | ~$1.20 (code estimate) | Legacy. Haiku 5.5 would be ~$0.65. |

The mock figure of $5.88 was dominated by the old $0.058 OpenAI estimate from chat-latest, not by `gpt-5-mini`.

---

## 5. Recommendation (accuracy first, then cost)

Keep all four engines. The product is “what four assistants say.” Dropping one would make the report less true, not just cheaper.

**Recommended production set:**

1. **ChatGPT column: `gpt-6.2-sol` + `web_search` + US `user_location`.** This matches the Plus/Pro Chat default rolling out now, and official notes say GPT-6.2 is better at web answers. Most ChatGPT users are on Free (Luna). Say that clearly in the report, and add a Luna pass later if we want both audiences. Do not ship `gpt-5-mini`.
2. **Perplexity column: `perplexity/sonar` on the Agent API, with web search on.** This is the first-party grounded search model and the right match for Free basic Search. Do not use a bare `effort: "fast"` call that may pick another lab’s model.
3. **Google column: `gemini-4-hydrogen` + `google_search`, on a new paid AI Studio key.** This matches AI Mode and the Gemini app’s Auto path for live questions. Set thinking explicitly (see DOM list). Do not reuse the free domain-trading Gemini key.
4. **Claude column: `claude-sonnet-5-5` + `web_search` (`max_uses: 2`).** This is what Free users, and anyone on Claude.ai, can actually use. **Opus 5.5** is the official Pro default and is the better match for paid Claude users, but mid+high cost can break the $8 cap. Offer Opus as an optional Pro-matched mode, not the first ship.

**Expected cost, recommended set:** about **$3.50–$4.30 per $149 order** in the mid band (Gemini still inside / just after the monthly free grounding quota). Budget **up to about $9.50** if Hydrogen thinks hard and both OpenAI and Claude search twice. Until a live `usage` log exists, treat these as estimates.

**Cap:** raise `DEFAULT_CAP_USD` from $8 to **$12**, so a high-thinking Hydrogen run does not abort a paid order. Keep the per-order `BudgetGuard`.

**Do not** make Haiku, `gpt-5-mini`, or `gemini-3.8-flash` the production defaults. They are fine as a labelled “cheaper contrast” or as Free-tier footnotes (Luna, Haiku), not as stand-ins for what Plus / AI Mode / Claude.ai show.

---

## 6. Code changes for DOM

1. Change `OpenAIWebSearchProvider.default_model` from `gpt-5-mini` to `gpt-6.2-sol`. Keep Responses API + `web_search` + `user_location`. Do not leave `gpt-5-mini` as a fallback after 11 Dec 2026.
2. Optional, later: a second ChatGPT pass with `gpt-5.6-luna` so the report can show Free vs Plus. Not required for the first paid ship.
3. Migrate `PerplexityProvider` from `POST https://api.perplexity.ai/chat/completions` with `model: "sonar"` to the Agent API (`POST https://api.perplexity.ai/v1/agent` or the official SDK `responses.create`), with **`model: "perplexity/sonar"`** and web search enabled. Parse the new `output` / `search_results` shape (not only `choices[].message` and top-level `citations`). Official: Chat Completions support ended 27 Sep 2026; sync traffic is being rewritten. [Migration](https://docs.perplexity.ai/docs/sonar/models).
4. Change `GeminiGroundedProvider.default_model` from `gemini-3.8-flash` to `gemini-4-hydrogen`. Keep `google_search`. Set thinking explicitly (recommend `medium` for local-business questions, or `high` if we want the official API default — but `high` is what blows the high-end cost). Fail clearly if the key is on the free tier (grounding will not run).
5. Change `ClaudeWebSearchProvider.default_model` from `claude-haiku-4-5` to `claude-sonnet-5-5`. Keep `web_search` and `max_uses: 2`. Add `user_location` if the tool allows it. Optionally support `claude-opus-5-5` behind a flag for a Pro-matched mode. If upgrading the tool type past `web_search_20250305`, follow current docs (`allowed_callers` may be required). [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).
6. Replace `PAID_COST_PER_CALL` with mid estimates for the new models, for example: OpenAI 0.025, Perplexity 0.004, Gemini 0.018 (after quota), Claude Sonnet 0.025. Keep comments dated and linked.
7. Raise `DEFAULT_CAP_USD` from 8.00 to **12.00**.
8. After the first real paid run, persist actual `usage` (tokens, search counts, billed cost) into the order log, and revise the estimates from those numbers — not from another mock.

---

## 7. Account and key setup (no keys in this file)

Nothing below has been created. Dvir’s yes is still required before any sign-up, card, or prepaid credit. Suggested first load is enough for a few real orders plus a safety margin, not a large prepay.

### OpenAI — env `OPENAI_API_KEY`

- Sign-up: email at [platform.openai.com](https://platform.openai.com).
- **SMS or WhatsApp is required for the first API key.** Codes are not sent by email or phone call. Israel is on the WhatsApp list. Landlines, VoIP, and Google Voice are not accepted.  
  Source: [What does phone verification look like?](https://help.openai.com/en/articles/8983040-what-does-phone-verification-look-like).
- **Card + prepaid credits: Dvir must do this.** New API accounts use prepaid billing. Minimum purchase **$5**, default **$10**. Auto-reload is on by default during setup; turn it off or set a monthly reload limit if we want a hard ceiling on automatic top-ups. Credits expire after one year (180 days for purchases in Japan after 13 Nov 2026).  
  Source: [Setting up prepaid API billing](https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing).
- Create the key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
- **Monthly spend cap:** yes. Organization: [Organization limits](https://platform.openai.com/settings/organization/limits) → Spend → Edit spend limit → turn on **Enforce a hard limit**. Or the same under a project’s Limits. Hard limits return `429` (`organization_spend_limit_exceeded` / `project_spend_limit_exceeded`). Enforcement is not instant; spend can slightly overshoot.  
  Source: [Spend limits](https://developers.openai.com/api/docs/guides/spend-limits).
- Suggested start: $10 prepaid, hard monthly cap **$50**, auto-reload off or limited.

### Perplexity — env `PERPLEXITY_API_KEY`

- Sign-up: a Perplexity account at [perplexity.ai](https://www.perplexity.ai), then the API portal at [console.perplexity.ai](https://console.perplexity.ai).
- Official docs require a **credit card** for billing setup; “you won’t be charged initially.” Billing is **prepaid credits**. Auto-reload is recommended; if the balance hits zero, keys are blocked. A Pro/Max subscription does **not** include API credits. Some new accounts get a short-lived sign-up credit, but “sign-up credits alone do not unlock the Agent API.”  
  Source: [Projects & Billing](https://docs.perplexity.ai/docs/getting-started/api-groups).
- **Card and first credit purchase: Dvir must do this.** Phone/SMS is not mentioned in the official API setup docs.
- Create the key in the console under **API keys** → Generate API Key. Keys are shown once.
- **Monthly spend cap:** no separate hard cap was found in official docs. The practical cap is the prepaid balance, plus turning auto-reload off or keeping it small.
- Suggested start: buy a modest credit balance (enough for several $149 orders; mid Perplexity cost is only ~$0.26/order), auto-reload off until we trust the pipeline.

### Google Gemini — env `GEMINI_API_KEY`

- Sign-up: Google account, then [Google AI Studio API keys](https://aistudio.google.com/apikey).
- **Paid tier is required for Search grounding.** Upgrade: Set up billing in AI Studio, link a billing account, **prepay a minimum of $5**. New users default to Prepay. When the Prepay balance hits $0, all keys on that billing account stop (HTTP 402). Unused credits expire after 12 months. There is ~10 minutes of pipeline delay, so a small overshoot is possible.  
  Source: [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing).
- **Card and $5+ prepay: Dvir must do this.** Phone/SMS is not the standard published step; some projects “need verification.”
- Create a **new** project and key for AVC. Do not reuse the free domain-trading key (no billing, grounding unavailable, and it is tied to another product).
- **Monthly spend cap:** yes. In AI Studio, **Spend** page → **Monthly spend cap** → **Edit spend cap** (project editor/owner/admin). Experimental; ~10 minute overshoot possible. Separate from the billing-account tier cap (Tier 1 is $250/month until the account graduates).  
  Sources: [Billing — Spend caps](https://ai.google.dev/gemini-api/docs/billing); [Project Spend Caps announcement](https://blog.google/innovation-and-ai/technology/developers-tools/more-control-over-gemini-api-costs/).
- Also note the **1,500 grounding requests/day** cap on the Developer API. At 60 Gemini calls per order, that is about **25 orders/day** if each call is one request. Volume above that needs Vertex or a quota increase.
- Suggested start: $10 prepay, project spend cap **$50**, auto-reload off or tightly limited.

### Anthropic Claude — env `ANTHROPIC_API_KEY`

- Sign-up: [platform.claude.com](https://platform.claude.com).
- **SMS is required to create a Claude account.** Supported mobile numbers only; no VoIP, Google Voice, or landlines.  
  Source: [Verify your phone number](https://support.claude.com/en/articles/8287232-verify-your-phone-number).
- **Prepaid credits + card: Dvir must do this.** “Buy credits before you use the API.” Billing page: [platform.claude.com/settings/billing](https://platform.claude.com/settings/billing). Credits expire one year from purchase and are non-refundable. Auto-reload is available. Official docs do not state a minimum purchase amount here, so Dvir should pick the amount (enough for a few orders; Sonnet mid is ~$1.50/order, Opus mid ~$2.40).  
  Source: [How do I pay for my Claude API usage?](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage).
- Create the key at [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys). Prefer a **service account** or workspace-scoped key for production, not a personal key. The secret is shown once (`sk-ant-…`).
- **Monthly spend cap:** yes. [Spend limits](https://platform.claude.com/settings/spend-limits) → Workspace limits → choose the workspace → **Set limit / Adjust limit** next to **Monthly spend limit**. Create an AVC workspace rather than relying only on the Default Workspace. Prepaid balance is a second hard stop.  
  Source: [Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces).
- Suggested start: buy a modest credit balance, workspace monthly cap **$50**, auto-reload off or limited.

### After keys exist (Gavriel / DOM, still no values in chat or git)

Set the four env vars and `AIVIS_ALLOW_PAID=1` only on the AVC Render service, as secrets. Run one cheap live probe, then one full paid-order path, and record actual `usage`. Do not print key values.

---

## 8. What only Dvir must do

| Provider | Dvir must personally | Suggested first money | Hard cap to set |
|---|---|---|---|
| OpenAI | Account, **SMS/WhatsApp**, **card**, $5–$10 prepaid, first API key, hard spend limit | $10 | $50 / month, hard limit on |
| Perplexity | Account, **card**, first credit purchase, API key | Small credit pack (pipeline is cheap per order) | Prepaid balance; auto-reload off or small |
| Google | New AI Studio project, **card**, **$5+ prepay**, paid-tier key, project spend cap | $10 | $50 / month project cap |
| Anthropic | Account, **SMS**, **card**, credit purchase, key, workspace spend limit | Credits for a few orders (~$1.50–$2.40 each) | $50 / month on an AVC workspace |

No accounts were opened in this research. The monthly Polar plan still waits until the paid report passes a clean re-test.

---

## 9. Sources (official, checked 26 Nov 2026)

- OpenAI pricing: https://platform.openai.com/docs/pricing
- OpenAI deprecations: https://platform.openai.com/docs/deprecations
- OpenAI web search (API): https://platform.openai.com/docs/guides/tools-web-search
- OpenAI spend limits: https://developers.openai.com/api/docs/guides/spend-limits
- OpenAI prepaid billing: https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing
- OpenAI phone verification: https://help.openai.com/en/articles/8983040-what-does-phone-verification-look-like
- ChatGPT models: https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt
- ChatGPT release notes (GPT-6.2, 23 Nov 2026): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- ChatGPT web search: https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt
- GPT-6.2 API prices: https://openai.com/index/introducing-gpt-6-2-astra-sol/
- Perplexity pricing: https://docs.perplexity.ai/guides/pricing
- Perplexity Agent API models: https://docs.perplexity.ai/docs/agent-api/models
- Perplexity Sonar / Agent migration: https://docs.perplexity.ai/docs/sonar/models
- Perplexity projects & billing: https://docs.perplexity.ai/docs/getting-started/api-groups
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini billing and spend caps: https://ai.google.dev/gemini-api/docs/billing
- Gemini 4 Hydrogen launch and $1.50/$7.50: https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/
- Gemini app models / Auto: https://support.google.com/gemini/answer/18648722?hl=en
- Claude API pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Claude.ai plans (Opus not on Free; web search on all): https://claude.com/pricing
- Claude Opus 5.5 is the Pro+ default: https://claude.com/resources/articles/using-claude-opus-5-5-as-your-daily-driver-for-knowledge-work
- Claude Sonnet 5.5 on Claude.ai: https://www.anthropic.com/claude/sonnet
- Claude web search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Claude keys: https://platform.claude.com/docs/en/get-api-key
- Claude prepaid billing: https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage
- Claude phone verification: https://support.claude.com/en/articles/8287232-verify-your-phone-number
- Claude workspace spend limits: https://platform.claude.com/docs/en/manage-claude/workspaces
