# Polymarket 美国版账本

扫描器只写 SIGNAL，不在这里下单。真实账户只认 polymarket.us。

结算与价格不要用 `gamma-api.polymarket.com` 或 `clob.polymarket.com`。入场价读 `https://gateway.polymarket.us/v1` 的 markets / bbo / book。BTC 短线结算用 CF Benchmarks BRTI：窗口起止各 60 个一秒价格的简单平均，保留两位小数；结束价 ≥ 开始价为 Up。

战绩只统计 `real-orders.jsonl` 里 `polymarket.us` 的真实订单。纸面盘和国际版记录不进每晚总结。
