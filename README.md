# a-stock-api · A股共享数据源 API

一个跑在 Cloudflare Workers 上的 **A股数据源接口**，让你的各个看板（rotation-monitor / national-team-etf-flow / etf-lsi / earl-etf-dashboard …）统一从这里取数，而不是各自直连上游、各自维护一份。

> 取数逻辑改编自 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（**Apache-2.0**），在此致谢并保留署名。

## 它是什么 / 不是什么

- ✅ **这个仓库是「代码老家」**：放源码、历史、自动部署配置。
- ✅ **真正被看板调用的是「部署后的 Worker 网址」**（形如 `https://a-stock-api.<subdomain>.workers.dev`），**不是 GitHub 仓库本身**。
- 流程：改代码 → `git push` → 自动部署到 Cloudflare → Worker 上线 → 看板去调 Worker 的 URL。

这样做的好处：数据源只维护**一份**（腾讯哪天改接口，只改这个 Worker，所有看板受益），并且自带 KV 缓存 + 多 host 轮换，比每个看板各搞一套更稳、更省上游配额。

## 端点

### `GET /api/kline` — 指数日 K 线

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbol` | 指数代码（腾讯格式） | `sz399006` |
| `period` | `day` / `week` / `month` | `day` |
| `count` | 返回条数（≤1200） | `365` |
| `start` | 起始日期 `YYYY-MM-DD` | `2015-01-01` |

示例：`/api/kline?symbol=sz399006&period=day&count=365`

返回：
```json
{
  "symbol": "sz399006",
  "period": "day",
  "count": 365,
  "updated": 1730600000000,
  "data": [
    { "date": "2025-01-02", "open": 2136.92, "close": 2060.44, "high": 2137.65, "low": 2040.38, "volume": 196587395 }
  ]
}
```

常用代码：`sz399006` 创业板指 · `sh000300` 沪深300 · `sh000001` 上证指数 · `sh000919` 中证红利（视腾讯覆盖）。

## 看板里怎么调用

```js
const res = await fetch("https://a-stock-api.<subdomain>.workers.dev/api/kline?symbol=sz399006&count=365");
const { data } = await res.json();
// data = [{ date, open, close, high, low, volume }, ...]
```

已开启 `Access-Control-Allow-Origin: *`，github.io / pages.dev 等静态看板可直接 `fetch`。

## 部署

**方式 A：本地 wrangler**
```bash
npm install -g wrangler
wrangler login          # 或设置 CLOUDFLARE_API_TOKEN 环境变量
wrangler deploy
```

**方式 B：推到 GitHub 自动部署**
在本仓库 `Settings → Secrets and variables → Actions` 里加两个 secret：
- `CLOUDFLARE_API_TOKEN`（有 Workers 编辑权限的令牌）
- `CLOUDFLARE_ACCOUNT_ID` = `3242358d09b1b6024863cfdf939def5d`

之后每次 `git push` 到 `main` 即自动部署。

KV 缓存命名空间 `a-stock-api-cache` 已创建并绑到 `CACHE`，无需额外操作。

## 缓存

命中 KV 缓存时直接返回（TTL 1 小时），未命中才去腾讯取数。免费额度内（10 GB / 月、千万级操作）完全够用，不会触发任何费用。

## License

Apache-2.0。见 [LICENSE](./LICENSE)。
