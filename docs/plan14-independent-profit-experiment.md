# Independent Plan14 paper experiment

`POLYMARKET_PLAN14_PROFIT_EXPERIMENT_ENABLED=true` enables experiment scanning even when main Plan14 auto or new entries are off. `false` disables new experiment entries. When omitted, it defaults to on (paper-only), independent of `POLYMARKET_PLAN14_NEW_ENTRIES_ENABLED`. Main entries retain their existing gates. No live trading settings change.

The experiment has its own persisted `plan14ProfitExperimentAuto.enabled` state, exposed as `profitExperimentAuto` in Plan14 status. POST `/api/polymarket/plan14/profit-experiment/auto` with `{ "enabled": true }` or `{ "enabled": false }` changes that state independently of main auto. Persisted state takes precedence over the environment initialization value. Disabling entries does not stop official settlement of existing experiment orders.

Each baseline/candidate and stress entry triggers a matched `*Control` ledger entry in the same market for the same $10 stake and execution penalties. Controls randomly select uniformly among up/down sides with sufficient real ask depth in the policy entry's 10-cent band (determined by its first consumed ask). Only depth in that band is used. If only one side qualifies, that side is selected; if neither qualifies or control cash is insufficient, the control records a skip. Controls have independent $500 cash and use the same official outcome and redemption delay. Entries carry `pairedOrderId`; no control can debit the main account.

`observePlan14ProfitExperiment` accepts an optional seventh argument, an RNG function returning a number in `[0, 1)`. Supply a seeded generator for reproducible tests; the default is `Math.random`.

Summary `byDate` (UTC entry day) and `byEvent` (market slug) contain per-lane filled, settled, pending, wins, invested and realized PnL totals. These persisted totals survive truncation of recent settlements. Old saved ledgers can recover only open orders and retained settlements; summaries identify that limitation with `blockHistoryNote`.
