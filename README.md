# a-stock-api · A股共享数据源 API

一个跑在 Cloudflare Workers 上的 **A股数据源接口**，让各个看板（rotation-monitor / national-team-etf-flow / etf-lsi / earl-etf-dashboard …）统一从这里取数，而不是各自直连上游、各自维护一份。

> 取数逻辑改编自 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（**Apache-2.0**），在此致谢并保留署名。
> 本文档不只是说明书，更是一份**给 AI 执行的运维手册** —— 上游发新版后，直接把第 5 节的提示词丢给 AI 即可。

---

## 0. 先读这一节（铁律）

无论人还是 AI，动这个仓库之前先认下这四条：

1. **只做「代理」，不做「功能扩张」。** 上游 `a-stock-data` 有 87 个入口，本仓库只覆盖其中 10 类、看板真正需要的。上游新增的期货 / 可转债 / 龙虎榜 / 财报等功能**一律不搬**。
2. **响应结构是契约。** `/api/*` 返回的 JSON 字段名、单位、日期格式一旦改动，会静默打断下游 4 个仓库。要加字段可以（向后兼容），**改字段名/换单位绝对不行**。
3. **空结果永远不写 KV 缓存。** 见 §9。这条是踩了坑换来的，别"优化"掉。
4. **凭证不进代码。** Cloudflare Token / GitHub PAT 只放本地环境变量或 GitHub Secrets。

---

## 1. 它是什么 / 不是什么

- ✅ **这个仓库是「代码老家」**：放源码、历史、自动部署配置。
- ✅ **真正被看板调用的是「部署后的 Worker 网址」**：`https://a-stock-api.wj4020410.workers.dev`，**不是 GitHub 仓库本身**。
- 流程：改代码 → `git push` → GitHub Actions 自动 `wrangler deploy` → Worker 上线 → 看板去调 Worker 的 URL。

好处：数据源只维护**一份**（腾讯哪天改接口，只改这个 Worker，所有看板受益），并且自带 KV 缓存 + 多 host 轮换，比每个看板各搞一套更稳、更省上游配额。

---

## 2. 端点契约

> 所有端点都开了 `Access-Control-Allow-Origin: *`，静态看板可直接 `fetch`。
> 命中 KV 缓存时响应里会多一个 `"cached": true`。

### `GET /api/kline` — 指数日 K 线

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbol` | 指数代码（腾讯格式） | `sz399006` |
| `period` | `day` / `week` / `month` | `day` |
| `start` | 起始日期 `YYYY-MM-DD`（取完整历史，不受条数限制） | `2015-01-01` |

> 自动分页取全量历史（腾讯单次最多约 1200 条，Worker 会向前翻页补齐到 `start`）。

示例：`/api/kline?symbol=sz399006&start=2010-01-01`

```json
{ "symbol": "sz399006", "period": "day", "count": 3900, "updated": 1730600000000,
  "data": [ { "date": "2010-06-01", "open": 1031.20, "close": 1038.37, "high": 1042.66, "low": 1018.22, "volume": 28910232 } ] }
```

常用代码：`sz399006` 创业板指 · `sh000300` 沪深300 · `sh000001` 上证指数 · `sh000919` 中证红利（视腾讯覆盖）。

### `GET /api/csindex` — 中证自定义指数日线（如 H30269 红利低波）

腾讯对自定义中证指数（H 开头）往往没有日线，本端点直连**中证指数官网** `csindex.com.cn` 补上。

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbol` | 指数代码（中证格式，如 `H30269`） | `H30269` |
| `start` | 起始日期 `YYYYMMDD` | `20100101` |
| `end` | 结束日期 `YYYYMMDD` | 今天 |

字段与 `kline` 对齐：`date/open/close/high/low/volume`。

> 中证官网对指数基日（inception）当天的 `open/high/low/volume` 常为 `null`，属上游数据本身如此，与 akshare `stock_zh_index_hist_csindex` 行为一致。

### `GET /api/etf-shares` — ETF 份额（上交所历史 / 深交所当前快照）

| 参数 | 说明 | 默认 |
|---|---|---|
| `exchange` | `SH`（按日期查历史） / `SZ`（当前快照） / `ALL`（合并） | `ALL` |
| `date` | 上交所历史查询日 `YYYY-MM-DD`（仅 `SH`/`ALL` 生效） | 今天 |
| `code` | 可选，按 6 位代码过滤 | 无 |

- 上交所 `query.sse.com.cn` 按 `STAT_DATE` 返回当日全部 ETF 份额（单位 **万份**，字段 `shares_10k`）。
- 深交所 `fund.szse.cn` 只提供**当前快照**，Worker 自动翻完所有页（pagesize 强制 20），`snapshot_date` 取自其返回的 `metadata.subname`。

**容错约定（下游按此判定，很重要）**：

- 上交所对 Cloudflare 出口也会偶发限流（回空 / HTML 而不是 JSON）。Worker 内部**重试 3 次、间隔 400ms**。
- **这不是请求头的问题**（2026-11-04 对照实验：用最简 `UA: Mozilla/5.0` 从住宅宽带请求 7 个日期仍是 7/7 全中）。真正原因是上交所对**机房 / 共享出口 IP**的区别对待，改 UA 救不了，只能靠「重试 + 另一条通道复核」。
- **空结果绝不写入 KV 缓存**。上游失败被吞成 `200 + data: []` 并缓存 1 小时，下游就会认定「当天确实没有数据」，于是一整天反复拿到同一份空表而毫无报警 —— 2026-11-04 实测 9 天里有 5 天就这么静默丢了。
- 因此：**`data: []` 不等于「这天没数据」**。上游确实失败时会额外带 `upstream_error` 字段说明原因；看到它就该换源复核，而不是当空值用。

### `GET /api/fund-flow` — 个股 / ETF 资金流（日度四档单净额）

| 参数 | 说明 | 默认 |
|---|---|---|
| `code` | 6 位代码，支持 `sh/sz/bj` 前缀或后缀 `.SH` 等写法 | `510300` |
| `days` | 取最近 N 日（1–240） | `60` |

直连新浪 `MoneyFlow.ssl_qsfx_zjlrqs`。`code` 自动按号段推导市场前缀（`5/6/9` → `sh`，`8/92` → `bj`，其余 → `sz`）。`net_amount` 单位**元**，另含 `r0_net`（超大单净额）、`net_ratio`（净额占成交额比）。

### `GET /api/research` — 研报（含评级 / 目标价 / 机构）

| 参数 | 说明 | 默认 |
|---|---|---|
| `code` | 6 位股票代码（个股研报） | `600519` |
| `pages` | 翻页数（1–10，每页 100 条） | `3` |
| `qType` | `0` 个股研报 / `1` 行业研报 | `0` |
| `industry` | 行业研报时的东财行业码（如 `1238`），或 `*` 全行业 | `*` |

直连东财 `reportapi.eastmoney.com`。字段：`date / title / org / rating / industry / eps_this_year / eps_next_year / pdf_url`。

### `GET /api/fund-nav` — 基金 / ETF 净值历史

| 参数 | 说明 | 默认 |
|---|---|---|
| `code` | 6 位基金代码（如 `510300`） | `510300` |
| `start` / `end` | 日期过滤 `YYYY-MM-DD` | 空（全历史） |

直连东财 `fund.eastmoney.com/pingzhongdata`，解析 `Data_netWorthTrend`。返回 `{date, nav, acc_nav, equity_return}`。

> **时区坑**：`Data_netWorthTrend[].x` 是「北京零点」的时间戳（等价 UTC-16:00），必须 `+8h` 再取日期，否则整段净值错位一天、和交易日历对不上。改这段代码时务必保留该修正。

### `GET /api/trade-calendar` — 交易日历

| 参数 | 说明 | 默认 |
|---|---|---|
| `start` / `end` | 区间 `YYYY-MM-DD` | `2010-01-01` / 今天 |

**不依赖额外上游**：直接从上证指数（`sh000001`）日 K 线派生——有 K 线的日期即交易日。返回升序日期数组。

### `GET /api/bond-yield` — 中国国债收益率（可选含美国）

| 参数 | 说明 | 默认 |
|---|---|---|
| `start` | 起始日 `YYYY-MM-DD` | `2015-01-01` |
| `include_us` | `1` 则附带美国国债列 | `0` |
| `max_pages` | 翻页上限（每页 500 行） | `12` |

东财 datacenter `RPTA_WEB_TREASURYYIELD`。返回 `{date, cn_2y, cn_5y, cn_10y, cn_30y, cn_10y_2y, cn_gdp_yoy}`（%，`include_us=1` 时再加 `us_*`）。

### `GET /api/margin-account` — 两融账户统计

| 参数 | 说明 | 默认 |
|---|---|---|
| `start` | 起始日 `YYYY-MM-DD` | `2018-01-01` |
| `max_pages` | 翻页上限（每页 500 行） | `10` |

东财 datacenter-web `RPTA_WEB_MARGIN_DAILYTRADE`。返回 `{date, fin_balance, loan_balance, fin_buy_amt, loan_sell_amt, securities_orgs, business_depts, personal_investors, org_investors, active_investors, liable_investors, total_guarantee, avg_guarantee_ratio}`（余额约亿元、投资者数约万户，以上游原值为准）。

### `GET /api/market-turnover` — 两市成交额

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbols` | 腾讯格式代码（逗号分隔），也兼容东财 `secids=1.000001` 写法 | `sh000001,sz399001` |

腾讯行情 `qt.gtimg.cn`（零鉴权、不封 IP，GBK 需用 `TextDecoder("gbk")` 解码）。返回各指数 `{code, name, price, amount}` 与合计 `total_amount`（单位：元）。默认「上证指数 + 深证成指」，两者之和即两市成交额。

> 东财 push2 对 Cloudflare 出口 IP 有 WAF 拦截（502），故成交额走腾讯。

---

## 3. 单位与口径约定（改代码前必须核对）

| 端点 / 字段 | 单位 | 换算 |
|---|---|---|
| `etf-shares` → `shares_10k` | **万份** | 转「份」需 × 10000 |
| `fund-flow` → `net_amount` | 元 | — |
| `market-turnover` → `amount` / `total_amount` | 元 | 腾讯字段 35 的第 3 段 |
| `bond-yield` → `cn_*` | % | — |
| `margin-account` → `*_balance` | 上游原值（约亿元） | 不换算 |
| `kline` → `volume` | 手 | — |
| `fund-nav` → `nav` | 元 | 日期需 +8h 修正 |

> **教训**：akshare 那套函数里藏着大量 ×10000 / ÷1e8，迁移时逐位对齐过才敢换源。任何涉及份额、金额的改动，都要拿一个已知值反算验证。

---

## 4. 上游映射表（同步时照这张表定位）

上游仓库：`simonlin1212/a-stock-data` → 文件 `SKILL.md`（有 `§` 章节号）与 `CHANGELOG.md`（版本变更）。
下表把**本仓库每个端点**映射到**上游对应章节**，同步时只读这些章节，不必通读 44 万字的 SKILL.md。

| 本仓库端点 | 上游函数 | 上游 § | 上游真实来源 | 备注 |
|---|---|---|---|---|
| `/api/kline` | `tencent_kline(code, period, adjust, start, end, count)` | **1.2** | 腾讯 K 线（多 host 轮换） | 我们不支持复权参数 |
| `/api/etf-shares`（SH） | `etf_shares(date, exchange)` | **4.7** | `query.sse.com.cn` | 单位万份，一致 |
| `/api/etf-shares`（SZ） | `etf_shares(date, exchange)` | **4.7** | `fund.szse.cn` | 只有当前快照 |
| `/api/fund-flow` | `stock_fund_flow_120d(code)` / `fund_flow_backup` | **4.5** / 备用源 | 新浪 MoneyFlow | 我们的天数上限 240 |
| `/api/research` | `eastmoney_reports` / `eastmoney_industry_reports` | **2.1** | `reportapi.eastmoney.com` | 上游另有 `sina_research_reports`(§2.4) 无评级 |
| `/api/fund-nav` | *（无直接对应）* | — | `fund.eastmoney.com/pingzhongdata` | 上游 §1.6 是复权因子，不是净值 |
| `/api/trade-calendar` | `trading_calendar(year, month)` | **12.4** | 深交所官方整月 | 我们用上证 K 线派生（更省一次上游） |
| `/api/bond-yield` | `chinabond_yield_curve(start, end, curve)` | **11.3** | 中债 | 我们走东财 datacenter |
| `/api/margin-account` | `margin_trading(code)` / `margin_trading_backup` | **4.1** / 备用源 | 东财 / 交易所官方 | 上游是**个股明细**，我们是**市场总量** |
| `/api/market-turnover` | *（无直接对应）* | — | `qt.gtimg.cn` | 上游有 `tdx_daily_package`(§1.3) 可算，但太重 |
| `/api/csindex` | *（无直接对应）* | — | `csindex.com.cn` | 上游 §12 只有成分/权重/估值，没有自定义指数日线 |

**「无直接对应」的四个**（`fund-nav` / `market-turnover` / `csindex` / `margin-account` 的市场总量视角）是我们自己实现的，上游更新通常不影响它们；但要留意上游若新增同类端点，优先改用上游写法以便统一维护。

---

## 5. 给 AI 的同步提示词（复制即用）

上游发新版后，把下面整段连同**新版本号**一起丢给 AI：

```text
你正在维护 jw624/a-stock-api —— 一个 Cloudflare Worker 写的 A股数据源代理。
上游技能包 simonlin1212/a-stock-data 已发布新版本，需要把「与本仓库已有端点相关」的变更同步过来。

请严格按本仓库 README.md 的「§6 维护 Runbook」执行，并遵守「§0 铁律」。

【第一步：判定影响面】
1. 读上游 CHANGELOG.md（GitHub: simonlin1212/a-stock-data），逐条判断是否影响本仓库已有端点。
   判定依据用 README「§4 上游映射表」的上游 § 号。
2. 与期货、可转债、龙虎榜、财报、公告、期权、宏观、新闻等无关的条目，一律跳过，
   不要顺手把这些功能加进本仓库（本仓库只做看板需要的 10 类数据）。
3. 输出一份「受影响端点清单」，每个端点写明：上游 §号、改了什么、我方是否需要跟进。

【第二步：逐端点比对】
对于每个受影响端点，定位到上游 SKILL.md 的对应 § 章节，逐项比对：
  - 请求 URL / host / 参数名
  - 响应字段名（上游改了字段名，我方必须跟着改映射）
  - 单位与换算（万份/元/%、×10000、÷1e8 之类）
  - 日期口径（是否 +8h 时区修正、是否 UTC）
  - 分页方式、单页上限、限流阈值
只改 worker.js 里对应的 fetchXxx() 函数（用 grep -n "async function fetchXxx" 定位）。

【第三步：本地验证（必做）】
- node --check worker.js 先过语法。
- 从本机直连上游真实 URL，用与 Worker 相同的参数请求一次，打印前 2 条记录，
  与改动前的输出逐字段对比（数值、单位、日期）。
- 注意：沙盒/CI 里通常访问不到 *.workers.dev，验证 Worker 请用 README「§9 读 KV 值」的办法，
  或让用户在浏览器里打开端点 URL 确认。

【第四步：部署】
两种方式二选一，最终必须让「GitHub 上的 worker.js」与「线上版本」一致：
  A) git push 到 main，等 GitHub Actions「Deploy to Cloudflare Workers」跑完（推荐）
  B) 本地 CLOUDFLARE_API_TOKEN=... npx wrangler deploy，然后再 git push
     （只做 B 不做 push 会造成仓库与线上不一致，下次别人 push 会把你的改动覆盖回去）

【第五步：收尾】
- 更新 README「§4 上游映射表」（如果上游 §号或函数名变了）与「§13 变更记录」。
- 若端点行为有变化（尤其空值语义、单位、字段名），在 README 对应端点下写清楚，
  并提醒用户去改下游仓库。

【绝对不要做】
- 不要改变 /api/* 的响应 JSON 字段名与单位（会静默打断下游 4 个看板，见 §11）。
- 不要移除「空结果不写入 KV 缓存」的逻辑（见 §9）。
- 不要引入 npm 依赖（纯 Workers 运行时，没有 node_modules）。
- 不要把 Cloudflare Token / GitHub PAT 写进代码或提交记录。
- 不要一次性搬上游的全部功能。
```

---

## 6. 维护 Runbook：上游发新版后怎么同步

### Step 0 · 判断要不要动

```bash
# 看上游客服端版本与变更（浏览器打开即可，或 API 取）
https://github.com/simonlin1212/a-stock-data/blob/main/CHANGELOG.md
```

只看**最新版本**那一节。若条目全落在本仓库未覆盖的领域（期货/期权/可转债/财报/公告/龙虎榜/宏观/新闻…），**结论就是「不动」**，这是最常见的情况。

### Step 1 · 取上游原文

- `CHANGELOG.md` → 变更概述（约 90 KB，读最新一节即可）
- `SKILL.md` → 具体实现（约 44 万字符，**一定按 `§` 号局部定位**，别整篇读）
- 上游有 `tests/` 目录，里面有离线用例可直接借来验证字段映射

### Step 2 · 定位我方代码

```bash
grep -n "async function fetch" worker.js     # 列出所有取数函数
grep -n 'url.pathname === "/api/' worker.js  # 列出所有路由
```

一个端点 = 一个 `fetchXxx()` + 一个 `if (url.pathname === "/api/xxx")` 分支，两者通常挨着。

### Step 3 · 改代码

改 `fetchXxx()` 里的 URL / 参数 / 字段映射。**路由分支只在新增端点时才动。**

### Step 4 · 本地验证

```bash
node --check worker.js          # 语法
```

再用 Python/Node 直接请求上游真实 URL，与改动前的输出对比。仓库里没有测试框架，**验证靠「拿真实数据对拍」**，这是本项目一贯做法：

```python
import requests
r = requests.get(UPSTREAM_URL, params=P, headers=H, timeout=30)
rows = r.json()["result"]
print(len(rows), rows[0])       # 行数 + 首条，逐字段核对
```

### Step 5 · 部署

```bash
# 方式 A（推荐）：push 触发 GitHub Actions 自动部署
git push origin main

# 方式 B：本地直接部署
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=3242358d09b1b6024863cfdf939def5d \
  npx --yes wrangler deploy
```

> **陷阱**：`deploy.yml` 监听 `push: main`。如果你只本地 `wrangler deploy` 而没 push，仓库代码就是旧的，下一个人 push 会把你线上的改动覆盖掉。**两种方式必须最终让两边一致。**

### Step 6 · 线上验证

见 §9「验证 Worker 输出的三种办法」。要验证的点固定是三个：

1. `count` 是否合理（不是 0、也不是几百行变成几十行）
2. 抽 1~2 个已知标的的数值是否与上游原始值逐位相同
3. 响应里没有 `upstream_error`、不是 `cached: true` 的陈旧值

### Step 7 · 同步文档

- `README.md` §4 映射表、§13 变更记录
- 若响应字段/单位有变 → 明确告知需要改的下游仓库（§11）

### 定义完成（DoD）

- [ ] `node --check` 通过
- [ ] 受影响端点的线上响应 `count` 合理、抽样数值与上游一致
- [ ] 无 `upstream_error`
- [ ] GitHub `main` 与线上版本一致（Actions 跑绿）
- [ ] README 映射表与变更记录已更新
- [ ] 若影响了响应结构，已通知下游

---

## 7. 代码结构导览（worker.js，约 760 行）

单文件，无依赖。按顺序大致是：

| 区块 | 内容 | 定位 |
|---|---|---|
| 常量区 | `KLINE_HOSTS` / `CSINDEX_URL` / `MAX_CHUNK` 等上游地址 | 文件头 |
| 工具函数 | `json()` 统一响应、`normDate/decDate` 日期处理 | `function json` |
| K 线 | `tencentKlineChunk` → `fetchKlineFull`（分页拼全量） | `async function fetchKline` |
| 中证 | `fetchCsindex` | 同上 |
| 通用请求 | `gfetch(url, headers, ms)` —— **带 20s 超时的统一出口，新端点都用它** | `async function gfetch` |
| ETF 份额 | `fetchSseEtfShares` / `fetchSzseEtfShares`（后者要翻页取快照） | 同名 |
| 资金流 | `sinaFlowPrefix` + `fetchFundFlow` | 同名 |
| 研报 | `emNormCode` + `fetchResearch` | 同名 |
| 东财数据中心 | `DC_URL` / `DC_WEB_URL` + `fetchFundNav` / `fetchTradeCalendar` / `fetchBondYield` / `fetchMarginAccount` | 同名 |
| 成交额 | `fetchMarketTurnover`（腾讯 GBK） | 同名 |
| 路由 | `export default { async fetch(request, env, ctx) }`，`if (url.pathname === "/api/xxx")` 串联，每个分支自带 KV 读写 | 文件后半 |
| 根路径 | `/` 返回端点索引（自描述，便于人工排查） | 末尾 |

**新增一个端点的标准动作**：加一个 `fetchXxx()`（用 `gfetch`）→ 加一个路由分支（含 KV 缓存 + CORS）→ 在 `/` 的索引里登记 → 更新 README。

---

## 8. 部署与凭证

### 配置（`wrangler.toml`）

```toml
name = "a-stock-api"
main = "worker.js"
compatibility_date = "2026-01-01"
account_id = "3242358d09b1b6024863cfdf939def5d"

kv_namespaces = [
  { binding = "CACHE", id = "77fd8e2bda9a4fc5bb032c69e88973bc" }
]
```

- KV 命名空间名：`a-stock-api-cache`，绑定名 `CACHE`
- 线上地址：`https://a-stock-api.wj4020410.workers.dev`

### 方式 A：本地 wrangler

```bash
npm install -g wrangler        # 或直接用 npx --yes wrangler deploy
wrangler login                 # 或设置 CLOUDFLARE_API_TOKEN
wrangler deploy
```

### 方式 B：GitHub Actions 自动部署（当前生效）

`push` 到 `main` 即触发 `.github/workflows/deploy.yml`。需要的两个 Secret（已配置）：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### 凭证纪律

Cloudflare API Token 与 GitHub PAT **只存在本地环境变量 / GitHub Secrets**。`worker.js` 里不允许出现任何 token（历史审计过一次，确认干净）。

> 补充：本 Worker 是纯数据代理，**不调用任何 Workers AI 模型**，所以 Cloudflare 后台的「Neurons 使用量」恒为 0，是正常现象，不代表额度被谁用掉了。

---

## 9. 缓存策略与 KV 操作

### TTL 一览

| 端点 | TTL |
|---|---|
| 绝大多数端点 | 3600s（1 小时） |
| `/api/market-turnover` | 300s（5 分钟，行情类） |

进程内还有一层：K 线分页 / 深交所翻页时用 `Promise.all` 并发拉取，单次请求的子请求数要控制在免费额度内（50）。

### 铁律：空结果不写缓存

```js
// /api/etf-shares 里的写法，其他端点如需可照抄
if (combined.length > 0) {
  ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
}
```

原因见 §2 `etf-shares` 的容错约定：空表一旦被缓存，下游会把「故障」当成「当天没数据」，**静默丢数据且不报警**。
上游失败时额外回 `upstream_error` 字段，让「空」和「失败」在语义上可区分。

### 验证 Worker 输出的三种办法

1. **浏览器直接开端点 URL**（最直观，用户侧一条链接就能确认）
2. **读 KV 里的缓存值**（沙盒访问不到 `workers.dev` 时最可靠）

```python
import requests, urllib.parse, json
TOK, AID, NS = "<cf_token>", "3242358d09b1b6024863cfdf939def5d", "77fd8e2bda9a4fc5bb032c69e88973bc"
key = "etfshares:SH:2026-11-03:"
r = requests.get(
    f"https://api.cloudflare.com/client/v4/accounts/{AID}/storage/kv/namespaces/{NS}/values/"
    + urllib.parse.quote(key, safe=""),
    headers={"Authorization": "Bearer " + TOK}, timeout=60)
print(json.dumps(r.json(), ensure_ascii=False)[:400])
```

3. **`wrangler tail`** 看实时日志（需要能连上 Cloudflare）

> 实测无效的办法：`wrangler dev --remote` 在受限网络下会报 `ProxyWorker internal error`，不要依赖它验证。

### 列出 / 删除缓存键

```bash
# 列出（注意 --remote，否则读的是本地模拟 KV）
npx wrangler kv key list --namespace-id=77fd8e2bda9a4fc5bb032c69e88973bc --remote
```

批量删除用 REST API，**body 必须是纯字符串数组**（踩过坑：`{"keys":[...]}` 和 `[{"name":...}]` 都会报 `sgw.KeyName` 反序列化失败）：

```python
requests.post(
  f"https://api.cloudflare.com/client/v4/accounts/{AID}/storage/kv/namespaces/{NS}/bulk/delete",
  headers={"Authorization": "Bearer " + TOK},
  json=["etfshares:SH:2026-11-03:", "etfshares:SH:2026-11-02:"])   # ← 裸数组
```

> KV 写是最终一致的（跨边缘节点最多约 60s），删除后短时间内 `key list` 仍可能列出旧键，属正常。

---

## 10. 排障手册

| 症状 | 判定 | 处置 |
|---|---|---|
| `{"count":0,"data":[],"cached":true}` | **陈旧毒缓存**（旧版把空表写进了 KV） | 对比 payload 里的 `updated` 与修复部署时间；删掉该前缀的 KV 键（§9） |
| `{"count":0,"data":[],"upstream_error":"..."}` | 上游此刻真的拒了（重试 3 次都没成） | 稍后重试；若持续，说明出口 IP 被限，改用别的通道或换时段 |
| `data` 有值但数值明显偏大/偏小 1 万倍 | 单位换算错（万份 ↔ 份） | 回到 §3 核对，用已知标的反算 |
| `/api/market-turnover` 返回 `turnover HTTP 502` | 走到东财 push2 了（WAF 拦 Cloudflare） | 必须走腾讯 `qt.gtimg.cn`，别改回 push2 |
| 某个"新功能"端点返回 401 | 上游有反爬（如乐咕乐股 `acw_tc` 阿里云盾） | 放弃该端点并在 §12 登记原因，别硬扛 |
| 部署成功但行为没变 | 只本地 deploy 未 push，或 Actions 还在跑 | 看 Actions 状态；或确认 `wrangler deploy` 输出的 Version ID 已变 |
| 全市场快照类需求做不出来 | 东财单页强制 100 条，5900 只需 60 页 > 免费 Worker 子请求上限 | 见 §12，用替代端点 |

---

## 11. 下游消费者（改响应结构前必读）

| 仓库 | 用到的端点 | 不能破坏的点 |
|---|---|---|
| `wj624/rotation-monitor` | `kline` / `csindex` | K 线字段名与日期格式（`date/open/close/high/low/volume`） |
| `wj624/national-team-etf-flow` | `etf-shares`(SH, SZ→仓库内直连) / `fund-nav` / `trade-calendar` | `shares_10k` 单位、`nav` 时区 |
| `wj624/etf-lsi` | `etf-shares`(SH) / `fund-nav` / `trade-calendar` | 同上；且它按「空表必须复核」的语义写的，别把 `upstream_error` 去掉 |
| `wj624/earl-etf-dashboard` | 计划接入 bond-yield / margin-account / market-turnover | 尚未迁移，字段可协商 |

> `national-team-etf-flow` 与 `etf-lsi` 都**只依赖 Worker、或 Worker + 直连双通道**，没有第三层兜底。任何"看起来无害"的空值语义改动，都会直接变成它们的静默数据缺口。

---

## 12. 已知未实现（及原因，别重复尝试）

| 端点 | 为什么不提供 |
|---|---|
| `/api/index-valuation`（指数历史 PE/PB） | 上游乐咕乐股有阿里云反爬（`acw_tc` 挑战），即便先取页面 CSRF+Cookie，API 仍返回 401。Cloudflare 侧无法稳定复刻 |
| `/api/spot`（全市场逐股快照） | 东财 push2 强制 100 条/页，全市场 5900+ 只需 60 页，超出免费 Worker 单请求子请求上限。成交额需求请用 `/api/market-turnover` |
| `/api/etf-shares` 深交所**历史** | 深交所 `fund.szse.cn` 只给当前快照；历史需走 `www.szse.cn/api/report/ShowReport?...CATALOGID=scsj_fund_jjgm` 的 **xlsx**（`SHOWTYPE=JSON` 返回 500）。Worker 里解析 xlsx 不稳，已改由各仓库**自行直连解析**（`national-team-etf-flow` / `etf-lsi` 均如此） |

---

## 13. 变更记录（本仓库）

| 日期 | 变更 |
|---|---|
| 2026-11 上旬 | 初版 10 端点：kline / csindex / etf-shares / fund-flow / research / fund-nav / trade-calendar / bond-yield / margin-account / market-turnover |
| 2026-11-04 | `market-turnover` 从东财 push2 改腾讯（push2 WAF 502） |
| 2026-11-04 | `etf-shares`：空结果不再写 KV；失败回 `upstream_error`；上交所请求重试 3 次/400ms；请求头与本机客户端对齐（附对照实验：根因是出口 IP 而非 UA） |

---

## License

Apache-2.0。见 [LICENSE](./LICENSE)。取数逻辑改编自 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（Apache-2.0）。
