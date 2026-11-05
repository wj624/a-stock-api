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

### `GET /api/index-valuation` — 指数估值（PE/PB 及历史分位）

| 参数 | 说明 | 默认 |
|---|---|---|
| `codes` | 指数代码，逗号分隔。接受 `SH000300` / `sh000300` / `000300` 三种写法 | `SH000300,SZ399006` |

上游 `danjuanfunds.com/djapi/index_eva/detail/{code}`（免 Key）。**这是 legulegu（云端 401）与中证官网（估值页改版、接口 404）的替代源。**

```json
{"count":2,"unit":{"pe_pct":"0~1, 越大越贵","roe":"小数(0.0993=9.93%)","dividend_yield":"小数","peg":"倍"},
 "data":[{"code":"SH000300","name":"沪深300","date":"2026-11-03","pe":13.504,"pb":1.3403,
          "pe_pct":0.6736,"pb_pct":0.2096,"pe_over_history":0.3264,"roe":0.0993,
          "dividend_yield":0.0302,"peg":0.9514,"level":"mid","level_int":1}]}
```

> **两个分位字段互为倒数**：`pe_pct` + `pe_over_history` 恒等于 1。下游统一只用 `pe_pct`（0=最便宜，1=最贵）。
> 用错不会报错、数字也完全合理，只是把「贵」读成「便宜」——这是本端点最容易埋的坑。
> `upstream_bond_yield` 是上游字段，口径不明（常数级），**不要拿去算股债性价比**。

### `GET /api/cn-liquidity` — 境内资金面（SHIBOR + 银行间回购定盘）

| 参数 | 说明 | 默认 |
|---|---|---|
| `days` | 返回最近多少个交易日（5~250） | `60` |

上游中国货币网两个 form-urlencoded POST：`ShiborHis`（八期限）+ `FrrHis`（回购定盘）。

返回 `latest`（最新一天）、`derived`（派生指标，单位 bp）、`data`（按日期升序的序列）。字段含义写在响应的 `fields` 里。
**`FDR001/007/014` 就是 DR001/DR007/DR014**（存款类机构质押式回购定盘利率），DR007 是央行公开市场操作实际盯的锚。

| 关键限制 | 说明 |
|---|---|
| `FrrHis` 忽略 `startDate` | 永远只回最近约 **21 个交易日**，而 SHIBOR 能给 60+ 天。下游若把两者画一张图，左侧会出现「只有 SHIBOR、没有 DR007」的空白，需从首个 DR007 有效点起画 |
| 没有 OMO | 央行公开市场操作（净投放/回笼）的公开无 Key 接口未找到，暂不提供。资金面松紧用 DR007 相对 20 日均线的偏离代替 |

### `GET /api/etf-premium` — ETF 折溢价率

| 参数 | 说明 | 默认 |
|---|---|---|
| `codes` | 6 位代码或带市场前缀，逗号分隔，最多 30 个 | `510300,159919` |

> **折溢价 =（市价 − 净值）/ 净值 × 100**。价格取腾讯 `qt.gtimg.cn`（GBK），净值取东财 `pingzhongdata`。
> 没有用任何「实时 IOPV」接口——那类接口全在 `push2` 上，对 Cloudflare 出口 502。
>
> **`stale` 字段必须看**：价格日期与净值日期不同（盘中必然如此）时为 `true`，
> 此时该值只反映「相对上一日净值的偏离」，不能当收盘折溢价用。

### `GET /api/market-breadth` — 市场宽度（涨跌家数 / 涨停跌停 / 连板高度）

无参数。上游东财 `push2ex.eastmoney.com` 三个接口并发（涨跌幅分布 / 涨停池 / 跌停池），
**与已知被 WAF 拦的 `push2.eastmoney.com` 不同域名，实测 Cloudflare 出口可用。**

| 字段 | 口径 |
|---|---|
| `up` / `down` / `flat` / `total` | 由「涨跌幅分布直方图」求和。已与 push2 的 `f104/f105/f106` 交叉校验，差异 <2%（是否含北交所与停牌股） |
| `limit_up` / `limit_down` | 涨停池 / 跌停池的 `tc` |
| `max_streak` / `streak_dist` | 连板高度 = 池内 `lbc` 最大值；分布按 `lbc` 计数 |
| `history_supported` | **恒为 `false`** |

> **这三个接口忽略 `date` 参数，永远返回当日快照**（实测传 `20261103` 仍回 `qdate=20261104`）。
> 所以「回填历史」在数据源层面不可能，下游只能每天存一份自建序列。

---

### `GET /api/cn-rates` — 国债收益率曲线（尾部窗口 + 期限利差）

| 参数 | 默认 | 说明 |
|---|---|---|
| `days` | `250` | 保留最近多少个交易日，`20 ~ 1200` |

`/api/bond-yield` 的**轻量版**：同源（东财 `RPTA_WEB_TREASURYYIELD`），但只翻最少的页数、
只回尾部窗口，并且**派生期限利差**。250 天的数据量远小于 `bond-yield` 同期全量。

```json
{
  "days": 250, "count": 234,
  "latest": {"date":"2026-11-03","cn_2y":1.2274,"cn_5y":1.3307,"cn_10y":1.621,
             "cn_30y":2.0508,"cn_10y_2y":0.3936,"cn_5y_2y":0.1033,"cn_30y_10y":0.4298},
  "derived": {"cn_10y_chg_20d_bp":-6.1,"cn_10y_chg_5d_bp":-0.5,
              "cn_10y_2y_chg_20d_bp":-2.2,"cn_10y_ma20":1.6496,"inverted":false},
  "data": [ ... ]
}
```

| 字段 | 口径 |
|---|---|
| `cn_2y` / `5y` / `10y` / `30y` | 到期收益率 **%**（上游原值） |
| `cn_10y_2y` | 10Y−2Y 利差 **%**，上游自带；× 100 才是 bp |
| `cn_5y_2y` / `cn_30y_10y` | 本端点派生（上游没有），单位同为 **%** |
| `derived.*_bp` | 变化量，单位 **bp** |
| `derived.inverted` | `cn_10y_2y < 0` 即倒挂 |

> **两个坑**：① 上游偶发返回「只有 `date`、各期限全 `null`」的行（节假日/补数占位），
> 本端点会**整行剔除**——所以 `count` 会小于请求的 `days`（250 → 约 234），这是正常的，不是漏数。
> ② 利差列是「%」不是「bp」，`0.3936` 表示 39.4 bp；直接当 bp 用会小 100 倍，而且不报错。

### `GET /api/commodity-quote` — 商品实时 / 收盘快照

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbols` | 逗号分隔；国内主力连续 `AU0`/`AG0`/`SC0`，外盘连续 `GC`/`SI`/`CL`/`OIL` | 全部品种 |

新浪 `hq.sinajs.cn`（`nf_` / `hf_` 前缀，GBK）。返回 `{symbols, count, updated, note, data}`，每条含 `symbol/name/market/unit/venue` 与 `last/open/high/low/bid/ask/pre_settle/date/time`（国内另含 `volume/open_interest/avg_price`）；单品种缺失只记 `upstream_error`，不影响其余。

### `GET /api/futures-kline` — 期货主力连续日 K

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbol` | 主力连续代码，如 `AU0` / `AG0` / `SC0` / `RB0` / `M0` | `AU0` |
| `days` | 返回最近 N 条（1–6000） | `250` |
| `start` / `end` | 日期过滤 `YYYY-MM-DD` | 空 |

新浪 `InnerFuturesNewService` 主力连续（换月跳空、未复权）。返回 `{symbol, count, unit, note, updated, data}`，每条 `{date, open, high, low, close, settle, volume, open_interest}`；`settle` 上游给 0 时置 `null`。`start/end/days` 为本地裁剪全历史，不增加上游流量。

### `GET /api/sge-spot` — 上金所黄金 / 白银现货日线

| 参数 | 说明 | 默认 |
|---|---|---|
| `instrument` | `Au99.99` / `Au(T+D)` / `Ag(T+D)` / `Pt99.95` | `Au99.99` |
| `days` | 保留最近 N 条；`0` / 不传 = 全历史 | `0` |

上金所 `sge.com.cn/graph/Dailyhq`（POST，2016-12 起）。返回 `{instrument, count, unit, note, updated, data}`，每条 `{date, open, close, low, high}`；白银 `unit` 为元/千克、其余元/克，无成交日（全 0）已剔除。

### `GET /api/global-index` — 全球指数实时 / 收盘快照

| 参数 | 说明 | 默认 |
|---|---|---|
| `symbols` | 逗号分隔；`KOSPI` / `HSI` / `FTSE` | `KOSPI` |

新浪 `znb_` 前缀快照（GBK）。返回 `{symbols, count, updated, history_supported, note, data}`，每条含 `symbol/name/region` 与 `last/change/change_pct/open/pre_close/high/low/date/time`。`history_supported` 恒为 `false`（仅实时 / 收盘快照，无历史日 K）；`DJI` / `IXIC` / `N225` 在该前缀实测返回空，未列入。

### `GET /api/macro-ratios` — 跨资产比价（金银比 / 金油比 / 铜金比 + KOSPI/GOLD 信号）

无参数。外盘连续合约日 K（新浪 `GlobalFuturesService`）+ `znb_KOSPI` 快照。返回 `gold_silver` / `gold_oil` / `copper_gold` 三项各自 `{value, chg20_pct, pct250, min250, max250, asof, n}`，以及 `kospi_gold` 的 `{value, hi, lo, signal, dist_hi_pct, dist_lo_pct}`（固定阈值 1.85 / 1.10）；另含 `gold_close` / `kospi` / `asof` / `definitions` / `errs`。`pct250` 为近 250 交易日分位（0=最低，100=最高）。

---

## 3. 单位与口径约定（改代码前必须核对）

| 端点 / 字段 | 单位 | 换算 |
|---|---|---|
| `etf-shares` → `shares_10k` | **万份** | 转「份」需 × 10000 |
| `fund-flow` → `net_amount` | 元 | — |
| `market-turnover` → `amount` / `total_amount` | 元 | 腾讯字段 35 的第 3 段 |
| `bond-yield` → `cn_*` | % | — |
| `margin-account` → `*_balance` | 上游原值（约亿元） | 不换算 |
| `index-valuation` → `pe` / `pb` | 倍 | — |
| `index-valuation` → `pe_pct` / `pb_pct` | 0~1 分位 | × 100 得百分位；**越大越贵** |
| `cn-liquidity` → `dr007` / `shibor_*` | % 年化 | — |
| `cn-liquidity` → `derived.*_bp` | bp | 1bp = 0.01 个百分点 |
| `etf-premium` → `premium_pct` | % | 已乘 100，正=溢价 |
| `market-breadth` → 各家数 | 家 | 整数 |
| `cn-rates` → `cn_2y/5y/10y/30y` | % | — |
| `cn-rates` → `cn_10y_2y` / `cn_5y_2y` / `cn_30y_10y` | **%** | **×100 才是 bp** |
| `cn-rates` → `derived.*_bp` | bp | 已是 bp，别再乘 |
| `kline` → `volume` | 手 | — |
| `fund-nav` → `nav` | 元 | 日期需 +8h 修正 |

> **教训**：akshare 那套函数里藏着大量 ×10000 / ÷1e8，迁移时逐位对齐过才敢换源。任何涉及份额、金额的改动，都要拿一个已知值反算验证。

---

## 4. 上游映射表（同步时照这张表定位）

上游仓库：`simonlin1212/a-stock-data` → 文件 `SKILL.md`（有 `§` 章节号）与 `CHANGELOG.md`（版本变更）。
下表把**本仓库每个端点**映射到**上游对应章节**，同步时只读这些章节，不必通读 SKILL.md 全文。

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
| `/api/index-valuation` | *（上游用 legulegu）* | **§12.1** | `danjuanfunds.com` | 上游走 legulegu（云端 401），我们换蛋卷；字段名不同（`yeild` 是上游拼写） |
| `/api/cn-liquidity` | *（无直接对应）* | — | `chinamoney.com.cn` | 上游宏观章节只有美债/中债收益率，没有 SHIBOR/DR 资金面 |
| `/api/etf-premium` | *（无直接对应）* | — | 腾讯价 + 东财净值 | 上游 §12 有「指数估值」，但没有 ETF 折溢价 |
| `/api/market-breadth` | *（无直接对应）* | — | `push2ex.eastmoney.com` | 上游 §4 有涨停板类函数，但口径/字段不同 |
| `/api/cn-rates` | `chinabond_yield_curve` 的窄化版 | **11.3** | `datacenter-web.eastmoney.com` | 与 `/api/bond-yield` 同源同表，只回尾部窗口 + 派生利差 |

**「无直接对应」的八个**（`fund-nav` / `market-turnover` / `csindex` / `margin-account` 的市场总量视角，
以及 2026-11 新增的 `index-valuation` / `cn-liquidity` / `etf-premium` / `market-breadth`）是我们自己实现的，
上游更新通常不影响它们；但要留意上游若新增同类端点，优先改用上游写法以便统一维护。

> 2026-11 这四个端点**不来自上游 skill**，是自研的。同步上游时**不要**去 SKILL.md 里找它们的对应章节，
> 只在「上游是否新增了同类能力」这个角度扫一眼即可。

---

## 5. 给 AI 的同步提示词（复制即用）

上游发新版后，把下面整段连同**新版本号**一起丢给 AI：

```text
你正在维护 wj624/a-stock-api —— 一个 Cloudflare Worker 写的 A股数据源代理。
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

- `CHANGELOG.md` → 变更概述（读最新一节即可）
- `SKILL.md` → 具体实现（篇幅很长，**一定按 `§` 号局部定位**，别整篇读）
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

> **陷阱 1**：`deploy.yml` 监听 `push: main`。如果你只本地 `wrangler deploy` 而没 push，仓库代码就是旧的，下一个人 push 会把你线上的改动覆盖掉。**两种方式必须最终让两边一致。**
>
> **陷阱 2**：push 之后**必须去看 Actions 是否变绿**。2026-11-04 之前这个仓库的 Secret 是空的，
> 每次 push 部署都静默失败（只有最后一步红），线上版本靠人工本地部署维持。详见 §8。
>
> 验证部署真的生效：拿 `wrangler deploy` 输出（或 Actions 日志最后一行）的 Version ID，
> 与 `npx wrangler deployments list` 对比，或直接看端点响应里的数值是否已按新逻辑变化。

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

## 7. 代码结构导览（worker.js，行数以仓库实际文件为准）

单文件，无依赖。按顺序大致是：

| 区块 | 内容 | 定位 |
|---|---|---|
| 常量区 | `KLINE_HOSTS` / `CSINDEX_URL` / `MAX_CHUNK` 等上游地址 | 文件头 |
| 工具函数 | `json()` 统一响应、`normDate/decDate` 日期处理 | `function json` |
| K 线 | `tencentKlineChunk` → `fetchKlineFull`（分页拼全量） | `async function fetchKline` |
| 中证 | `fetchCsindex` | 同上 |
| 通用请求 | `gfetch(url, headers, ms)` —— **带 20s 超时，所有上游请求统一使用带超时的 gfetch** | `async function gfetch` |
| ETF 份额 | `fetchSseEtfShares` / `fetchSzseEtfShares`（后者要翻页取快照） | 同名 |
| 资金流 | `sinaFlowPrefix` + `fetchFundFlow` | 同名 |
| 研报 | `emNormCode` + `fetchResearch` | 同名 |
| 东财数据中心 | `DC_URL` / `DC_WEB_URL` + `fetchFundNav` / `fetchTradeCalendar` / `fetchBondYield` / `fetchMarginAccount` | 同名 |
| 成交额 | `fetchMarketTurnover`（腾讯 GBK） | 同名 |
| 缓存写入策略 | `shouldCacheDate` / `CACHE_FRESH_DAYS` —— 历史日期不写 KV（见 §9） | `function shouldCacheDate` |
| 估值 | `djIndexCode` + `fetchIndexValuation`（蛋卷） | 同名 |
| 资金面 | `gpost`（带 body 的 POST）+ `cmHistory` + `fetchCnLiquidity` | 同名 |
| 折溢价 | `txCode` + `fetchTxQuotes` + `fetchLatestNav` + `fetchEtfPremium`（含 `mapLimit` 并发闸门） | 同名 |
| 市场宽度 | `p2exGet` + `fetchMarketBreadth`（`Promise.allSettled`，允许部分成功） | 同名 |
| 国债曲线 | `fetchCnRates`（复用 `fetchBondYield`，只翻最少页数 + 剔除全空行 + 派生利差） | `async function fetchCnRates` |
| 日期工具 | `bjDate(ts)` 北京零点时间戳→日期、`bjToday()` 北京今天（**Worker 跑在 UTC，别直接 `toISOString`**） | 同名 |
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

`push` 到 `main` 即触发 `.github/workflows/deploy.yml`。需要的两个 Secret：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID` = `3242358d09b1b6024863cfdf939def5d`

> **2026-11-04 踩过的坑（务必先查这里）**：这两个 Secret 曾经是**空值**，导致
> `deploy.yml` 的每一步都"成功"，只有最后 `wrangler deploy` 失败，报：
>
> ```
> ✘ [ERROR] In a non-interactive environment, it's necessary to set
>   a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.
> ```
>
> 因为一直有人用本地 `wrangler deploy`，线上其实是新的、仓库却是靠手工同步，
> **自动部署形同虚设却没人发现**。排错顺序固定为：先看 `deploy.yml` 最后一步的日志，
> 再看 Secret 是否存在：
>
> ```bash
> gh api repos/wj624/a-stock-api/actions/secrets        # total_count 必须为 2
> ```
>
> 补 Secret 需要带 `secrets:write` 的 PAT，且值要用仓库公钥做 SealedBox 加密后
> `PUT /repos/{owner}/{repo}/actions/secrets/{name}`（`key_id` 与 `key` 取自
> `GET .../actions/secrets/public-key`）。**别把明文 token 交给任何第三方页面**。

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
| `/api/market-breadth` | 300s（盘中每分钟在变；拿不到有效分布时不写） |
| `/api/etf-premium` | 600s（净值一天只更新一次，价格收盘后不变） |
| `/api/cn-liquidity` | 1800s（资金价格日频） |
| `/api/cn-rates` | 3600s（日频，一天一变） |
| `/api/commodity-quote` | 300s（盘中实时价） |
| `/api/futures-kline` | 3600s（日频） |
| `/api/sge-spot` | 3600s（日频） |
| `/api/global-index` | 300s（实时快照） |
| `/api/macro-ratios` | 3600s（日频） |
| `/api/etf-shares`（历史日期） | **不写缓存**，见下 |

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

### 写配额：历史日期不写缓存

KV 免费额度是 **1000 次「写不同键」/天，且全账号共享**（读 10 万/天）。
`etf-shares` 回填 250 天就是 250 个键 = 250 次写，一天手动触发两轮就吃掉一半配额。

但**历史日期的份额抓过一次就永不变化**，给它写一个 1 小时 TTL 的便签纯属浪费。所以：

```js
const CACHE_FRESH_DAYS = 5;
function shouldCacheDate(dateStr) {   // 只有最近 5 个自然日内的日期才回写
  const m = String(dateStr || "").match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return true;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return (Date.now() - t) / 86400000 <= CACHE_FRESH_DAYS;
}
```

效果：250 天首轮回填的写入次数从 **250 次降到 5 次**，而为「最近几天会变」保留缓存的意义完全不变。

> 新增端点时沿用这个思路：**只缓存会变的东西**。日频、当日的写缓存；历史、一次性的不写。

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
| Actions 只有 `Deploy` 一步红，报 `necessary to set a CLOUDFLARE_API_TOKEN` | 仓库 Secret 为空（曾发生） | 按 §8 补 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` |
| 全市场快照类需求做不出来 | 东财单页强制 100 条，5900 只需 60 页 > 免费 Worker 子请求上限 | 见 §12，用替代端点 |

---

## 11. 下游消费者（改响应结构前必读）

| 仓库 | 用到的端点 | 不能破坏的点 |
|---|---|---|
| `wj624/rotation-monitor` | `kline` / `csindex` | K 线字段名与日期格式（`date/open/close/high/low/volume`） |
| `wj624/national-team-etf-flow` | `etf-shares`(SH, SZ→仓库内直连) / `fund-nav` / `trade-calendar` | `shares_10k` 单位、`nav` 时区 |
| `wj624/etf-lsi` | `etf-shares`(SH) / `fund-nav` / `trade-calendar` / **`index-valuation` / `cn-liquidity` / `etf-premium` / `market-breadth` / `cn-rates`** / `macro-ratios` | 同上；且它按「空表必须复核」的语义写的，别把 `upstream_error` 去掉。这 5 个新端点支撑看板 ⑨⑩⑪⑫⑬ 与邮件 ⑤ 板块——**任何一个失败都只让对应面板消失**，不会中断它整轮流水线 |
| `wj624/earl-etf-dashboard` | 计划接入 bond-yield / margin-account / market-turnover | 尚未迁移，字段可协商 |

> `national-team-etf-flow` 与 `etf-lsi` 都**只依赖 Worker、或 Worker + 直连双通道**，没有第三层兜底。任何"看起来无害"的空值语义改动，都会直接变成它们的静默数据缺口。

---

## 12. 已知未实现（及原因，别重复尝试）

| 端点 | 为什么不提供 |
|---|---|
| ~~`/api/index-valuation`~~ | **已实现（2026-11）**：legulegu 走不通（阿里云反爬 `acw_tc` + 401），中证官网估值页改版后接口全 404，最终改用**蛋卷基金** `danjuanfunds.com/djapi/index_eva/detail/{code}`，免 Key、含 PE/PB 双分位 + ROE + 股息率。原「做不到」的结论已作废 |
| 指数估值的**历史序列** | 蛋卷只给「最新一天 + 一条周频 PE 曲线（`pe_history`）」。要日频历史 PE/PB 曲线仍需付费源，暂不提供；当前靠 `pe_pct` 分位本身已能回答「现在贵不贵」 |
| 央行公开市场操作（OMO 净投放） | 中国货币网的 OMO 接口路径未找到（试过 8 个候选全 404），央行官网只有 HTML/PDF 公告。资金面松紧改用 DR007 相对 20 日均线的偏离表达 |
| `/api/spot`（全市场逐股快照） | 东财 push2 强制 100 条/页，全市场 5900+ 只需 60 页，超出免费 Worker 单请求子请求上限。成交额需求请用 `/api/market-turnover` |
| `/api/etf-shares` 深交所**历史** | 深交所 `fund.szse.cn` 只给当前快照；历史需走 `www.szse.cn/api/report/ShowReport?...CATALOGID=scsj_fund_jjgm` 的 **xlsx**（`SHOWTYPE=JSON` 返回 500）。Worker 里解析 xlsx 不稳，已改由各仓库**自行直连解析**（`national-team-etf-flow` / `etf-lsi` 均如此） |

---

## 13. 变更记录（本仓库）

| 日期 | 变更 |
|---|---|
| 2026-11 上旬 | 初版 10 端点：kline / csindex / etf-shares / fund-flow / research / fund-nav / trade-calendar / bond-yield / margin-account / market-turnover |
| 2026-11-04 | `market-turnover` 从东财 push2 改腾讯（push2 WAF 502） |
| 2026-11-04 | `etf-shares`：空结果不再写 KV；失败回 `upstream_error`；上交所请求重试 3 次/400ms；请求头与本机客户端对齐（附对照实验：根因是出口 IP 而非 UA） |
| 2026-11-04 | **修复自动部署**：仓库 Actions Secrets 一直为空，`deploy.yml` 的 `wrangler deploy` 从未成功；补齐后验证通过（Version ID `e20dd390`） |
| 2026-11-04 | README 重写为维护手册：AI 同步提示词、上游映射表、Runbook、排障手册、下游契约 |
| 2026-11-04 | **新增 4 个端点**（累计端点数以 §2 为准）：`index-valuation`（蛋卷估值）/ `cn-liquidity`（SHIBOR+DR007）/ `etf-premium`（价 vs 净值自算）/ `market-breadth`（push2ex 涨跌分布+涨停池+跌停池） |
| 2026-11-04 | `etf-shares` 缓存写入加 `shouldCacheDate`：历史日期不再写 KV，250 天回填的写次数 250 → 5 |
| 2026-11-04 | `deploy.yml` 加**部署后冒烟**：真打 13 个 check（以 `deploy.yml` 的 check 列表为准），结果写进 Step Summary。理由是「部署成功 ≠ 端点可用」——push2 那种「只有 Cloudflare 出口才被拦」的坑，本地怎么测都通 |
| 2026-11-04 | 首批下游接入：`wj624/etf-lsi` 新增 ⑨境内资金面 ⑩市场宽度 ⑪指数估值 ⑫ETF折溢价 四个看板面板 |
| 2026-11-04 | **新增 `/api/cn-rates`**（累计端点数以 §2 为准）：`bond-yield` 的轻量版——只回尾部窗口（数据量远小于同期全量）、剔除上游「只有日期、各期限全 null」的占位行、派生 `cn_5y_2y` / `cn_30y_10y` 与 bp 口径的变化量。下游 `wj624/etf-lsi` 接入 ⑬国债曲线面板 + 邮件 5.3 小节 |
| 2026-11-04 | `deploy.yml` 冒烟覆盖 13 个 check（以 `deploy.yml` 的 check 列表为准） |

---

## License

Apache-2.0。见 [LICENSE](./LICENSE)。取数逻辑改编自 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（Apache-2.0）。

---

## 附录 · 2026-11-05 全量整改记录（给维护者 / 给 AI 读）

> **这一节是什么**：AI 维护助手在 2026-11-05 对账号下 6 个仓库做完一次「大范围彻底修复」后追加的说明。目的只有一个——**让下一次维护（不管人或 AI）能看懂每个改动为什么做、哪些绝对不能回退**。
>
> **怎么读**：改任何代码之前，先读本 README 前文的「维护须知 / 铁律 / 给 AI 的维护提示词」，再读本附录。**两者冲突时以前文铁律为准**；本附录只解释本次改动，不新增、不覆盖任何设计口径。
>
> **本次原则**：用户要求「稳定、基本无维护、占用空间少、不自动生成垃圾」，并明确「修改前先看 README 的设计思路与维护须知」。因此本次只修**确定性 bug、静默失败、危险工作流行为、文档与代码不一致、依赖版本失控、运行时垃圾文件**；**没有做架构改造，没有删任何数据资产，没有改任何口径/阈值/单位/cron/构建顺序**。
>
> **本次改动范围**：6 仓共 40 个文件、0 删除；逐仓白名单精确提交，全程无 `--force`、无 rebase 冲突。**上线后的串行补测又追加了一次 pandas 3.x 兼容性修复（3 仓 6 文件，见 F 节），所以最终线上状态以 F 节为准，A 表里凡是写 `pandas<4` 的地方都已收紧为 `pandas<3`**。

### A. 本次改了什么（逐文件）

| 文件 | 原始缺陷（为什么必须改） | 本次修法 | 依据 / 约束 |
|---|---|---|---|
| `worker.js`（9 处） | 错误响应仍带 `public, max-age=300`，错误可能被 CDN 缓存；缺 CORS `Allow-Methods` / `Allow-Headers`；无 `OPTIONS` 预检；2 处裸 `fetch` 无超时会挂死；4 处默认日期用 UTC `toISOString().slice(0,10)`，北京时间凌晨会取到前一天 | 错误响应改 `Cache-Control: no-store`；成功响应补 `Access-Control-Allow-Methods: GET, OPTIONS` 与 `Allow-Headers: Content-Type`；`fetch()` 入口处理 `OPTIONS` 返回 204；裸 fetch 改带超时的 `gfetch(url, headers, 15000)`；默认日期改 `bjToday()`；根索引 `cn-rates` 文案由「利差 bp」改为「期限利差 %（×100 为 bp）」 | §0 铁律「响应结构是契约」「空结果不写 KV」「凭证不进代码」；§3 单位与口径约定 |
| `.github/workflows/deploy.yml`（2 处） | `cn-rates` 冒烟检查 `'"cn_10y":'`，但响应里并无该字段，会误判；`npm install -g wrangler` 无版本上界，未来主版本可能破坏部署 | 冒烟改验真实字段 `'"count":'`；锁 `wrangler@4` | §8 部署与凭证；部署后 13 个冒烟是唯一线上验收 |
| `README.md` | 账号名 `jw624` 拼错；缺 5 个端点契约与对应 TTL 行；下游消费者表缺 `/api/macro-ratios`；冒烟数量与行数/体积等数字过时 | 订正为 `wj624`；补 `commodity-quote` / `futures-kline` / `sge-spot` / `global-index` / `macro-ratios` 契约与 §9 TTL；补下游表；过时数字改定性描述 | §2 端点契约、§9 TTL 一览、§11 下游消费者 |
| `.gitignore`（新建） | 原本没有忽略规则，`node_modules/`、`.dev.vars`、`.wrangler/`、`*.log`、`__pycache__/` 会污染工作区 | 新建，只忽略运行时/本地产物 | 用户四原则「不自动生成垃圾」 |

### B. 本次坚决没改（硬约束，改了就是破坏设计）

- **响应字段名、单位、日期格式一律未改**（§0 / §2 / §3 是对下游的契约）。
- **「空结果不写 KV 缓存」与 `shouldCacheDate` 历史日期写配额未改**（§9 铁律）。
- **`cn_10y_2y` 等期限利差单位是 `%`，`×100` 才是 bp** —— 本次只改文案，未改数值口径。
- KV 命名空间绑定、`wrangler.toml`、凭证纪律（§8）未改。
- **`wrangler.toml` 的 `compatibility_date = "2026-01-01"` 是未来日期，本次特意未动**：改它会引入 Cloudflare Workers 运行时行为变化，需单独评估后再决定。

### C. 明令作废的旧建议（别再走回头路）

第一轮「只读体检报告」里提出过若干架构建议，**读完各仓 README 的维护须知后已全部作废**，本次一个都没采纳：

- ❌ **「产物不入库 / 数据与页面不进 git」**：本仓产物是 Pages / EdgeOne Pages / GAS 的**数据源本身**，从仓库检出，必须入库。
- ❌ **「删 `cache/` / 改回 `actions/cache`」**：`cache/` 是断网降级与历史累积的命根子。
- ❌ **「删数据资产 / 删摘要文件 / 清理 `echarts.min.js` / 删 `akshare` / 删 `westock-data`」**：均被 README 明确点名保护。
- ❌ **「把 `except: pass` 全改抛错」**：局部容错（TTL 状态、日志编码、临时文件清理、上游回退链）是设计，不是缺陷；本次只把**主流程**的静默失败改成显式失败。
- ❌ 早期报告曾把 GAS 脚本里的 `RECEIVER_EMAIL` 硬编码列为 bug —— **不是 bug**，它是 `CONFIG` 里明确列出的默认配置项，本次未改。

> 若下次 AI 读到 `wj624-仓库体检与整改思路.md` 或 `wj624-整改落地手册.md` 里的 P1/P2 建议，请以本附录为准：**那两份是整改前的中间产物，已作废**。


### D. 给 AI 的维护边界（可复制这段）

```
你在维护 wj624/a-stock-api（多个看板共用的只读代理）。动手前：
1. 先读 README §0 铁律、§2 端点契约、§3 单位与口径、§9 缓存策略，再读本附录。
2. 本附录 A 表的 9+2 处修复是 2026-11-05 已完成的事项，别当新问题重复改，也别回退。
3. 绝对不要：改响应字段名/单位/日期格式；让空结果写进 KV；把凭证写进代码；用 force push。
4. 只做「代理」，不做「功能扩张」；新增端点必须同步 §2 契约、§9 TTL、§11 下游表、deploy.yml 冒烟。
5. 改完必须：node --check worker.js；push 后确认 Deploy to Cloudflare Workers 的 13 个冒烟全绿。
6. 线上写操作：精确 git add、中文 commit、git pull --rebase、绝不 force。
```
### E. 验证与回滚

| 项目 | 说明 |
|---|---|
| 本地验证 | 补丁脚本在从原仓库 `git archive HEAD` 导出的**干净副本**上端到端重跑：59/59 替换、2 处追加、2 个新建 `.gitignore`、5 个 `monthly-snapshot.yml` 降级；`.py` 用 `ast.parse`、`worker.js` 用 `node --check`、`.yml` 用 `yaml.safe_load`，语法自检 26 项全 PASS |
| README 硬约束复核 | 61 项，实际 61/61 通过（初检 5 项 FAIL 均为检查规则误报） |
| 线上内容核验 | GitHub API 独立核验：commit 主题、变更文件集合与白名单逐仓一致、**0 删除**、关键修复内容、数据资产 12/12 在线 |
| 线上实测 | 2026-11-05 串行手动触发 4 个核心 workflow 并逐个核验：4/4 全部 success、每仓产物 commit 均 removed=0、关键数据资产完好。第一次补测在 rotation-monitor 暴露 pandas 3.x 移除 resample('M') 的问题，双保险修复后重跑通过。明细与最终线上 HEAD 见下方「F. 补测实测记录」 |
| 令牌 / 垃圾 | 交付文件 `ghp_` / `github_pat_` 0 命中；仓库内不生成 `__pycache__` |

**回滚**：优先 `git revert <整改 commit>` 生成反向 commit 再 push（保留历史、无需 force）。整改前基线 `5eb3e36`，整改 commit `daea02ad`（`git revert daea02ad`）。本次整改 commit 由 `push` 触发 `Deploy to Cloudflare Workers`，**已 `success`**，等于线上跑通 Worker 部署 + 13 个冒烟 + `OPTIONS` 预检 + `no-store` 头。

**下次改代码前的三行自检**（沿用前文铁律）：
1. 这个文件是源码还是产物？产物只能靠重跑生成，不能手改。
2. 改动会不会破坏「数据资产 / 口径 / 阈值 / 单位 / cron / 构建顺序」？会就停手。
3. 改完要跑什么验证、要同步 README 哪几节？写进 commit body。

### F. 补测实测记录（2026-11-05，含 pandas 3.x 兼容性二次修复）

整改 commit 上线后，用户要求对 4 个「`push` 不触发、只在 `schedule` / `workflow_dispatch` 跑」的核心抓数流水线做**串行手动触发补测**：一个跑完、核验通过，再触发下一个，避免并发写 `main` 冲突。

**第一次补测在 `rotation-monitor` 失败**，日志关键行：

```
ValueError: 'M' is no longer supported for offsets. Please use 'ME' instead.
  File ".github/workflows/generate_page.py", line 130, in ...
    monthly = bd.set_index('date')['close_cyb'].resample('M').last()
```

根因：pandas 3.1.1 于 2026-11-04 发布，移除了 `resample('M')` 别名，并默认开启 Copy-on-Write、改变字符串 dtype。**整改前依赖本无上界**；本轮整改把上界写成 `<4` 过宽，且 `daily_update.yml` 的 `pip install` 行仍是完全无上界 —— 这是策略失误，已按下面「双保险」纠正。

**双保险修复（3 仓 6 文件）**：

1. **代码**：`rotation-monitor/.github/workflows/generate_page.py` 的 `resample('M')` → `resample('ME')`（pandas 2.3.3 与 3.0.0 下语义一致，均为月末重采样，本地实测两种版本输出一致）。
2. **依赖**：所有 pandas 约束收紧为 `<3`，且 **`requirements.txt` 与 workflow 的 `pip install` 行两处同步** —— 线上实际执行的是 workflow 里的 pip install，不是 requirements.txt，只改一处等于没改。
3. **二次 commit**：`rotation-monitor` `ee80a439`、`earl-etf-dashboard` `af8b5237`、`national-team-etf-flow` `b0ef1c6c`。

**修复后重跑，4/4 全部通过**：

| 仓库 / workflow | run id | 结论 | 产物 commit（前 → 后） | 删除 | 关键资产 |
|---|---|---|---|---|---|
| `rotation-monitor` / `daily_update.yml` | 41990306988 | success | `ee80a439` → `1c6dd808` | 0 | `public/index.html` 完好 |
| `us-world-economy-dashboard` / `update.yml` | 41990418511 | success | `e9ee6da9` → `0b18f069` | 0 | `cache/` · `index.html` · `llms.txt` · `snapshot.md` · `version.txt` 完好 |
| `earl-etf-dashboard` / `update.yml` | 41990472730 | success | `af8b5237` → `abdee20d` | 0 | `cache/` · `version.txt` · `llms.txt` · `latest.json` · `index.html` 完好 |
| `national-team-etf-flow` / `daily-refresh.yml` | 41990810766 | success | `b0ef1c6c` → `5110f0f1` | 0 | `_etf_shares_cache.json` · `echarts.min.js` · `index.html` 完好 |

> `a-stock-api`（Worker 部署 + 13 个冒烟端点）与 `etf-lsi`（daily report）由 `push` 触发，整改当时即 `success`，不在上表。

**写本附录时各仓 `main` 的线上实况**（均为短 SHA，位数不影响定位）：

| 仓库 | 整改 commit | pandas 二次修复 | 补测产物 / 当前 HEAD |
|---|---|---|---|
| `a-stock-api` | `daea02a` | — | `daea02a` |
| `us-world-economy-dashboard` | `e9ee6da` | — | `0b18f06` |
| `earl-etf-dashboard` | `75255bd` | `af8b523` | `abdee20` |
| `national-team-etf-flow` | `016a401` | `b0ef1c6` | `5110f0f` |
| `rotation-monitor` | `b5f01af` | `ee80a43` | `1c6dd80` |
| `etf-lsi` | `606958f` | — | `8e8f74f`（自动产物 commit 会继续前移，属正常） |

> **给 AI 的硬约束**：这 3 个仓的 pandas **必须锁 `<3`**，不要「简化」成 `<4` 或去掉上界；`resample('ME')` 不要改回 `'M'`。改依赖时**必须同时改 `requirements.txt` 和 workflow 的 `pip install` 行** —— 第一次补测就是这样崩的。另外这 6 仓**没有单元测试套件**，上述「实测」指真实 workflow 执行 + 产物核验，改完代码仍应手动 dispatch 一次确认。
