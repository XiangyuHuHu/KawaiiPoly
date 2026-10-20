# KawaiiPoly

Polymarket 在这个仓库里分成两条线，结算来源不能混用。

## 国际盘 vs 美国盘

| | 国际盘 `polymarket.com` | 美国盘 `polymarket.us` |
| --- | --- | --- |
| 配置 | `config.polymarket` | `config.polymarketUs` |
| 行情 | Gamma `gamma-api.polymarket.com`，订单簿 `clob.polymarket.com` | 公开 gateway `https://gateway.polymarket.us` |
| 下单 | `@polymarket/clob-client`，`src/polymarketLiveClob.js` | `polymarket-us@0.1.1`，`POST https://api.polymarket.us/v1/orders` |
| 凭证 | `POLYMARKET_API_KEY` / `SECRET` / `PASSPHRASE` + `POLYMARKET_PRIVATE_KEY` | `POLYMARKET_US_ACCESS_KEY` → `keyId`，`POLYMARKET_US_SECRET_KEY` → `secretKey` |
| 结算 | Gamma / Data API | `real-orders.jsonl` + `GET /v1/portfolio/activities`。不要用 `gamma-api.polymarket.com` 给美国账户回填 |
| 实盘开关 | `POLYMARKET_LIVE_TRADING_ENABLED=true` | 见下方三条 |

国际盘客户端若被指到 `gateway.polymarket.us` 会直接拒绝。美国盘客户端若被指到 `clob.polymarket.com` 或 `gamma-api.polymarket.com` 也会拒绝。

美国盘规则在 `src/polymarketUs/constants.js` 和 `src/polymarketUs/rules.js`，对应 SCAN_SPEC v3.5。BTC 错价仍是 v3.3：模型下限 0.56、价格 0.35–0.65、edge 4–15pp、不再打 $1 试探单；仓位 $2–$5、日帽、现金保留 $15、全板块每天每轮、工作日 BTC 密集窗 24/7、单边窗口、动量 mos/same_way 都不变。依据见 `docs/us-btc-misprice-20261018.md`。v3.4 把进行中的胜负盘记到 `scans/live-observations.jsonl`，并给尾盘加分歧闸门。v3.5 加尾盘试单 `live_endgame_v2`（模型 ≥ 0.70、价格 ≤ 0.90、每笔 $1），见 `docs/us-live-observations.md`。非 BTC 模型在 `src/polymarketUs/models.js`，用公开数据生成，不读浏览器例程。扫描节奏见 `docs/bot-usage.md`。

## 美国盘怎么跑

扫描器把待下单写到 `/workspace/polymarket-ledger/signals/pending.jsonl`（也认 `signals/{sector}-{timestamp}.json`、新鲜的 `candidates.jsonl`、`btc15-*/signal.json`）。

```bash
npm run polymarket:us           # 下单前重拉 BBO/订单簿，再 dry-run 或实盘下一轮
npm run polymarket:us:health    # 只看开关和上一轮 us-health.json
npm run polymarket:us:smoke     # 不联网，走一遍门控并打印订单体
npm run polymarket:us:account   # 只读余额 / 挂单 / 持仓，不下单
```

默认是 dry-run：只把订单体写入 `real-orders.jsonl`（`dry_run: true`），不调用交易接口。Grok Bot 读 `us-health.json` 和账本做播报即可，不必再在浏览器里逐笔点单。

动量单同时追加到 `momentum-trial.jsonl`。BTC 短线的 `resolution_source` 固定为 CF Benchmarks BRTI。

## 打开美国盘实盘

密钥只放在跑 bot 的环境里，不要提交，也不要写进国际盘的 `POLYMARKET_API_KEY`。官方 SDK 0.1.1 的构造是 `{ keyId, secretKey }`，对应关系是：

```bash
# keyId = POLYMARKET_US_ACCESS_KEY（UUID）
# secretKey = POLYMARKET_US_SECRET_KEY（base64 Ed25519）
POLYMARKET_US_ACCESS_KEY=
POLYMARKET_US_SECRET_KEY=
POLYMARKET_US_DRY_RUN=false
POLYMARKET_US_LIVE_TRADING_ENABLED=true
```

三条缺任何一条都不会发单。dry-run 仍然是默认。限价买入用 GTC，走 `orders.create`。

只读检查（不下单）在密钥已经配好的机器上跑：

```bash
npm run polymarket:us:account
```

它调用 `account.balances()`、`orders.list()`、`portfolio.positions()`。持仓是按 market slug 做键的 map。现金门控用 `buyingPower`，不用 `currentBalance`。Bot 上一次只读结果大约是 buyingPower 41.91、currentBalance 65.73、挂单 0。保留现金 $15 之后，这个购买力还够 $2–$5 的单。本仓库的开发机没有这两把密钥，`polymarket:us:account` 在这里会直接说明缺密钥并退出，不会访问交易接口。

确认 `npm run polymarket:us:health` 里 `dryRun` 为 false 之后，再跑 `npm run polymarket:us`。
