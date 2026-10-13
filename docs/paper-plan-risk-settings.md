Paper plan risk settings
=======================

Plan15 applies these caps inside `createPlan15PaperOrder`, including manual
orders and scanner orders. Values are fractions of the portfolio's starting
bankroll, not percentages of remaining cash:

| Environment variable | Default | $500 bankroll |
| --- | --- | --- |
| `POLYMARKET_PLAN15_MAX_TRADE_BANKROLL_PCT` | `0.05` | $25 per trade |
| `POLYMARKET_PLAN15_MAX_OPEN_EXPOSURE_BANKROLL_PCT` | `0.30` | $150 total open cost |

Orders are reduced to available capacity and rounded down to cents. Settled
orders release exposure. Zero disables new orders through that cap; invalid
values or fractions outside 0–1 use the safe default. Existing positions are
not liquidated when caps change. These settings do not enable live trading.

`GET /api/polymarket/paper-plans` without a plan selector returns a `plans`
object keyed by active plan IDs (14–19), omitting explicitly disabled plans.
Each plan includes `newEntriesEnabled` and `liveTradingEnabled`. These plans
are paper-only, so their live flag is false. Requests with `plan` or `planId`
retain the individual plan view and include both flags at the top level.

Plan16 requests GFS seamless ensembles, retries once after 250 ms, then tries
ECMWF IFS 0.25° after 500 ms. Each request has a 12-second timeout. Successful
forecasts are cached for 20 minutes; on request failure, the last good forecast
may be used for up to six hours from its original timestamp. Original forecast
dates are preserved, and empty member data is rejected. The cache is in memory.
