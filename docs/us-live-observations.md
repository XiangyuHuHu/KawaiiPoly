# Live 观察日志、尾盘分歧闸门与尾盘试单（SCAN_SPEC v3.6）

v3.4 把正在进行的美国站胜负盘记下来，并给旧尾盘规则加分歧闸门。v3.5 不改 BTC 错价、全局现金保留 $15、旧尾盘地板 0.88 / 0.95、胜率仓位。它另开一个板块 `live_endgame_v2`：约 16 小时观察里，尾盘模型 ≥ 0.70 且卖价 ≤ 0.90 是正 ROI（n=9，6 场，100% 命中，ROI +19.5%）。这是小账户试单，每笔 $1。

v3.6 只改这个试单的现金地板。其他板块仍是下单后留下 $15。试单模型地板和价格帽仍是 0.70 / 0.90。

依据是 2026-10-19 对 175 场（10/12、10/13、10/17 PT）的回测：尾盘没有一组门槛是正 ROI；亏损集中在模型比卖价高出约 0.10 的单（例如模型 0.96、卖价 0.83）。唯一为正的一截是足球早/中盘热门（去水 ≥ 0.80、价格 ≤ 0.93，n=88，ROI +12%），先只记纸面。

## 日志写在哪

`$POLYMARKET_US_LEDGER_DIR/scans/live-observations.jsonl`。没设这个变量时也认 `$LEDGER_DIR`，默认 `/workspace/polymarket-ledger/scans/live-observations.jsonl`。

`npm run us:scan` 每轮都会跑观察（和 15 分钟循环同一条）。比赛窗口里想更密，另跑：

```cron
*/5 * * * * cd /workspace && npm run us:live-observe
```

同一分钟、同一市场、同一方向只留一行。5 分钟任务和 15 分钟扫描撞在同一分钟时，后到的不重复写。Pinnacle、ESPN 或 BBO 失败只记在 `status/last-live-observe.json`，不让扫描退出。

行情限流：`us:scan` 先打交易要用的 BTC 和其他报价，再跑观察。gateway.polymarket.us 在同一进程里共用一条队列，交易请求插到观察请求前面。观察 BBO 只拉 `model_src != none` 的市场，扫描已经拿到的 BBO 直接复用，并且串行大约每秒一个。遇到 HTTP 429 或 Cloudflare 1015，这一笔交易行情退让后跳过，扫描继续；观察行情从第一次 429 起本轮不再请求。Pinnacle guest API 对电竞和板球返回 401，这两项不请求，401/403 也不记成错误，模型留 `none`。

每个正在进行的 moneyline（含足球三个 `drawable_outcome` 胜负盘）写 Yes 和 No 两行，没有模型也写，低于 0.60 的一侧也写。日志没有更高的模型地板。

面向阈值研究的存储带是 `model_prob ≥ 0.60`（`US_LIVE_OBSERVE_MIN_MODEL`）。用户常在这一带买更高胜率的一侧，所以要从 0.60 起攒几天的 ROI，而不是只盯尾盘 0.88。`model_prob` 有值且 ≥ 0.60 时，`rule_pass.observe_band = true`，方便事后过滤。这面旗子不下单，也不改尾盘地板。

| 字段 | 含义 |
| --- | --- |
| `ts_utc` | 观察时间 |
| `market_slug` / `event_slug` | 市场与赛事 |
| `sport` / `league` | 运动、系列（`seriesSlug`） |
| `side` | `Yes` 或 `No` |
| `model_prob` / `model_src` | 主模型。有 Pinnacle 去水用 `pinnacle_devig`，否则 ESPN 胜率 `espn_wp`，都没有则 `null` / `none` |
| `ask` / `bid` / `ask_depth` | 该方向卖价、买价、卖盘名义金额（价格 × 份额） |
| `period` / `clock` / `score` | 美国站 `eventState` |
| `phase` | `pregame` / `early` / `mid` / `late` / `endgame` |
| `rule_pass` | 哪条规则过了或没过，以及原因。`would_signal_paper`、`observe_band`（`model_prob ≥ 0.60`）、`endgame_v2` 在这里 |
| `signal_id` | 已有 pending 信号才填，观察本身不写 SIGNAL |
| `pinnacle_prob` / `espn_prob` / `score_sampled_at` / `score_age_ms` | 闸门和纸面标记用的附加字段 |

相位：足球 0–29' 与半场为 early，30–59' 为 mid，60–74' 为 late，≥75' 为 endgame。橄榄球和 NBA 第 4 节或加时为 endgame。冰球第 3 节或加时为 endgame。棒球第 7 局起为 endgame。late 仍在尾盘之前。

## 尾盘分歧闸门

地板不动：`liveEndgameMinModel = 0.88`，`liveEndgameMaxPrice = 0.95`。扫描 `evaluateUsSignal` 和下单 `evaluateUsSignal` 走同一个 `endgameDivergenceGate`。

只有 `model − ask > 0.10` 才进闸门（`US_LIVE_ENDGAME_DIVERGENCE`）：

| 情况 | 动作 |
| --- | --- |
| ESPN 和 Pinnacle 都 ≥ 0.88，且比分/时钟年龄 ≤ 60 秒 | 正常仓（$2–$5） |
| 两个来源都没有 | 只下 $1（`order_kind = divergence_micro`） |
| 只有一边、有一边低于 0.88、或比分/时钟缺失或超过 60 秒 | 跳过 |

选择的是跳过，不是把所有分歧都收成 $1。$1 只留给「模型数字在，但 ESPN 和 Pinnacle 都没附上」的手写信号，因为没法判断是分歧还是缺数据。观察日志里的主模型一定来自这两个来源之一，所以单源大分歧会记成跳过，不会变成 $1 单。

比分时间用 `score_sampled_at`（美国站 `eventState.updatedAt`）。下单时用 `现在 − score_sampled_at`，不用扫描当时冻结的年龄。

常量：`US_LIVE_ENDGAME_DIVERGENCE`、`US_LIVE_ENDGAME_DIVERGENCE_MIN_MODEL`、`US_LIVE_ENDGAME_SCORE_MAX_AGE_MS`、`US_LIVE_ENDGAME_DIVERGENCE_FALLBACK_USD`。`rules.edge` 引用同一组。

## 尾盘试单 live_endgame_v2

相位用现在的 endgame。`model_prob ≥ 0.70`（`US_LIVE_ENDGAME_V2_MIN_MODEL`）且 `ask ≤ 0.90`（`US_LIVE_ENDGAME_V2_MAX_PRICE`）。`rule_pass.endgame_v2.pass` 为 true 时才考虑下单。`model − ask > 0.10` 时，ESPN 和 Pinnacle 都要 ≥ 0.70，并且比分/时钟在 60 秒内，否则跳过。试单没有「两个来源都没有就下 $1」那条；旧的 0.88 规则仍保留那条。

每笔 $1（`US_LIVE_ENDGAME_V2_SIZE_USD`）。这个板块日帽 6（`US_LIVE_ENDGAME_V2_DAILY_CAP`）。每个市场每天只下一笔。和旧尾盘规则不能买同一个市场的同一边。深度为 0、价差过大、BBO 过期，仍然不下。板块刹车对 `live_endgame_v2` 同样生效。

现金：全局 `US_CASH_RESERVE_USD` 仍是 $15，天气、BTC、旧尾盘（含 $1 分歧微单）都用它。试单另有 `US_LIVE_ENDGAME_V2_CASH_RESERVE_USD = 14`。购买力必须 ≥ 这一笔金额，否则跳过原因是 `insufficient_cash`。购买力够付、但下单后会低于 $15 时，只要下单后仍 ≥ $14，并且这种豁免还没用过，就允许，并在订单和 SIGNAL 上标 `v2_cash_floor_breach`。这样的豁免最多 1 笔（`US_LIVE_ENDGAME_V2_CASH_BREACH_MAX`）。用完之后重新要求下单后 ≥ $15，跳过原因仍是 `cash_reserve`。下单后本来就 ≥ $15 的试单不占这 1 笔。购买力评估过时，`gates.cash_reserve_checked` 为 true；没有购买力时扫描不挡，留给下单再核。

2026-10-23 的只读网格（仓库里没有那份观察样本，下面数字当作当时的读数，不是这次重跑）：现行 0.70 / 0.90 是 n=28、命中 85.7%、ROI +10.0%。邻近 0.65 / 0.90 是 n=41、命中 80.5%、ROI +12.6%。旧的 0.88 / 0.95 是 n=10、ROI +3.4%，更差。0.85 以上再配 0.88 价格帽的高 ROI 格子 n≤10，先不跟。自 10/20 起试单大约 19 条唯一 SIGNAL、32 行 `would_signal_v2`，真实成交只有 1 笔，所以默认地板保持 0.70，不抬到 0.88，价格帽也不抬到 0.95。挡住那一笔 $1 的是现金：购买力约 $15.86 时，$1 之后剩约 $14.86，过不了 $15。

可选试点：`US_LIVE_ENDGAME_V2_MIN_MODEL=0.65`。价格帽仍是 0.90。不设这个变量时默认还是 0.70。这不是默认改动。

关掉试单：`US_LIVE_ENDGAME_V2_ENABLED=false`。默认开。关掉之后不再写这个板块的 SIGNAL，已有 pending 在下单时也会跳过。观察日志继续写。

什么时候下单：

1. `us:scan`（建议每 15 分钟）写观察日志，规则通过就追加 SIGNAL 到 `signals/pending.jsonl`。扫描本身不下单。
2. `polymarket:us` 在同一条 15 分钟循环里读 pending，重新拉 BBO，再按日帽、保留现金、去重和刹车下单。
3. `us:live-observe`（建议每 5 分钟）同样写日志并发 SIGNAL。如果这时还有未完成的 `live_endgame_v2` pending，它马上只下这个板块，走同一个 `runPolymarketUsCycle`。尾盘窗口短，不等到下一轮 15 分钟。其他板块仍只由 `polymarket:us` 下。摘要行在 `v2-signals` 和 `v2-placed` 之外还有 `v2-skip=cash_reserve:N,insufficient_cash:N,stale_bbo:N,divergence:N,depth:N`。没有跳过时是 `v2-skip=none`。同一份计数写进 `status/last-live-observe.json` 的 `v2Skip`。下单把 SIGNAL 标成 `skipped` 时，pending 行带上 `skip_reason`（例如 `cash_reserve`）。现金门跑过时再写 `cash_reserve_checked`。

已经下过的 SIGNAL 不会再下一遍。同一市场当天的第二笔试单会被丢掉。

## 足球热门（纸面）

去水 ≥ 0.80 且价格 ≤ 0.93，相位是 early、mid 或 late（也就是 75' 之前，含回测里的早盘和中盘）。只认 Pinnacle 去水，不认 ESPN。`rule_pass.would_signal_paper = true`，`would_signal` 仍为 false。这面纸面标记不下单。只有 `endgame_v2` 通过才会写 SIGNAL。

## 结算和网格

`npm run us:settle` 在订单摘要之后，按市场 slug 向美国站网关补观察结果，写到单独文件：

`$LEDGER_DIR/scans/live-observations-settled.jsonl`

一行一个市场：`market_slug`、`yes_won`、`void`、`long_px`、`settled_at`。未结束的下次再问。不改观察日志本身。

```bash
npm run us:live-analyze
node scripts/analyze-live-observations.js [observations.jsonl] [settled.jsonl]
```

默认网格是尾盘「model 门槛 × 价格帽」。门槛为 0.60、0.65、0.70、0.75、0.80、0.85、0.88、0.90、0.92、0.95，价格帽仍是 0.90、0.93、0.95、0.99。每个市场×方向只取第一次满足的卖价，按 $1 计算 ROI。另外打印足球纸面那一截。研究带从 0.60 起。试单默认地板是 0.70 / 0.90；想看 0.65 / 0.90 用环境变量试点，不改默认。旧尾盘下单地板仍是 0.88 / 0.95。

## 回滚

1. 关掉试单：`US_LIVE_ENDGAME_V2_ENABLED=false`。旧尾盘 0.88 / 0.95 还在。已经写下的观察日志留着。
2. 关掉分歧闸门：把 `src/polymarketUs/constants.js` 里的 `US_LIVE_ENDGAME_DIVERGENCE_ENABLED` 设为 `false`。地板 0.88 和价格帽 0.95 保持。扫描和下单都读这个常量。试单自己的分歧检查用 `allowMicro: false`，不受这条 $1 盲单影响。
3. 停止记日志：去掉 `us:live-observe` 的 cron。`us:scan` 里的 `observeLive` 可以不传，现有扫描测试就是这样。已经写下的 jsonl 可以留着。5 分钟那条也会停掉试单的加急下单，15 分钟的 `polymarket:us` 仍会吃掉还在 pending 里的试单，除非同时把环境变量关掉。
4. 版本号：`US_SPEC_VERSION` 在 `constants.js` 是 `v3.6`，在 `rules.js` 是 `3.6`。退回时两处一起改，并去掉 `rules.edge` 上的 `liveEndgameV2*`、`rules.size` 上的 `liveEndgameV2Cash*` 和日帽里的 `live_endgame_v2`。
5. BTC 门槛、`US_CASH_RESERVE_USD = 15`、其他板块日帽、板块刹车、胜率仓位都不要在这次回滚里动。试单现金地板 `US_LIVE_ENDGAME_V2_CASH_RESERVE_USD = 14` 只作用于 `live_endgame_v2`。
