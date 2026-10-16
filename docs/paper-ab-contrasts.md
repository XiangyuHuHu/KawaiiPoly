# 纸面 A/B 对照

四组对照只跑模拟。`paperContrastLiveTradingEnabled()` 恒为 false，交易服务拒绝把 `plan14b` / `plan16b` / `plan2_6b` / `plan3_6b` 放进实盘调度。不要设置 `POLYMARKET_LIVE_TRADING_ENABLED` 或 `ENABLE_LIVE_TRADING`。

| 对照 | 治疗臂 | 改动 | 对照臂 |
| --- | --- | --- | --- |
| Plan14 | `plan14b` | 当前 `modelWeight5m` 减半 | `plan14`，权重不变 |
| Plan16 | `plan16b` | 卖一下限 0.20 | `plan16`，下限仍是 0.08 |
| Plan2.6 | `plan2_6b` | 入场上限和硬顶都是 0.80 | `plan2_6`，上限 0.90、硬顶 0.92 |
| Plan3.6 | `plan3_6b` | 置信度先变成概率，再算 edge | `plan3_6`，仍把置信度当概率 |

每组一个旋钮、两本现金。不要把账本加在一起。

## 怎么读结果

只用对照上线之后的纸面成交。

- 净 ROI：已结算盈亏 / 成本。纸面吃单费会减少份额；Plan3.6 的 edge 用的是已经加上纸面滑点档的可执行价。费用和滑点都在净 ROI 里，不要另造一条只改 edge 的费用。
- 最大回撤：各账本净值曲线自己的回撤。ROI 更高但回撤更深，不算赢。
- 同一卖一档：例如 8–20¢、20–40¢、40–80¢、80¢+。每臂和同一档的基线比。Plan16b 的意义就是让 20¢ 以下的尾部成交不再主导治疗臂。
- 样本少的时候不下结论。

## 本地开关

默认四组都开（`POLYMARKET_PAPER_AB_CONTRASTS` 不是 `false`，各 `*B` 新开仓也不是 `false`）。

- 全关：`POLYMARKET_PAPER_AB_CONTRASTS=false`
- 关一组：`POLYMARKET_PLAN14B_ENABLED=false`（`PLAN16B`、`PLAN2_6B`、`PLAN3_6B` 同样）
- Plan14 / Plan16 对照臂仍看自己的新开仓开关：`POLYMARKET_PLAN14_NEW_ENTRIES_ENABLED=true`、`POLYMARKET_PLAN16_NEW_ENTRIES_ENABLED=true`。不设的话，对照账本不开新仓。
- Plan2.6 / Plan3.6 已退出主循环。治疗臂开着时，纸面 A/B 循环会用原规则写对照账本，并且 `paperOnly`，不调用实盘执行器。

模拟页有四个对照标签。分析页可以按同一 plan id 过滤。
