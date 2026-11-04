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

### `GET /api/etf-shares` — ETF 份额（上交所历史 / 深交所当前快照）

| 参数 | 说明 | 默认 |
|---|---|---|
| `exchange` | `SH`（上交所，按日期查历史） / `SZ`（深交所，当前快照） / `ALL`（两者合并） | `ALL` |
| `date` | 上交所历史查询日 `YYYY-MM-DD`（仅 `SH`/`ALL` 生效；深交所忽略） | 今天 |
| `code` | 可选，按 6 位代码过滤 | 无 |

- 上交所 `query.sse.com.cn` 按 `STAT_DATE` 返回当日全部 ETF 份额（单位 **万份**）。
- 深交所 `fund.szse.cn` 只提供**当前快照**，Worker 自动翻完所有页（pagesize 强制 20）再返回，`snapshot_date` 取自其返回的 `metadata.subname`。
- 返回 `data[].shares_10k` 即为份额（万份）；`unit` 字段也标明了单位。

示例：`/api/etf-shares?exchange=SZ`、`/api/etf-shares?exchange=SH&date=2026-09-18`、`/api/etf-shares?code=510300`

### `GET /api/fund-flow` — 个股 / ETF 资金流（日度四档单净额）

| 参数 | 说明 | 默认 |
|---|---|---|
| `code` | 6 位代码，支持 `sh/sz/bj` 前缀或后缀 `.SH` 等写法 | `510300` |
| `days` | 取最近 N 日（1–240） | `60` |

直连新浪 `MoneyFlow.ssl_qsfx_zjlrqs`。`code` 会自动按号段推导市场前缀（`5/6/9` → `sh`，`8/92` → `bj`，其余 → `sz`）。返回 `net_amount` 单位为**元**，另含 `r0_net`（超大单净额）、`net_ratio`（净额占成交额比）等。

示例：`/api/fund-flow?code=510300&days=60`

### `GET /api/research` — 研报（含评级 / 目标价 / 机构）

| 参数 | 说明 | 默认 |
|---|---|---|
| `code` | 6 位股票代码（个股研报） | `600519` |
| `pages` | 翻页数（1–10，每页 100 条） | `3` |
| `qType` | `0` 个股研报 / `1` 行业研报 | `0` |
| `industry` | 行业研报时的东财行业码（如 `1238`），或 `*` 全行业 | `*` |

直连东财 `reportapi.eastmoney.com`。返回每条研报的 `date / title / org / rating（评级，如"买入"） / industry / eps_this_year / eps_next_year / pdf_url` 等。

示例：`/api/research?code=600519&pages=3`、`/api/research?qType=1&industry=1238&pages=5`

### `GET /api/fund-nav` — 基金 / ETF 净值历史

| 参数 | 说明 | 默认 |
|---|---|---|
| `code` | 6 位基金代码（如 `510300`） | `510300` |
| `start` / `end` | 日期过滤 `YYYY-MM-DD`（可空=全部） | 空 |

直连东财 `fund.eastmoney.com/pingzhongdata`，取 `Data_netWorthTrend`。日期已按北京时区对齐（与 akshare `fund_open_fund_info_em` 输出一致）。返回 `{date, nav, acc_nav, equity_return}`。

示例：`/api/fund-nav?code=510300`

### `GET /api/trade-calendar` — 交易日历

| 参数 | 说明 | 默认 |
|---|---|---|
| `start` / `end` | 区间 `YYYY-MM-DD` | `2010-01-01` / 今天 |

**不依赖额外上游**：直接从上证指数（`sh000001`）日 K 线派生——有 K 线的日期即交易日。返回升序日期数组。

示例：`/api/trade-calendar?start=2015-01-01`

### `GET /api/bond-yield` — 中国国债收益率（可选含美国）

| 参数 | 说明 | 默认 |
|---|---|---|
| `start` | 起始日 `YYYY-MM-DD` | `2015-01-01` |
| `include_us` | `1` 则附带美国国债列 | `0` |
| `max_pages` | 翻页上限（每页 500 行） | `12` |

东财 datacenter `RPTA_WEB_TREASURYYIELD`。返回 `{date, cn_2y, cn_5y, cn_10y, cn_30y, cn_10y_2y, cn_gdp_yoy}`（收益率单位 %），`include_us=1` 时再加 `us_2y/us_5y/us_10y/us_30y/us_10y_2y/us_gdp_yoy`。

示例：`/api/bond-yield?start=2018-01-01`

### `GET /api/margin-account` — 两融账户统计

| 参数 | 说明 | 默认 |
|---|---|---|
| `start` | 起始日 `YYYY-MM-DD` | `2018-01-01` |
| `max_pages` | 翻页上限（每页 500 行） | `10` |

东财 datacenter-web `RPTA_WEB_MARGIN_DAILYTRADE`。返回 `{date, fin_balance, loan_balance, fin_buy_amt, loan_sell_amt, securities_orgs, business_depts, personal_investors, org_investors, active_investors, liable_investors, total_guarantee, avg_guarantee_ratio}`（余额约亿元、投资者数量约万户，以上游原值为准）。

示例：`/api/margin-account?start=2020-01-01`

### `GET /api/market-turnover` — 两市成交额

| 参数 | 说明 | 默认 |
|---|---|---|
| `secids` | 东财 secid 列表（逗号分隔） | `1.000001,0.399001` |

东财 push2 指数实时行情（`ulist.np`）。返回各指数 `{code, name, price, amount}` 与合计 `total_amount`（成交额单位：元）。默认给的是「上证指数 + 深证成指」，两者之和即两市成交额。

示例：`/api/market-turnover?secids=1.000001,0.399001,0.399006`

> **未提供（及原因）**：`/api/index-valuation`（指数历史 PE/PB）——上游乐咕乐股有阿里云反爬，Worker 无法稳定复刻；`/api/spot`（全市场逐股快照）——东财单页强制 100 条、全市场 5900+ 只需 60 页，超免费 Worker 子请求上限，成交额需求请用 `/api/market-turnover`。

## 看板里怎么调用

```js
const res = await fetch("https://a-stock-api.wj4020410.workers.dev/api/kline?symbol=sz399006&start=2010-01-01");
const { data } = await res.json();
// data = [{ date, open, close, high, low, volume }, ...]

// 中证自定义指数（如红利低波 H30269）
const res2 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/csindex?symbol=H30269&start=20160803");
const { data: hldb } = await res2.json();

// ETF 份额（深交所当前快照）
const res3 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/etf-shares?exchange=SZ");
const { data: etf } = await res3.json();   // [{ code, name, shares_10k, ... }]

// 资金流（沪深300ETF，近60日）
const res4 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/fund-flow?code=510300&days=60");
const { data: flow } = await res4.json();   // [{ date, net_amount, r0_net, ... }]

// 研报（贵州茅台，前3页）
const res5 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/research?code=600519&pages=3");
const { data: reports } = await res5.json(); // [{ date, title, org, rating, pdf_url, ... }]

// 基金净值（沪深300ETF 历史）
const res6 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/fund-nav?code=510300");
const { data: nav } = await res6.json();      // [{ date, nav, acc_nav, equity_return }]

// 交易日历
const res7 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/trade-calendar?start=2015-01-01");
const { data: cal } = await res7.json();      // ["2015-01-05", ...]

// 国债收益率
const res8 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/bond-yield?start=2018-01-01");
const { data: bond } = await res8.json();     // [{ date, cn_10y, cn_2y, ... }]

// 两融账户
const res9 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/margin-account?start=2020-01-01");
const { data: margin } = await res9.json();   // [{ date, fin_balance, personal_investors, ... }]

// 两市成交额
const res10 = await fetch("https://a-stock-api.wj4020410.workers.dev/api/market-turnover");
const { total_amount } = await res10.json();  // 元
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
