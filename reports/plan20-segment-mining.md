# Plan20 settled segment mining

Read-only snapshot: /tmp/settled-snapshot.db; 4760 rows, 4760 valid paper orders. Earliest 3332 train; latest 1428 holdout; boundary 2026-10-14T14:21:07.748Z. Stable ordering: settled_at_iso then id.

Inspected all columns and JSON fields. Features: source plan, category (explicit JSON when present, otherwise plan family; Plan15 symbol supplies category), price bands, recorded direction, timeframe, resolution horizon, normalized symbol, four-hour UTC entry bucket. Creation milliseconds embedded in order IDs supply entry time, with slot fallback. Unknown values remain explicit. Plan15/16/17 record direction=event, so yes/no cannot be recovered and is not invented. No outcome/settlement information is used as an entry feature.

Fees: src/fees.js reexports Robinhood fees, not Polymarket fees. Polymarket entry handling in polymarketTrading.js applyPaperEntryTakerFee reduces shares by the fee; settlement pnl is payout minus original usd; early exits use net proceeds. Stored pnl therefore already nets fees; no second subtraction. ROI=sum(pnl)/sum(usd), winrate=mean(won).

Search on TRAIN only: all single features and pairs, n>=30; positive ROI and per-order return t>2 nominate the complete shortlist below. 281 eligible tests. A conservative train t>=4 multiplicity guard is fixed before holdout evaluation; this is a heuristic, not a formal family-wise guarantee. Holdout requires n>=10 and positive ROI. Overlapping segments, shared market outcomes, short history and exploratory multiple comparisons weaken independent-trade t statistics; surviving rules would need forward paper validation. Holdout selection itself also introduces selection bias.

Plan18/19 directions are divination/random controls: side-dependent results from these sources are suspect and cannot establish a predictive signal. Categories inferred from plans are proxies, not authoritative catalog metadata.

| Rule | Train n / ROI / winrate | Train t | Holdout n / ROI / winrate | Decision |
|---|---|---|---|---|
| {"plan_id":"plan18","price":".20-.35"} | 179 / 47.54% / 40.2% | 2.70 | 86 / -15.51% / 27.9% | fails conservative train multiplicity guard |
| {"price":".20-.35","symbol":"XRP"} | 82 / 52.42% / 43.9% | 2.41 | 41 / -8.37% / 26.8% | fails conservative train multiplicity guard |
| {"price":".20-.35","direction":"up"} | 214 / 39.08% / 38.3% | 2.55 | 85 / 9.71% / 36.5% | fails conservative train multiplicity guard |
| {"plan_id":"plan19","hour":"4-8"} | 281 / 25.67% / 59.1% | 2.77 | 168 / -50.74% / 23.2% | fails conservative train multiplicity guard |
| {"direction":"down","hour":"8-12"} | 240 / 23.80% / 59.6% | 2.14 | 76 / 12.13% / 55.3% | fails conservative train multiplicity guard |
| {"price":".20-.35","hour":"12-16"} | 54 / 73.93% / 50.0% | 3.05 | 26 / 52.00% / 46.2% | fails conservative train multiplicity guard |

0 surviving rules. Plan20 trades nothing: disabled by default and an empty-rule no-op.

Runtime policy: generated src/plan20SegmentRules.js is the only approved rule source. With no survivors there are no discovery sources to scan or entry adapters to run. Plan20 is registered in paper state, inventory, view and scan dispatch; generic paper entry is gated by the empty rules. Live scheduling, manual live enablement, service live entry and direct live buy submission all reject Plan20. Future nonempty mining results require reviewed entry adapters; re-mining alone cannot start trading. Defaults reserve $500 capital and $2 stake with cash-floor, trade/exposure and open-count sizing caps. Plan18/19 selectors are unchanged.
