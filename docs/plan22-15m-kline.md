# Plan22：15 分钟 K 线综合（只做纸面）

监控里的「15m 综合 10-15m 阶段准确率」来自 `predictionRecorder` 的阶段综合，不是一笔可下的单。权重是：

| 阶段 | 窗口 | Binance K 线权重 |
| --- | --- | --- |
| phase1 | 0–5 分钟 | 0.05 |
| phase2 | 5–10 分钟 | 0.35 |
| phase3 | 10–15 分钟 | 0.50 |

前一根 15 分钟 K 线涨跌在 0.3%–0.5% 时，还有和记录器相同的反转修正。仓库里没有历史 `window_locks` 库，不能在这里重算那一行准确率。代码里能核对的是：Plan11 注释写过 5 分钟锁价上综合 64%、技术面 53%、PM 70%；Plan1 的 15 分钟账是亏的（约 −$43）。按中间价买综合方向，再扣 crypto taker fee（`费率 × 价格 × (1 − 价格)`），期望是负的。

Plan22 只在扣费之后仍然便宜时买。

- 只做 15 分钟涨跌，默认 BTC、ETH。
- 只在开盘后 5–12 分钟。0–5 分钟技术面权重太低；最后 3 分钟盘口通常已经跟上。
- Binance 现货相对本根 15 分钟开盘价的方向必须和综合方向一致，距离默认至少 8 bps，报价年龄默认不超过 15 秒。
- 综合概率要高于该侧中间价，并且 `概率 − 卖一 − 每股手续费` 默认至少 0.02。卖一默认在 42–72¢，价差默认不超过 4¢。
- 每个盘只买一次，固定金额（默认 $5），持有到官方结算，不设提前止盈止损。
- 独立账本：`startingCash` 默认 $500，现金、订单、已实现盈亏都在 `plan22`，不进 Plan21。

`POLYMARKET_PLAN22_RANDOM_CONTROL=true` 时，每笔成交额外记下一个由市场 slug 散列出来的随机方向，结算时只算假设盈亏，写进报表，不扣现金。这不是 Plan18 / Plan19。

短样本（现货已锁定、卖一还停在 48¢、21/30 次方向正确）扣费后盈利，随机对照更差。0–5 分钟、卖一已经到 70¢、价差宽、现货过期、现货反向都不下单。跑：

```bash
node scripts/backtest-plan22-kline.mjs
node --test test/polymarketPlan22.test.js
```

这只说明门槛在构造样本上扣费后为正，不表示已经在实盘历史里赚到钱。

## 和 Plan1、Plan21

| | Plan1（已停） | Plan21 | Plan22 |
| --- | --- | --- | --- |
| 市场 | 5m 和 15m | 只 5m | 只 15m |
| 信号 | 综合方向，宽时间窗 | 落后方的三个价格格 | 同一套 15m 综合，外加锁价和扣费错价 |
| 退出 | 止盈 / 止损 | 持有到结算 | 持有到结算 |
| 实盘 | 已从自动列表拿掉 | 禁止 | 禁止，没有实盘开关 |

## 打开 Plan22

默认关。打开后才会建 $500 纸面本金、打开自动，并允许新仓。实盘开关保持 `POLYMARKET_LIVE_TRADING_ENABLED=false`。即使把它设成 true，Plan22 的实盘入口也会拒绝。

```bash
POLYMARKET_LIVE_TRADING_ENABLED=false
POLYMARKET_PLAN22_ENABLED=true
```

暂停新仓但保留账本：`POLYMARKET_PLAN22_NEW_ENTRIES_ENABLED=false`。关掉整个计划：去掉 `POLYMARKET_PLAN22_ENABLED` 或设成非 `true`。已有订单继续等官方结算。

现货报价年龄用下单判断那一刻的时钟来算。以前扫描先记下 `Date.now()` 再去拉 Binance，报价戳比这个时钟更晚，`quoteMs > now` 被一律记成 `spot_age`，新鲜报价也下不了单。现在判断时重取时钟。报价最多超前 5 秒（`POLYMARKET_PLAN22_MAX_SPOT_CLOCK_SKEW_MS`）仍算新鲜；超前更多，或确实旧于 `POLYMARKET_PLAN22_MAX_SPOT_AGE_MS`，还是 `spot_age`。

## 关掉 Plan17 / Plan19 / Plan20

2026-10-18 之后 Plan17 和 Plan19 默认就不在活跃纸面里。Plan18 留着做随机对照，不要放进下面这组。Plan20 维持关闭，不要为了成交去放宽 `.20-.35` / `12-16`。

```bash
POLYMARKET_PLAN17_ENABLED=false
POLYMARKET_PLAN19_ENABLED=false
POLYMARKET_PLAN20_ENABLED=false
POLYMARKET_PLAN18_ENABLED=true
```

或者一次列出来（这三项仍可被这份名单关掉；Plan18 只有你明确写上才停）：

```bash
POLYMARKET_PAPER_DISABLED_PLANS=plan17,plan19,plan20
```

停自动不会清 `paperOrders`，也不会改 `startingCash`。
