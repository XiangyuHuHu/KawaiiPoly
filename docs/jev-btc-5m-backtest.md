# Jev 风格 BTC 5 分钟纸面回测

这是只读研究。脚本读取本地已经记下的 Plan14 机会磁带，按规则计算纸面盈亏。它不下单，不改实盘开关，也不读取交易私钥。

## 怎么跑

在仓库根目录：

```bash
node scripts/backtest-jev-btc-5m.mjs --date 2026-10-16
```

等价命令：`npm run backtest:jev-btc-5m`。默认日期就是 2026-10-16，默认目录是 `data/polymarket/plan14-research`。

常用参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--date` | `2026-10-16` | 同时出美国太平洋时间和 UTC 两个日历日 |
| `--dir` | `data/polymarket/plan14-research` | 研究 JSONL 目录 |
| `--min-edge` | `0.01` | 扣费后优势门槛（0.01 = 1 个百分点） |
| `--fee-rate` | `0.07` | 加密货币 taker 费率曲线参数，不是每笔固定收 7% |
| `--model-weight` | `0.23` | 现货模型相对盘口中间价的混合权重，与 Plan14 5m 默认相同 |
| `--stake` | `10` | 每笔名义美元 |
| `--starting-cash` | `500` | 回撤用的起始现金 |
| `--min-remaining` / `--max-remaining` | `30` / `270` | 距窗口结束的秒数。跳过开盘前 30 秒和最后 30 秒 |
| `--bucket` | `0.1` | 随机对照的卖一档宽，10¢ |
| `--seed` | `20261016` | 对照用的固定随机种子 |
| `--no-fetch` | 关闭 | 不补拉 Gamma 官方结果 |
| `--no-spot-fallback` | 关闭 | 没有官方结果时，不用 Binance 5m 开盘到收盘代替 |
| `--json` | 关闭 | 打印 JSON，不打印中文摘要 |

`data/` 在 `.gitignore` 里。没有 `2026-10-16-opportunities.jsonl`（以及前后各一天，用来盖住太平洋时间和 UTC 的跨日）时，命令会退出并说明缺哪份磁带，不会编造成交。

## 规则

每条机会行先还原当时的状态：现货、窗口开盘价、波动率、距离结束的秒数，以及 Up/Down 的买一卖一。

1. 用仓库里的 `estimatePlan14SpotUp` 计算漂移为零的正态 P(现货收盘不低于开盘)。波动率按窗口剩余时间缩放。
2. 盘口 Up 概率取双边中间价：`(upMid + (1 - downMid)) / 2`。
3. 用 `blendPlan14Up` 把两者按权重混合。现货输入不全时，才退回档案里已经写好的 `model.spotUp`，摘要里的概率来源会标成 `logged-spot`。
4. 某一侧的扣费成本是 `ask / (1 - feeRate * (1 - ask))`，也就是花掉名义金额后、手续费以份额扣除、到期能兑付的每一份净成本。优势 = 模型概率 − 这个成本。
5. 两边里优势更高、并且不低于 `--min-edge` 的那一侧成交。点差宽于 5¢、卖一超出 5–95¢、或报价时间戳老于 10 秒的一边不买。
6. 每个 5 分钟窗口只保留时间上第一次达标的报价，假定整笔按该侧卖一成交。
7. 官方结果为买中的方向时，每份净份额兑付 $1，否则 $0。毛损益按不扣费的份额计算，净损益用扣费后的份额。费用拖累 = 毛损益 − 净损益，只出现在买中的单上，因为手续费是从份额里扣的。

随机对照有两个，种子都固定：

- 同卖一档：跟 Plan14 盈利实验一样，只在卖一落在同一档（默认 10¢）的方向里抽。Up 和 Down 的卖一通常不在同一档，这时对照被迫买策略那一侧，摘要里单独计数。
- 同报价随机方向：在同一条报价的两侧里抛硬币，按被抽中一侧的卖一成交。这个对照不要求同一档。

最大回撤走的是现金加未结算成本。仓位在结算前仍按成本计，亏损在结算时进入回撤。上一笔结算还没把现金释放出来、或者已经亏到不够名义金额时，后面的窗口只记一次 `cash` 跳过，不借款。缺官方结果的窗口不记成亏损，名义金额在窗口结束时退回现金。

## 磁带字段

归档代码写在 `recordPlan14Opportunity`。一行大致是：

- `observedAtIso`、`symbol`、`timeframe`、`slotIso`、`targetTimeIso`、`marketSlug`
- `model.marketUp`、`model.spotUp`、`model.freshBook`
- `model.inputs.spot`、`open`、`volatility`、`secondsRemaining`、`slotSeconds`、`quoteTimeMs`
- `model.bookTimeMs.up` / `down`
- `candidates[]`：`direction`、`ask`、`bid`、`spread`

回测只收 `symbol === 'BTC-USD'` 且 `timeframe === '5m'`。跑完会打印这些字段实际有多少行，用来核对档案是不是这套结构。

结算优先读同目录的 `*-settlements.jsonl` 和 `*-experiments.jsonl`。只有 `settlementPriceSource` 或 `priceSource` 为 `polymarket-official`、且 `actualDirection` 为 `up`/`down` 的 BTC 5m 记录才算官方。同一市场两个官方方向冲突时，该窗口不记盈亏。

官方结果不够时，脚本会用公开 Gamma 接口按 `marketSlug` 补拉。仍然没有时，才用 `PublicMarketDataClient.getWindowPrices('BTC-USD', '5m', targetTimeIso)`：收盘价大于等于开盘价记为 Up。这是 Binance K 线，不是 Polymarket 使用的 Chainlink 结算价，摘要里单独计成 `binance-5m`。

## 数据假设

采样报价不是完整订单簿。大约几秒一条，看不到深度、排队和从报价到成交的延迟。纸面结果假定卖一能全额吃到，所以不能当成实盘可成交证明。

太平洋时间 2026-10-16 会伸进 UTC 的 10 月 17 日凌晨，所以会同时读前一天和后一天的文件，再按报价时间切日历日。两个日历日不一样时，摘要会直接说样本不同。

2026-10-16 那份摘录的跑法、字段核对和结果在 [jev-btc-5m-20261016.md](jev-btc-5m-20261016.md)。

## 测试

```bash
node --test test/jevBtc5mBacktest.test.js
```

覆盖扣费成本、一笔小磁带的成交/胜负/回撤，以及同档随机对照的固定种子。
