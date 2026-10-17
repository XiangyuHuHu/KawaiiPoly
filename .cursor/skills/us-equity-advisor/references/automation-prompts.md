# 自动任务只负责到点

规则在 `us-equity-advisor` skill 里。自动任务不要粘贴框架全文，否则聊天和定时任务会各改一版。

自动任务要选择本仓库。仓库里的 `.cursor/skills/us-equity-advisor/SKILL.md` 会被读到。个人目录里的 skill 目前不会进入自动任务。

工具只开 Robinhood 的只读能力。不要开下单、改单、撤单。不要让任务改 Polymarket 代码。净值和高水位不要提交到 git；有 memory 就只写 memory。

默认每天三次，都用美东时间、仅工作日：

| 任务 | 时间 | 原因 |
|---|---|---|
| 开盘 | 9:30 | 看跳空和今天要验证的价位 |
| 午盘 | 12:30 | 代替每 30 分钟一次。多数半小时没有新触发，仍会整段跑完 |
| 收盘 | 16:15 | 用收盘价更新 ATR、均线和次日观察 |

每 30 分钟一档只在需要盯具体价位时再加。那种任务必须遵守盘中提示：没有触发就只回一行。

## 开盘提示

```text
读取并遵守 .cursor/skills/us-equity-advisor/SKILL.md 和其中引用的 references/framework-v1.md。
本次只跑开盘档。用 Robinhood 只读数据复核美股主账户。
不要下单，不要改仓库里的持仓或净值，不要改 Polymarket 代码。
```

## 午盘或盘中提示

```text
读取并遵守 .cursor/skills/us-equity-advisor/SKILL.md 和其中引用的 references/framework-v1.md。
本次只跑盘中档。没有标的逼近止盈线、失效价、事件或集中度上限时，整份回复只写一行：NO_TRADE 无触发。
不要下单，不要改仓库。
```

## 收盘提示

```text
读取并遵守 .cursor/skills/us-equity-advisor/SKILL.md 和其中引用的 references/framework-v1.md。
本次只跑收盘档。用收盘数据更新 ATR14、20/50 日均线、追踪止盈线和次日观察。
高水位若要跨日保存，只写本任务的 memory，不要写入 git。
不要下单，不要改 Polymarket 代码。
```
