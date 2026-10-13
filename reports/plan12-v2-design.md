# Plan12 v2 — Spot Fair-Value Residual

## Status

Paper-only forward experiment. Live scheduling and live plan construction both reject Plan12.

Version: `plan12_spot_fair_value_residual_v2`

The former `XRP 5m DOWN 60–70c` rule is retired. Old v1 orders are excluded from v2 promotion statistics.

## Decision model

For each enabled symbol and 5m/15m window:

1. Read the Binance spot price, window-open price, realized return volatility, and seconds remaining.
2. Estimate the probability of finishing above the window open with a driftless log-return model.
3. Inflate volatility by 1.25 and shrink the resulting probability 30% toward 50/50 to reduce overconfidence.
4. Read both Polymarket CLOB best asks. Midpoint, Gamma probability, PM favorite, PM gap, and PM lock direction cannot trigger a trade.
5. Add one tick of slippage and the crypto taker fee to each side's cost.
6. Select the side with the larger fair-value residual only when the residual is at least 4 percentage points. Otherwise hold cash.

This mechanism is symmetric: the same equations and thresholds apply to UP and DOWN and to BTC, ETH, SOL, and XRP.

## Safety gates

- Binance quote age ≤15 seconds.
- Entry only from 20% through 80% of the window.
- Both UP and DOWN real best asks must exist.
- Combined best ask ≤1.08.
- Estimated fair probability must be at least 8pp away from 50/50.
- Execution price after slippage must be 12–88c.
- Quarter-Kelly sizing capped at 1% of paper cash and $5 per order, with the real 5-share floor.
- Hold to official settlement; no unvalidated intrawindow TP/SL is simulated.

## Forward promotion audit

The audit requires all of the following for v2 orders only:

- 500 settled trades across at least 30 days.
- At least 100 UP and 100 DOWN trades.
- At least three symbols with 50 trades each.
- Positive total PnL and positive recent-half mean ROI.
- 95% lower confidence bound of per-trade ROI above zero.
- At least 55% profitable days.
- Maximum drawdown no more than $50.

Passing the audit does not automatically enable live trading; a separate reviewed implementation would still be required.
