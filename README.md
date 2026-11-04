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
| `start` | 起始日期 `YYYY-MM-DD`（取完整历史，不受条数限制） | `2015-01-01` |

> 该端点会**自动分页取全量历史**（腾讯单次最多约 1200 条，Worker 会向前翻页补齐到 `start`），返回 `start` 至今的全部交易日数据，无需手动翻页。

示例：`/api/kline?symbol=sz399006&start=2010-01-01`

返回：
```json
{
  "symbol": "sz399006",
  "period": "day",
  "count": 3900,
  "updated": 1730600000000,
  "data": [
    { "date": "2010-06-01", "open": 1031.20, "close": 1038.37, "high": 1042.66, "low": 1018.22, "volume": 28910232 },
    { "date": "2026-11-03", "open": 2136.92, "close": 2060.44, "high": 2137.65, "low": 2040.38, "volume": 196587395 }
  ]
}
```

常用代码：`sz399006` 创业板指 · `sh000300` 沪深300 · `sh000001` 上证指数 · `sh000919` 中证红利（视腾讯覆盖）。

### `GET /api/csindex` — 中证自定义指数日线（如 H30269 红利低波）

腾讯对自定义中证指数（H 开头）往往没有日线，本端点直连**中证指数官网** `csindex.com.cn` 补上。

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbol` | 指数代码（中证格式，如 `H30269`） | `H30269` |
| `start` | 起始日期 `YYYYMMDD` | `20100101` |
| `end` | 结束日期 `YYYYMMDD`（默认今天） | 今天 |

示例：`/api/csindex?symbol=H30269&start=20160803`

返回（字段与 kline 对齐：`date/open/close/high/low/volume`）：
```json
{
  "symbol": "H30269",
  "start": "20160803",
  "end": "20261104",
  "count": 2488,
  "updated": 1730600000000,
  "data": [
    { "date": "2016-08-03", "open": null, "close": 7145.8, "high": null, "low": null, "volume": null },
    { "date": "2026-11-03", "open": 11295.54, "high": 11358.59, "low": 11128.73, "close": 11335.6, "volume": 12345678 }
  ]
}
```

> 注：中证官网对指数基日（inception）当天的 `open/high/low/volume` 常为 `null`，这是上游数据本身如此，与原 AKShare `stock_zh_index_hist_csindex` 行为一致，看板侧已兼容。

## 看板里怎么调用

```js
const res = await fetch("https://a-stock-api.wj4020410.workers.dev/api/kline?symbol=sz399006&start=2010-01-01");
const { data } = await res.json();
// data = [{ date, open, close, high, low, volume }, ...]

// 中证自定义指数（如红利低波 H30269）
const res2 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/csindex?symbol=H30269&start=20160803");
const { data: hldb } = await res2.json();
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
