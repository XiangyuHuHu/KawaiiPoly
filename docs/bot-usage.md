# Bot 使用说明：美国站 SIGNAL 与国际纸面

有两套互不相通的 Polymarket 线。

| | 美国站实盘 | 国际纸面 |
| --- | --- | --- |
| 站点 | `https://polymarket.us` | Gamma / CLOB |
| 配置 | `POLYMARKET_US_GATEWAY_BASE=https://gateway.polymarket.us/v1` | `POLYMARKET_GAMMA_BASE`、`POLYMARKET_CLOB_BASE` |
| 代码 | `src/polymarketUs/` | `src/polymarketClient.js` 与各 Plan |
| 命令 | `npm run us:scan` / `npm run us:settle` | `npm start`、`npm test` |
| 下单 | 扫描器不下单。合格 SIGNAL 由 bot 在浏览器下限价单 | 纸面模拟，不代表美国账户 |

不要把美国网关写进 `POLYMARKET_GAMMA_BASE` 或 `POLYMARKET_CLOB_BASE`。美国客户端会拒绝这两个主机。仓库里不放密钥。

## 扫描器与 bot 的分工

规则版本是 SCAN_SPEC v3.2。v3 的「等用户逐笔确认」和「每天最多 2–3 笔」已作废。

- 云端脚本只监控：客观数据 → 模型概率 → 和美国站卖价的 edge。通过才写 SIGNAL。
- 用户已给站立授权：bot 看到 `status=pending` 就在 polymarket.us 下限价单，不用再问。金额约 $2–5。
- 每条 SIGNAL 里 `auto_order.scanner_places_orders` 固定为 `false`，`auto_order.per_trade_confirm` 为 `false`。`auto_order.note` 是给 bot 的授权说明。
- 成交后用中文播报市场、方向、价格、金额、理由、`event_url` 和截图。
- 没有新的 pending SIGNAL，或者内容和上次相同：不要开模型，不要开浏览器。

## 什么时候跑

时区是太平洋时间。

- 周一到周五只在 **8:37、12:37、18:37** 各跑一次短线（窗口 15 分钟）。窗口外脚本直接退出，不写 `signals/`。
- 周六日全天可跑。仍然没有合格 edge 就不写文件。
- 周一 **8:50** 额外看一笔偏长期（`crypto` / `master`）。模型概率要写在 `model-input.jsonl`，脚本再用美国站 BBO 重定价。没有模型文件就没有长期 SIGNAL。
- 国际短线扫描保持暂停，不要用这套脚本去扫国际盘。

```cron
CRON_TZ=America/Los_Angeles
37 8,12,18 * * 1-5 cd /workspace && npm run us:scan
50 8 * * 1 cd /workspace && npm run us:scan
*/15 * * * 0,6 cd /workspace && npm run us:scan
5 23 * * * cd /workspace && npm run us:settle
```

周一 8:50 那一行如果只想扫长期单，仍用 `npm run us:scan`（8:50 同时落在早盘 15 分钟窗口内，短线和长期都会看）。`us:settle` 只做结算摘要。

手动补跑、不看钟点：`POLYMARKET_US_IGNORE_WINDOW=1 npm run us:scan`。

## SIGNAL 写在哪里

优先目录：`/workspace/polymarket-ledger/signals/`

- `pending.jsonl`：一行一个待下单 JSON
- `{sector}-{timestamp}.json`：同一条的单文件，例如 `btc-misprice-20261014T1530Z.json`

兼容（只在新 SIGNAL 出现时写，空扫不碰）：

- `/workspace/polymarket-ledger/candidates.jsonl`
- `/workspace/btc15-*/signal.json`（BTC 15 分钟错价）
- `/workspace/btc15-mom-*/signal.json`（BTC 15 分钟动量）

空扫、窗口外、edge 不够、价差或深度不够、结算规则对不上，都不会创建这些文件。同一 `id` 只写一次；bot 删掉文件后也不会再写，避免重复叫醒。

调试输出在 `polymarket-ledger/status/last-scan.json`，bot 不要盯这个目录。

### 字段

`sector`、`slug`（可带 `cpc-`）、`side`（Yes/No 或 Up/Down）、`limit_price`、`size_usd`、`edge`、`model_prob`、`ask`、`expires_at`、`basis`、`status`（`pending` / `filled` / `expired` / `skipped`）、`event_url`。

`event_url` 一律是 `https://polymarket.us/event/{slug}`，展示用 slug 去掉 `cpc-` 前缀。

bot 下单后把对应行改成 `filled` 或 `skipped`，记入 `real-orders.jsonl`（动量试单可记 `momentum-trial.jsonl`）。不要把回执写回一份新的 pending。

`real-orders.jsonl` 至少包含：`id`、`pt_date`、`sector`、`slug`、`side`、`limit_price`、`size_usd`、`status`、`event_url`、`window_id`。结算后补 `won`、`pnl_usd`、`settled_pt_date`。`venue` 写 `polymarket.us`。

## Bot 例程怎么短路

交易例程：

1. 列出 `signals/pending.jsonl` 和 `signals/*.json`。
2. 没有文件，或每一行都不是 `status=pending`：立刻结束。
3. `id` 已经下过或标过：跳过，不要再开浏览器。
4. 有新的 pending：按 `side`、`limit_price`、`size_usd`、`event_url` 下限价单，不必再向用户确认。下单前再看一眼卖价；现价高于限价就标 `skipped`。该板块当日已满日帽就标 `skipped`。
5. 同一 15 分钟窗口不能一边 Up 一边 Down。后到的冲突单跳过。

每晚例程（定时，不看 signals）：

1. 读 `polymarket-ledger/digests/nightly.txt` 和 `digests/nightly.meta.json`。
2. `changed` 为 false，或这一行和上次发过的相同：不要 `SendToUser`。
3. 否则原样发送那一行中文，不要加分析。

## 门槛、仓位、日帽

Edge 是模型概率减去美国站卖价。v3.2 相对旧的 0.10 放宽：

- 非 BTC、非 Live（赛前、天气、宏观、加密长线、master）：≥ 3 个百分点。价格仍要在 0.15–0.85。
- BTC 15 分钟 / 1 小时错价：≥ 5 个百分点，而且 BBO 不超过 15 秒。结算规则必须是 BRTI 收盘涨跌，不是 Touch。
- BTC 15 分钟动量：触发距离是国际站 Plan2 15 分钟动量 8 bps 的一半（4 bps）；`same_way` 必须同向；`mos`（模型概率减卖价）必须为正；买入价 ≤ 0.88。胜率偏弱时距离退回 8 bps。
- Live 盘中：模型比卖价高 ≥ 4 个百分点，价格大约 0.15–0.95。
- Live 尾盘：模型 ≥ 0.88 且价格 ≤ 0.95。模型概率不按 0.90 封顶。
- 价差 ≤ 3¢，盘口深度要够这一笔。`resolution_risk=High` 或 `confidence=Low` 跳过。非尾盘的 `model_prob` 封顶 0.90。
- 同一 15 分钟窗口不能一边 Up 一边 Down。错价和动量同时合格时只留错价。
- 国际站独有盘不入选：ETH、美债收益率、纽约/洛杉矶/芝加哥/迈阿密/旧金山以外的城市气温。
- `picks.jsonl` 里已有同一市场、同一方向，不再入选。

仓位看该板块真实已结算胜率：默认 $2；胜率 ≥ 70% 且样本 ≥ 5 → $3；≥ 80% 且样本 ≥ 10 → $5。胜率 < 45% 或连亏 3 笔则维持 $2，并要求更干净的 edge。现金扣掉本笔后必须仍 ≥ $15；账本里没有 `account.json` 的 `cash_usd` 时，bot 下单前自己核这笔现金。

日帽按太平洋时间自然日，计该板块真实成交加未过期 pending：Live 10、动量 15、BTC 错价 8、赛前 6、天气 4、宏观 3、加密 4、master 4。

板块模型（天气、赛前、宏观等）写在 `polymarket-ledger/model-input.jsonl`，每行要有 `sector`、`slug`、`side`、`model_prob`、`resolution_risk`、`confidence`、`basis`。脚本会用美国站 BBO 覆盖价格；读不到美国站价格就不入选。论坛 `forum-signals.jsonl` 最近 48 小时的 A/B 级只作核对触发，不能代替概率。

## 命令

美国站扫描和结算（不下单）：

```bash
npm run us:scan
npm run us:settle
POLYMARKET_US_IGNORE_WINDOW=1 npm run us:scan
```

国际纸面由 `POLYMARKET_INTL_PAPER_ENABLED` 控制，默认开。关掉后 `polymarket.enabled` 为 false，纸面 Plan 不再跑。美国站用 `POLYMARKET_US_ENABLED`，默认关；扫描脚本读的是网关公开行情，不依赖这个开关去下单。

```bash
# 国际纸面
npm start
npm test
```
