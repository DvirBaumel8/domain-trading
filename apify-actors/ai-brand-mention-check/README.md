# AI Brand Mention Check: ChatGPT, Gemini & Claude

Is your brand named when people ask AI? The Actor asks ChatGPT, Gemini and Claude buyer-style questions through their official APIs, with web search on, and tells you per question and engine whether your brand appears, at which rank, and who else is named. Export the dataset as CSV, Excel or JSON.

**Returns** one row per question and engine: `brand`, `engine`, `prompt`, `status`, `mentioned`, `mentionType`, `rank`, `listLength`, `snippet`, `competitors`, `brandCited`, `citedUrls`, `searchUsed`, `sentiment`, `answerText`, `errorCode`, `checkedAt`. A SUMMARY record in the key-value store holds the mention rate and average rank per engine and the top competitors.

**Cost:** pay per result. An answer that came back is a result; error rows are not charged. See the Pricing tab for current prices.

```json
{ "brand": "Asana", "domain": "asana.com", "category": "project management software", "promptCount": 3, "engines": ["chatgpt", "gemini", "claude"], "includeAnswerText": true }
```

## What it is, and what it is not

This is a fast sampling check. It asks small, low-cost models through their APIs, one answer per question. API answers differ from the consumer apps (the ChatGPT, Gemini and Claude that people open in a browser or on a phone), and the same question can get a different answer on another run. Use it to see patterns across many questions and engines, not to prove what one person would see.

## How a row is decided

- **Questions.** Give your own in `prompts` (up to 20), or give a `category` and the Actor asks the first `promptCount` of eight fixed buyer-style questions, for example "Which project management software would you recommend?". Add a `location` to ask for a place; ChatGPT and Claude also get it as the approximate search location.
- **Mentioned yes or no** is plain text matching, never an AI. A name matches on whole words, in any letter case, when it has several words, a digit, a dot or a hyphen, or is not an everyday English word. A name that is also an everyday word (such as Linear, Notion or Apple) counts only when it is written exactly as you typed it and stands in a list item, bold text, heading or table cell, or when your `domain` appears in the answer or in a cited URL. "A linear workflow" is not Linear.
- **Rank and competitors** are read from the answer by a small model that treats the answer as data only. Every name it returns must appear in the answer text, and it can never change `mentioned`. If that call fails, a simple list parser is used instead and the row says `extraction: heuristic`.
- **Sentiment** is an AI judgement of the tone toward your brand, not a measurement. It is empty when the brand is not mentioned.
- **Web search.** `searchUsed` tells you whether the engine searched. Answers without a search are counted in the summary warnings.
- **`brandCited`** is true when a cited URL is on your domain or one of its subdomains.

## Limits

- Up to 60 rows per run (20 questions on 3 engines). A run on the free plan covers a small number of rows; the final message says how many were not run.
- Each engine gets at most 2 requests at a time, each request has a 60 second limit, and a timeout, a rate limit or a server error is tried once more.
- An engine can be switched off on the server; its rows then carry `engine_not_configured`.
- Not included: Perplexity, Grok, Copilot, Google AI Overviews, repeated asks of the same question, history, and your own provider keys.

## Error codes

| `errorCode` | Meaning |
|---|---|
| `timeout` | No answer within 60 seconds, after one retry |
| `rate_limited` | The provider asked for fewer requests, after one retry |
| `quota_exhausted` | The provider reports that its quota or credit is used up |
| `provider_error` | Another provider failure; no provider text is stored |
| `engine_not_configured` | The engine is switched off or has no key on the server |
| `budget_cap` | The spend guard for the run was reached |
| `charge_limit` | Your maximum charge for the run was reached |

If every row fails the run is marked failed and nothing is charged. If one engine fails and the others work, the run succeeds and the final message names the failed engine and the error.

## Other Actors by the same author

- Sitemap URL Extractor: every page URL from a website's sitemaps.
- Cold-Email List Pre-Check: SPF, DKIM, DMARC and MX for many domains.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. The provider keys it uses come from the Actor's environment; they are not an Apify permission and never appear in the results.
