# Kawaii_poly 另一台机器 Docker 部署

把代码拷过去之后，在**那台机器**上按这份做。默认按 Linux（`desktop-ser8@192.168.3.238`）写；那边如果也是 Windows，跳过「改 records 路径」那一步即可。

**不要和本机同时开实盘。** `POLYMARKET_LIVE_TRADING_ENABLED=true` 时两边一起跑会重复下单。本机要先停：

```powershell
# 本机（拷走之前）
cd D:\自己乱搞的代码\Kawaii_poly
docker compose stop
```

---

## 1. 要拷什么

只拷这一个目录：`D:\自己乱搞的代码\Kawaii_poly`

信号包已经放在仓库里的 `packages/kawaii-signal`，不用再带 `Kawaii_lianghua`。

**必须带上** `.env` 和 `data/`。**不要拷** `node_modules/`（容器里会重新装）。

建议落到 Linux 上：`~/apps/Kawaii_poly`

---

## 2. 改 records 挂载（Linux 必做）

`docker-compose.yml` 里现在是 Windows 路径，Linux 上会挂载失败：

```yaml
- "D:/Obsidian仓库/Kawaii的仓库/投资/虚拟币/比特币猜输赢记录:/records"
```

在那台机器上改成相对目录，例如：

```bash
mkdir -p ~/apps/Kawaii_poly/records
```

把那一行换成：

```yaml
- "./records:/records"
```

`./data:/app/data` 不用改。

如果预测记录文件也要过去，把本机 Obsidian 那个文件夹里的内容拷进 `~/apps/Kawaii_poly/records`。没有记录也能启动，只是预测存档是空的。

---

## 3. 检查 Docker

```bash
docker --version
docker compose version
```

没有的话先装 Docker Engine + Compose 插件，当前用户能跑 `docker`（或前面加 `sudo`）。

---

## 4. 启动

```bash
cd ~/apps/Kawaii_poly
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=80 app
```

正常应看到：

| 容器 | 端口 |
|---|---|
| `Kawaii_poly` | `127.0.0.1:3003` |
| `Kawaii_poly_web` | `127.0.0.1:3002` |

本机验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3003/
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3002/
```

两个都是 `200` 即可。`Ctrl+C` 退出日志，容器继续跑。

---

## 5. 在你自己电脑上看页面

端口绑的是 `127.0.0.1`，局域网浏览器直接打不开。在你自己电脑上开隧道：

```bash
ssh -L 3002:127.0.0.1:3002 -L 3003:127.0.0.1:3003 desktop-ser8@192.168.3.238
```

然后打开：

- 控制台：http://127.0.0.1:3002
- API：http://127.0.0.1:3003

---

## 6. 常用命令

都在 `~/apps/Kawaii_poly` 下：

```bash
docker compose ps
docker compose logs -f --tail=100 app
docker compose restart
docker compose stop          # 停实盘
docker compose up -d --build # 改代码后重建
```

改了 `src/`、`public/`、`server.js` 必须 `--build`。只改 `docker-compose.yml` 里的环境变量，`--force-recreate` 即可。

---

## 7. 常见失败

| 现象 | 处理 |
|---|---|
| 构建找不到 `packages/kawaii-signal` | 确认拷了整个 `Kawaii_poly`，里面有 `packages/kawaii-signal` |
| 挂载 `D:/Obsidian...` 报错 | 第 2 步改成 `./records` |
| 启动后立刻退出 | `docker compose logs app`，多半是缺 `.env` 或密钥 |
| `port is already allocated` | 那台机 3002/3003 被占用，先 `docker ps -a` 清掉旧容器 |
| 页面 200 但实盘异常 | 确认本机已经 `docker compose stop`，只留这一套 |

---

## 8. 不要做的事

- 不要把 22 或 3002/3003 映射到公网
- 不要把 `.env` 提交到 git 或发到聊天里
- 不要本机容器和远程容器同时实盘
