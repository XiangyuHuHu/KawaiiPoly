# KawaiiPoly

Polymarket 在这个仓库里分成两条线，结算来源不能混用。

## 国际盘 vs 美国盘

| | 国际盘 `polymarket.com` | 美国盘 `polymarket.us` |
| --- | --- | --- |
| 配置 | `config.polymarket` | `config.polymarketUs` |
| 行情 | Gamma `gamma-api.polymarket.com`，订单簿 `clob.polymarket.com` | 公开 gateway `https://gateway.polymarket.us` |
| 下单 | `@polymarket/clob-client`，`src/polymarketLiveClob.js` | `src/polymarketUs/`，`POST https://api.polymarket.us/v1/orders` |
| 凭证 | `POLYMARKET_API_KEY` / `SECRET` / `PASSPHRASE` + `POLYMARKET_PRIVATE_KEY` | `POLYMARKET_US_ACCESS_KEY` / `POLYMARKET_US_SECRET_KEY` |
| 结算 | Gamma / Data API | `real-orders.jsonl` + `GET /v1/portfolio/activities`。不要用 `gamma-api.polymarket.com` 给美国账户回填 |
| 实盘开关 | `POLYMARKET_LIVE_TRADING_ENABLED=true` | 见下方三条 |

国际盘客户端若被指到 `gateway.polymarket.us` 会直接拒绝。美国盘客户端若被指到 `clob.polymarket.com` 或 `gamma-api.polymarket.com` 也会拒绝。

美国盘规则在 `src/polymarketUs/constants.js`，对应 SCAN_SPEC v3.2：edge 门槛、胜率仓位 $2–$5、日帽、工作日三时段、单边窗口、动量 mos/same_way。

## 美国盘怎么跑

扫描器把待下单写到 `/workspace/polymarket-ledger/signals/pending.jsonl`（也认 `signals/{sector}-{timestamp}.json`、新鲜的 `candidates.jsonl`、`btc15-*/signal.json`）。

```bash
npm run polymarket:us          # 读 SIGNAL，dry-run 或实盘下一轮
npm run polymarket:us:health   # 只看开关和上一轮 us-health.json
npm run polymarket:us:smoke    # 不联网，走一遍门控并打印订单体
```

默认是 dry-run：只把订单体写入 `real-orders.jsonl`（`dry_run: true`），不调用交易接口。Grok Bot 读 `us-health.json` 和账本做播报即可，不必再在浏览器里逐笔点单。

动量单同时追加到 `momentum-trial.jsonl`。BTC 短线的 `resolution_source` 固定为 CF Benchmarks BRTI。

## 打开美国盘实盘

密钥在 https://polymarket.us/developer 创建，只放环境变量，不要提交。

```bash
POLYMARKET_US_ACCESS_KEY=      # Key ID
POLYMARKET_US_SECRET_KEY=      # base64 Ed25519 seed（32 字节；64 字节扩展私钥取前 32 字节）
POLYMARKET_US_DRY_RUN=false
POLYMARKET_US_LIVE_TRADING_ENABLED=true
```

三条缺任何一条都不会发单。签名是 `X-PM-Access-Key`、`X-PM-Timestamp`、`X-PM-Signature`（Ed25519，消息为 `timestamp + METHOD + pathname`），与官方 `polymarket-us` 0.1 SDK 一致。限价买入用 GTC。

密钥到位后可以再跑一轮 `npm run polymarket:us:health`，确认 `dryRun` 为 false，然后再跑 `npm run polymarket:us`。
