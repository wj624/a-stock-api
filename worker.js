// a-stock-api — A股共享数据源 API（Cloudflare Worker）
// 取数逻辑改编自 simonlin1212/a-stock-data（Apache-2.0），并补充中证指数官方源。
// 数据源：
//   - 指数日K线 /api/kline：腾讯财经 web.ifzq.gtimg.cn（免Key、多 host 轮换）
//   - 中证自定义指数日线 /api/csindex：中证指数官网 csindex.com.cn（免Key）
//   - ETF 份额 /api/etf-shares：上交所 query.sse.com.cn（按日期历史） + 深交所 fund.szse.cn（当前快照）
//   - 个股资金流 /api/fund-flow：新浪 MoneyFlow.ssl_qsfx_zjlrqs（日度四档单净额）
//   - 研报 /api/research：东财 reportapi.eastmoney.com（含评级/目标价/机构）
//   - 基金净值 /api/fund-nav：东财 fund.eastmoney.com/pingzhongdata（Data_netWorthTrend）
//   - 交易日历 /api/trade-calendar：派生自上证指数日K线
//   - 国债收益率 /api/bond-yield：东财 datacenter（RPTA_WEB_TREASURYYIELD）
//   - 两融账户 /api/margin-account：东财 datacenter-web（RPTA_WEB_MARGIN_DAILYTRADE）
//   - 两市成交额 /api/market-turnover：腾讯行情 qt.gtimg.cn（指数实时成交额）
//   - 指数估值 /api/index-valuation：蛋卷基金 danjuanfunds.com（PE/PB 历史分位 + ROE + 股息率）
//   - 境内资金面 /api/cn-liquidity：中国货币网（SHIBOR 八期限 + 银行间回购定盘 FR/FDR）
//   - ETF 折溢价 /api/etf-premium：腾讯行情价 vs 东财 pingzhongdata 净值（自算，不依赖 IOPV）
//   - 市场宽度 /api/market-breadth：东财 push2ex（涨跌分布 + 涨停池 + 跌停池，仅当日快照）
//   - 国债曲线 /api/cn-rates：东财 datacenter 的尾部窗口切片（/api/bond-yield 的轻量版）
//   - 商品实时 /api/commodity-quote：新浪 hq.sinajs.cn（沪金/沪银/SC原油 + 纽约金银/WTI/布伦特）
//   - 期货日K /api/futures-kline：新浪 InnerFuturesNewService（主力连续，2005/2008 起）
//   - 上金所现货 /api/sge-spot：sge.com.cn/graph/Dailyhq（Au99.99 / Ag(T+D)，2016-12 起）
//   - 全球指数 /api/global-index：新浪 znb_（KOSPI / 恒生 / 富时100，仅实时）
//   - 跨资产比价 /api/macro-ratios：外盘日K（GC/SI/CL/OIL/HG/CAD）+ znb_KOSPI，
//     算金银比/金油比/铜金比的当前值、20日变化、250日分位，以及 KOSPI/GOLD 固定阈值信号
//
// 注意：本仓库是"代码老家"；真正被各看板调用的是「部署后的 Worker 网址」，不是 GitHub 仓库本身。

const KLINE_HOSTS = [
  "https://web.ifzq.gtimg.cn",
  "https://qt.gtimg.cn",
];
const CSINDEX_URL = "https://www.csindex.com.cn/csindex-home/perf/index-perf";

const MAX_CHUNK = 1200; // 单次向腾讯请求的最大条数（分页用）

// ── 工具 ────────────────────────────────────────────────────────
function json(data, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  };
  // 错误响应绝不进公开缓存；字段名 / 单位契约保持不变
  headers["Cache-Control"] = status === 200 ? "public, max-age=300" : "no-store";
  return new Response(JSON.stringify(data), { status, headers });
}

// 将 20260101 / 2026-01-01 之类统一成 YYYY-MM-DD
function normDate(d) {
  if (d == null) return "";
  d = String(d).trim();
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

function decDate(iso) {
  // iso: YYYY-MM-DD -> 前一天（用于分页游标）
  const t = new Date(iso + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

// ── 腾讯日K线（多 host 轮换 + 分页补足历史）──────────────────────
// 返回 [[date, open, close, high, low, volume], ...] 升序，失败返回 null
async function tencentKlineChunk(symbol, period, start, end, count) {
  const param = [symbol, period, start, end, count].join(",");
  let lastErr = null;
  for (const host of KLINE_HOSTS) {
    try {
      const url = `${host}/appstock/app/kline/kline?param=${encodeURIComponent(param)}`;
      const res = await gfetch(url, { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" }, 15000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (j.code !== 0) throw new Error("code " + j.code);
      const node = j.data && j.data[symbol];
      if (!node || !Array.isArray(node.day)) throw new Error("no day array");
      return node.day.map((r) => [
        String(r[0]),
        parseFloat(r[1]),
        parseFloat(r[2]),
        parseFloat(r[3]),
        parseFloat(r[4]),
        parseFloat(r[5]),
      ]);
    } catch (e) {
      lastErr = e;
    }
  }
  return null;
}

// 取 [start, end] 完整历史：腾讯可能从 end 向前返回，故必要时向前翻页补齐到 start
async function fetchKlineFull(symbol, period, start, end) {
  let all = [];
  let curEnd = end;
  for (let attempt = 0; attempt < 40; attempt++) {
    const chunk = await tencentKlineChunk(symbol, period, start, curEnd, MAX_CHUNK);
    if (!chunk || chunk.length === 0) break;
    if (all.length === 0) {
      all = chunk;
    } else {
      const oldest = all[0][0];
      const prefix = [];
      for (const r of chunk) {
        if (r[0] < oldest) prefix.push(r);
        else break;
      }
      if (prefix.length === 0) break; // 无更老数据，停止
      all = prefix.concat(all);
    }
    if (all[0][0] <= start) break; // 已覆盖请求的起始日
    curEnd = decDate(all[0][0]);
  }
  return all.length ? all : null;
}

// ── 中证指数官网（H30269 等自定义指数）─────────────────────────
async function fetchCsindex(symbol, start, end) {
  const url = `${CSINDEX_URL}?indexCode=${encodeURIComponent(symbol)}&startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`;
  try {
    const res = await gfetch(url, { "User-Agent": "Mozilla/5.0", "Referer": "https://www.csindex.com.cn/" }, 15000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const list = (j && (j.data || j.list)) || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const rows = list.map((item) => {
      // 兼容 list-of-dicts（现网）与 list-of-lists（旧 AKShare 形态）
      if (Array.isArray(item)) {
        return {
          date: normDate(item[0]),
          open: item[6] == null ? null : parseFloat(item[6]),
          high: item[7] == null ? null : parseFloat(item[7]),
          low: item[8] == null ? null : parseFloat(item[8]),
          close: item[9] == null ? null : parseFloat(item[9]),
          volume: item[12] == null ? null : parseFloat(item[12]),
        };
      }
      return {
        date: normDate(item.tradeDate ?? item.date ?? item["日期"]),
        open: item.open ?? item["开盘"] ?? null,
        high: item.high ?? item["最高"] ?? null,
        low: item.low ?? item["最低"] ?? null,
        close: item.close ?? item["收盘"] ?? null,
        volume: item.tradingVol ?? item.volume ?? item["成交量"] ?? null,
      };
    });
    return rows;
    } catch (e) {
      return null;
    }
  }

// ── 通用带超时的 fetch（避免上游卡死）─────────────────────────
async function gfetch(url, headers, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── ETF 份额：上交所历史(按日期) + 深交所当前快照 ─────────────
const SSE_ETF_URL = "https://query.sse.com.cn/commonQuery.do";
const SZSE_ETF_URL = "https://fund.szse.cn/api/report/ShowReport/data";

// 与国内本机可稳定跑通的 Python 客户端保持一致（完整 Chrome UA + Accept 通配符 + 全套 pageHelp 参数）。
// 2026-11-04 对照实验结论：**这不是成功率低的原因**——用旧版的 `UA: Mozilla/5.0` 从住宅宽带
// 请求 7 个日期同样是 7/7 全中。真正的原因是上交所对机房/共享出口 IP 的区别对待，
// 换请求头救不了，只能靠「重试 + 另一条通道复核」。
const SSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.sse.com.cn/",
  "Accept": "*/*",
};

async function fetchSseEtfShares(date) {
  // 参数与 akshare / 本机 Python 客户端逐项对齐（缺 pageHelp.pageNo、pageHelp.cacheSize 也会被挑剔）
  const url = `${SSE_ETF_URL}?isPagination=true&pageHelp.pageSize=10000`
    + `&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1`
    + `&sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`
    + `&STAT_DATE=${encodeURIComponent(date)}`;
  const res = await gfetch(url, SSE_HEADERS, 15000);
  if (!res.ok) throw new Error("SSE HTTP " + res.status);
  const j = await res.json();
  const rows = (j && j.result) || [];
  return rows.map((r) => ({
    exchange: "SH",
    date: r.STAT_DATE || date,
    code: r.SEC_CODE,
    name: r.SEC_NAME,
    etf_type: r.ETF_TYPE || "",
    shares_10k: r.TOT_VOL == null ? null : parseFloat(String(r.TOT_VOL).replace(/,/g, "")),
    source: "上交所",
  }));
}

async function fetchSzseEtfShares() {
  const base = `${SZSE_ETF_URL}?SHOWTYPE=JSON&CATALOGID=1000_lf&TABKEY=tab1&selectJjlb=ETF`;
  const p1 = await gfetch(`${base}&PAGENO=1`, {
    "User-Agent": "Mozilla/5.0", "Referer": "https://fund.szse.cn/",
  });
  if (!p1.ok) throw new Error("SZSE HTTP " + p1.status);
  const j1 = await p1.json();
  const arr = Array.isArray(j1) ? j1 : (j1.data || []);
  const meta = (arr[0] && arr[0].metadata) || {};
  const pageCount = parseInt(meta.pagecount || "1", 10);
  const snapshotDate = meta.subname || "";
  let rows = (arr[0] && arr[0].data) || [];
  // pagesize 强制 20，须翻页补齐 2..pageCount（分批并发，每批 10 页）
  const rest = [];
  for (let p = 2; p <= pageCount; p++) rest.push(p);
  for (let i = 0; i < rest.length; i += 10) {
    const slice = rest.slice(i, i + 10);
    const pages = await Promise.all(slice.map((p) =>
      gfetch(`${base}&PAGENO=${p}`, {
        "User-Agent": "Mozilla/5.0", "Referer": "https://fund.szse.cn/",
      }).then((r) => r.json()).then((j) => {
        const a = Array.isArray(j) ? j : (j.data || []);
        return (a[0] && a[0].data) || [];
      }).catch(() => [])
    ));
    for (const pg of pages) rows = rows.concat(pg);
  }
  const clean = rows.map((r) => {
    const code = (r.sys_key || "").match(/<u>(\d+)<\/u>/);
    const name = (r.jjjcurl || "").match(/<u>(.*?)<\/u>/);
    const sh = (r.dqgm || "").match(/>([\d.,]+)<\/a>/);
    return {
      exchange: "SZ",
      code: code ? code[1] : "",
      name: name ? name[1] : "",
      fund_category: r.tzlb || "",
      listing_date: r.ssrq || "",
      shares_10k: sh ? parseFloat(sh[1].replace(/,/g, "")) : null,
      manager: r.glrmc || "",
      nav: r.zxjjjz == null ? null : parseFloat(String(r.zxjjjz).replace(/,/g, "")),
      source: "深交所",
    };
  });
  return { snapshot_date: snapshotDate, rows: clean };
}

// ── 个股资金流：新浪日度四档单净额 ───────────────────────────
const SINA_FLOW_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs";

function sinaFlowPrefix(code) {
  const digits = String(code).replace(/[^0-9]/g, "");
  let pre;
  // 5xx=沪市ETF/LOF，6xx=沪市股票，9xx=沪市B股；8xx/92x=北交所；其余(0/1/2/3开头)=深市
  if (digits.startsWith("92") || digits.startsWith("8")) pre = "bj";
  else if (digits.startsWith("5") || digits.startsWith("6") || digits.startsWith("9")) pre = "sh";
  else pre = "sz";
  return pre + digits;
}

async function fetchFundFlow(code, days) {
  const daima = sinaFlowPrefix(code);
  const url = `${SINA_FLOW_URL}?page=1&num=${days}&sort=opendate&asc=0&daima=${daima}`;
  const res = await gfetch(url, {
    "User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/",
  });
  if (!res.ok) throw new Error("Sina HTTP " + res.status);
  let text = await res.text();
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  let arr = [];
  if (s >= 0 && e > s) arr = JSON.parse(text.slice(s, e + 1));
  else arr = JSON.parse(text);
  return arr.map((x) => ({
    date: x.opendate,
    close: x.trade == null ? null : parseFloat(x.trade),
    net_amount: x.netamount == null ? null : parseFloat(x.netamount), // 元
    turnover: x.turnover == null ? null : parseFloat(x.turnover),
    net_ratio: x.ratioamount == null ? null : parseFloat(x.ratioamount),
    r0_net: x.r0_net == null ? null : parseFloat(x.r0_net),
    r0_ratio: x.r0_ratio == null ? null : parseFloat(x.r0_ratio),
    r0x_ratio: x.r0x_ratio == null ? null : parseFloat(x.r0x_ratio),
  }));
}

// ── 研报：东财 reportapi（含评级/目标价/机构）─────────────────
const EM_REPORT_URL = "https://reportapi.eastmoney.com/report/list";

function emNormCode(code) {
  const m = String(code).match(/\d{6}/);
  return m ? m[0] : String(code).replace(/[^0-9]/g, "").slice(0, 6);
}

async function fetchResearch(code, pages, qType, industry) {
  const norm = emNormCode(code);
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const params = new URLSearchParams({
      industryCode: qType === 1 ? (industry || "*") : "*",
      pageSize: "100", industry: "*", rating: "*", ratingChange: "*",
      beginTime: "2000-01-01", endTime: "2030-01-01",
      pageNo: String(p), fields: "", qType: String(qType),
      orgCode: "", code: qType === 1 ? "" : norm, rcode: "",
      p: String(p), pageNum: String(p), pageNumber: String(p),
    });
    const res = await gfetch(`${EM_REPORT_URL}?${params.toString()}`, {
      "User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/",
    });
    if (!res.ok) throw new Error("EM HTTP " + res.status);
    const j = await res.json();
    const rows = j.data || [];
    for (const r of rows) {
      all.push({
        date: (r.publishDate || "").slice(0, 10),
        title: r.title,
        stock_code: r.stockCode,
        stock_name: r.stockName,
        org: r.orgSName || r.orgName,
        author: r.researcher || r.author,
        rating: r.emRatingName,
        rating_value: r.emRatingValue,
        industry: r.indvInduName,
        eps_this_year: r.predictThisYearEps == null ? null : parseFloat(r.predictThisYearEps),
        eps_next_year: r.predictNextYearEps == null ? null : parseFloat(r.predictNextYearEps),
        eps_next2_year: r.predictNextTwoYearEps == null ? null : parseFloat(r.predictNextTwoYearEps),
        info_code: r.infoCode,
        pdf_url: r.infoCode ? `https://pdf.dfcfw.com/pdf/H3_${r.infoCode}_1.pdf` : "",
      });
    }
    if (p >= (j.TotalPage || 1)) break;
  }
  return all;
}

// ══ 第二批：为国内看板补充的 A股端点 ════════════════════════════
const num = (v) => (v == null || v === "" ? null : (typeof v === "number" ? v : parseFloat(v)));
const DC_URL = "https://datacenter.eastmoney.com/api/data/get";
const DC_WEB_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";

// ── 基金净值历史：东财 pingzhongdata（Data_netWorthTrend）────────
async function fetchFundNav(code, start, end) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`;
  const res = await gfetch(url, { "User-Agent": "Mozilla/5.0", "Referer": "https://fund.eastmoney.com/" }, 25000);
  if (!res.ok) throw new Error("fund HTTP " + res.status);
  const text = await res.text();
  const extract = (varName) => {
    const i = text.indexOf(varName);
    if (i < 0) return [];
    const a = text.indexOf("[", i);
    if (a < 0) return [];
    const b = text.indexOf("];", a);
    if (b < 0) return [];
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return []; }
  };
  const navArr = extract("Data_netWorthTrend");   // [{x:ms, y:nav, equityReturn}]
  const accArr = extract("Data_ACWorthTrend");    // [[ms, accNav], ...]
  const accMap = {};
  for (const it of accArr) if (Array.isArray(it)) accMap[it[0]] = it[1];
  const out = [];
  for (const it of navArr) {
    if (it.x == null) continue;
    // x 为北京零点时间戳（UTC-16:00），+8h 后取日期才能与 akshare/交易日历对齐
    const d = new Date(it.x + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (start && d < start) continue;
    if (end && d > end) continue;
    out.push({ date: d, nav: num(it.y), acc_nav: accMap[it.x] != null ? num(accMap[it.x]) : null, equity_return: num(it.equityReturn) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// ── 交易日历：从上证指数 K 线派生（有 K 线即交易日）─────────────
async function fetchTradeCalendar(start, end) {
  const rows = await fetchKlineFull("sh000001", "day", start, end);
  if (!rows) return [];
  return rows.map((r) => r[0]);
}

// ── 国债收益率：东财 datacenter（中国 + 可选美国）───────────────
async function fetchBondYield(start, includeUs, maxPages) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const params = new URLSearchParams({
      type: "RPTA_WEB_TREASURYYIELD", sty: "ALL", st: "SOLAR_DATE", sr: "-1",
      token: "894050c76af8597a853f5b408b759f5d", p: String(p), ps: "500",
      pageNo: String(p), pageNum: String(p),
    });
    const res = await gfetch(`${DC_URL}?${params}`, { "User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/cjsj/zmgzsyl.html" });
    if (!res.ok) throw new Error("bond HTTP " + res.status);
    const j = await res.json();
    const rows = (j.result && j.result.data) || [];
    if (!rows.length) break;
    let oldest = null;
    for (const r of rows) {
      const d = (r.SOLAR_DATE || "").slice(0, 10);
      oldest = d;
      const row = {
        date: d,
        cn_2y: num(r.EMM00588704), cn_5y: num(r.EMM00166462), cn_10y: num(r.EMM00166466),
        cn_30y: num(r.EMM00166469), cn_10y_2y: num(r.EMM01276014), cn_gdp_yoy: num(r.EMM00000024),
      };
      if (includeUs) {
        row.us_2y = num(r.EMG00001306); row.us_5y = num(r.EMG00001308);
        row.us_10y = num(r.EMG00001310); row.us_30y = num(r.EMG00001312);
        row.us_10y_2y = num(r.EMG01339436); row.us_gdp_yoy = num(r.EMG00159635);
      }
      all.push(row);
    }
    if (oldest && oldest <= start) break;
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  return all;
}

// ── 两融账户统计：东财 datacenter-web ──────────────────────────
async function fetchMarginAccount(start, maxPages) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const params = new URLSearchParams({
      reportName: "RPTA_WEB_MARGIN_DAILYTRADE", columns: "ALL",
      pageNumber: String(p), pageSize: "500", sortColumns: "STATISTICS_DATE", sortTypes: "-1",
      p: String(p), pageNo: String(p), pageNum: String(p),
    });
    const res = await gfetch(`${DC_WEB_URL}?${params}`, { "User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/rzrq/zhtjday.html" });
    if (!res.ok) throw new Error("margin HTTP " + res.status);
    const j = await res.json();
    const rows = (j.result && j.result.data) || [];
    if (!rows.length) break;
    let oldest = null;
    for (const r of rows) {
      const d = (r.STATISTICS_DATE || "").slice(0, 10);
      oldest = d;
      all.push({
        date: d,
        fin_balance: num(r.FIN_BALANCE), loan_balance: num(r.LOAN_BALANCE),
        fin_buy_amt: num(r.FIN_BUY_AMT), loan_sell_amt: num(r.LOAN_SELL_AMT),
        securities_orgs: num(r.SECURITY_ORG_NUM), business_depts: num(r.OPERATEDEPT_NUM),
        personal_investors: num(r.PERSONAL_INVESTOR_NUM), org_investors: num(r.ORG_INVESTOR_NUM),
        active_investors: num(r.INVESTOR_NUM), liable_investors: num(r.MARGINLIAB_INVESTOR_NUM),
        total_guarantee: num(r.TOTAL_GUARANTEE), avg_guarantee_ratio: num(r.AVG_GUARANTEE_RATIO),
      });
    }
    if (oldest && oldest <= start) break;
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  return all;
}

// ── 两市成交额：腾讯行情 qt.gtimg.cn（指数实时成交额，零鉴权不封 IP）──
// 东财 push2 对 Cloudflare 出口 IP 有 WAF 拦截（502），改用腾讯；[35]="价格/成交量/成交额(元)"
async function fetchMarketTurnover(symbols) {
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(symbols)}`;
  const res = await gfetch(url, { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" });
  if (!res.ok) throw new Error("turnover HTTP " + res.status);
  const buf = await res.arrayBuffer();
  let text;
  try { text = new TextDecoder("gbk").decode(buf); } catch (e) { text = new TextDecoder("utf-8").decode(buf); }
  const rows = [];
  for (const seg of text.split(";")) {
    const s = seg.trim();
    const m = s.match(/^v_[a-z0-9]+="([\s\S]*)"$/);
    if (!m) continue;
    const parts = m[1].split("~");
    if (parts.length < 38) continue;
    const amountPart = (parts[35] || "").split("/")[2];
    const amount = amountPart ? parseFloat(amountPart) : (parts[37] ? parseFloat(parts[37]) * 10000 : null);
    rows.push({ code: parts[2], name: parts[1], price: num(parts[3]), amount: amount });
  }
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  return { rows, total };
}

// ═══ 2026-11 扩充：估值 / 境内资金面 / 折溢价 / 市场宽度 ═════════════
// 四个新端点的共同约定（与既有端点保持一致，下游据此写容错）：
//   1) 上游失败不返回「200 + 空数组」，而是带 upstream_error 字段说明原因；
//   2) 单位写进响应体（unit 字段），不靠文档口头约定；
//   3) 全失败不写 KV 缓存，避免把一次抖动放大成一小时的空表；
//   4) 时间戳一律换算成北京时间日期字符串，不把裸 unix 毫秒丢给下游。

// KV 免费额度是 1000 次「写不同键」/天且全账号共享；etf-shares 回填 250 天就是 250 次写。
// 但历史日期的份额抓过一次永不变化，给它写 1 小时 TTL 的便签纯属烧配额。
// 规则：只有最近 CACHE_FRESH_DAYS 个自然日内的日期才回写缓存。
const CACHE_FRESH_DAYS = 5;
function shouldCacheDate(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return true;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return (Date.now() - t) / 86400000 <= CACHE_FRESH_DAYS;
}

// 带 body 的 POST 版 gfetch（中国货币网两个接口都是 form-urlencoded POST）
async function gpost(url, headers, body, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 「北京 00:00 对应的 UTC 毫秒」→ YYYY-MM-DD。
// 东财 pingzhongdata 的 x、蛋卷的 ts 都是这种口径，直接 toISOString 会整体早一天。
function bjDate(ts) {
  const n = Number(ts);
  if (!n) return "";
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 北京「今天」的 YYYY-MM-DD（Worker 跑在 UTC，不能直接 toISOString）
function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 简易并发闸门：避免一次打 8 个 pingzhongdata（每个 500KB）把上游惹毛
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 指数估值：蛋卷基金 index_eva（免 Key，含 PE/PB 历史分位）──
// 这是 legulegu（对被墙/401）与中证官网（估值页已改版、接口 404）的替代源。
// 字段口径：pe_pct = 0~1，越大越贵；pe_over_history 是它的互补值（1 - pe_pct），
// 两者互为倒数关系，下游统一只用 pe_pct，避免一个指标两种读法。
const DJ_EVA_URL = "https://danjuanfunds.com/djapi/index_eva/detail/";
const DJ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://danjuanfunds.com/djmodule/value-center",
  "Accept": "application/json, text/plain, */*",
};

function djIndexCode(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (/^(SH|SZ|BJ)\d{6}$/.test(s)) return s;
  const d = s.replace(/[^0-9]/g, "");
  if (d.length !== 6) return "";
  if (/^[569]/.test(d)) return "SH" + d;
  if (/^[48]/.test(d)) return "BJ" + d;
  return "SZ" + d;
}

async function fetchIndexValuation(codes) {
  const rows = [];
  const errs = [];
  for (const c of codes) {
    try {
      const res = await gfetch(DJ_EVA_URL + c, DJ_HEADERS, 12000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const d = j && j.data;
      if (!d || d.pe == null) throw new Error("no eva data");
      rows.push({
        code: c,
        index_code: d.index_code || c,
        name: d.name || "",
        date: d.ts ? bjDate(d.ts) : "",
        pe: num(d.pe),
        pb: num(d.pb),
        pe_pct: num(d.pe_percentile),
        pb_pct: num(d.pb_percentile),
        pe_over_history: num(d.pe_over_history),
        pb_over_history: num(d.pb_over_history),
        roe: num(d.roe),
        dividend_yield: num(d.yeild),
        peg: num(d.peg),
        level: d.eva_type || "",
        level_int: d.eva_type_int == null ? null : Number(d.eva_type_int),
        upstream_bond_yield: num(d.bond_yeild),
      });
    } catch (e) {
      errs.push(c + " " + String((e && e.message) || e));
    }
  }
  return { rows, errs };
}

// ── 境内资金面：中国货币网（SHIBOR 八期限 + 银行间回购定盘 FR/FDR）──
// FDR001/007/014 就是 DR001/DR007/DR014（存款类机构质押式回购定盘利率），
// DR007 是央行公开市场操作盯的那个价，比 SHIBOR 更能代表银行间真实资金面。
const CM_SHIBOR_URL = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-shibor/ShiborHis";
const CM_FRR_URL = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/FrrHis";
const CM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.chinamoney.com.cn/chinese/bkccpr/",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

async function cmHistory(url, start, end) {
  const body = "lang=cn&startDate=" + encodeURIComponent(start) + "&endDate=" + encodeURIComponent(end);
  const res = await gpost(url, CM_HEADERS, body, 15000);
  if (!res.ok) throw new Error("chinamoney HTTP " + res.status);
  const j = await res.json();
  const rec = j && j.records;
  if (!Array.isArray(rec)) throw new Error("chinamoney records 非数组");
  return rec;
}

function tailAvg(series, field, n) {
  const vals = series.map((s) => s[field]).filter((v) => typeof v === "number" && isFinite(v));
  if (!vals.length) return null;
  const t = vals.slice(-n);
  return +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(4);
}

function tailDeltaBp(series, field, n) {
  const vals = series.map((s) => s[field]).filter((v) => typeof v === "number" && isFinite(v));
  if (vals.length <= n) return null;
  return +((vals[vals.length - 1] - vals[vals.length - 1 - n]) * 100).toFixed(1);
}

async function fetchCnLiquidity(days) {
  const end = bjToday();
  const start = new Date(Date.now() + 8 * 3600 * 1000 - (days + 20) * 86400000)
    .toISOString().slice(0, 10);
  const errs = [];

  const [shiborRec, frrRec] = await Promise.all([
    cmHistory(CM_SHIBOR_URL, start, end).catch((e) => { errs.push("shibor " + String(e.message || e)); return []; }),
    cmHistory(CM_FRR_URL, start, end).catch((e) => { errs.push("frr " + String(e.message || e)); return []; }),
  ]);

  const map = new Map();
  for (const r of shiborRec) {
    const d = r.showDateCN || bjDate(r.showDate);
    if (!d) continue;
    map.set(d, {
      date: d,
      shibor_on: num(r.ON),
      shibor_1w: num(r["1W"]),
      shibor_2w: num(r["2W"]),
      shibor_1m: num(r["1M"]),
      shibor_3m: num(r["3M"]),
      shibor_6m: num(r["6M"]),
      shibor_9m: num(r["9M"]),
      shibor_1y: num(r["1Y"]),
    });
  }
  for (const r of frrRec) {
    const m = r.frValueMap || {};
    const d = m.date || r.lfiProducDate;
    if (!d) continue;
    const row = map.get(d) || { date: d };
    row.dr001 = num(m.FDR001);
    row.dr007 = num(m.FDR007);
    row.dr014 = num(m.FDR014);
    row.fr001 = num(m.FR001);
    row.fr007 = num(m.FR007);
    row.fr014 = num(m.FR014);
    map.set(d, row);
  }

  const series = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-days);
  if (!series.length) return { rows: [], errs: errs.concat(["两手数据源均无可用记录"]) };

  const last = series[series.length - 1];
  const derived = {
    dr007_ma20: tailAvg(series, "dr007", 20),
    dr007_chg_5d_bp: tailDeltaBp(series, "dr007", 5),
    dr007_chg_20d_bp: tailDeltaBp(series, "dr007", 20),
    shibor_3m_chg_20d_bp: tailDeltaBp(series, "shibor_3m", 20),
    // 期限利差：3M 减隔夜。走阔通常意味机构在提前备付、资金预期收紧
    term_spread_3m_on_bp: (last.shibor_3m != null && last.shibor_on != null)
      ? +((last.shibor_3m - last.shibor_on) * 100).toFixed(1) : null,
    // DR007 相对 20 日均线的偏离，比绝对值更能反映「今天紧不紧」
    dr007_vs_ma20_bp: (last.dr007 != null && tailAvg(series, "dr007", 20) != null)
      ? +((last.dr007 - tailAvg(series, "dr007", 20)) * 100).toFixed(1) : null,
  };

  return { rows: series, derived, latest: last, errs };
}

// ── 国债收益率曲线（轻量切片版）：只取最近 N 个交易日 ──────────
// /api/bond-yield 是「全历史」口径（默认从 2015 起翻 12 页），一次几十万字节，
// 不适合每天给看板/邮件拉一次。这里复用同一抓取函数，翻最少的页数、只留尾部 N 行，
// 并派生期限利差（上游只给 10Y-2Y，5Y-2Y / 30Y-10Y 自己算）。
async function fetchCnRates(days) {
  const pages = Math.min(4, Math.max(1, Math.ceil(days / 480)));
  const all = await fetchBondYield("2100-01-01", false, pages);
  const tail = all.slice(-days);
  if (!tail.length) return { rows: [], derived: {}, latest: null };

  const sp = (a, b) => (a != null && b != null) ? +((a - b)).toFixed(4) : null;
  // 上游偶发返回「只有日期、各期限全 null」的行（节假日/补数占位）。
  // 直接留着会让曲线断点、按下标取最新值也会取到空值，这里先剔除。
  const rows = tail
    .filter((r) => [r.cn_2y, r.cn_5y, r.cn_10y, r.cn_30y].some((v) => typeof v === "number"))
    .map((r) => ({
      date: r.date,
      cn_2y: r.cn_2y, cn_5y: r.cn_5y, cn_10y: r.cn_10y, cn_30y: r.cn_30y,
      cn_10y_2y: r.cn_10y_2y,
      cn_5y_2y: sp(r.cn_5y, r.cn_2y),
      cn_30y_10y: sp(r.cn_30y, r.cn_10y),
    }));
  if (!rows.length) return { rows: [], derived: {}, latest: null };

  const latest = rows[rows.length - 1];
  // 变化量按「最近 n 个有效值」算，与 tailDeltaBp 同口径（避免个别缺失点把结果打成 null）
  const chgBp = (k, n) => {
    const vals = [];
    for (let i = rows.length - 1; i >= 0 && vals.length <= n; i--) {
      const v = rows[i][k];
      if (typeof v === "number" && isFinite(v)) vals.push(v);
    }
    if (vals.length <= n) return null;
    return +((vals[0] - vals[n]) * 100).toFixed(1);
  };
  const derived = {
    cn_10y_chg_20d_bp: chgBp("cn_10y", 20),
    cn_10y_chg_5d_bp: chgBp("cn_10y", 5),
    cn_10y_2y_chg_20d_bp: chgBp("cn_10y_2y", 20),
    cn_10y_ma20: tailAvg(rows, "cn_10y", 20),
    // 曲线形态：10Y-2Y 为负 = 倒挂（历史上极少见，是宽松预期极强的信号）
    inverted: latest.cn_10y_2y != null ? latest.cn_10y_2y < 0 : null,
  };
  return { rows, derived, latest };
}

// ── ETF 折溢价：二级市场收盘价（腾讯）vs 单位净值（东财 pingzhongdata）──
// 不依赖任何「IOPV 实时估值」接口（那类接口全在 push2 上，被 WAF 挡）。
// 折溢价率 =（市价 − 净值）/ 净值 × 100，日频足够判断申赎情绪。
// stale 标记：净值是 T 日、价格是 T+1 时（盘中必然如此），折溢价要用「同一时点」才准，
// 所以让下游能识别并选择是否采用。
const TX_QUOTE_URL = "https://qt.gtimg.cn/q=";
const EM_NAV_JS = "https://fund.eastmoney.com/pingzhongdata/";

function txCode(raw) {
  const d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.length !== 6) return "";
  if (/^[569]/.test(d)) return "sh" + d;
  if (/^[48]/.test(d)) return "bj" + d;
  return "sz" + d;
}

async function fetchTxQuotes(codes) {
  const q = codes.map(txCode).filter(Boolean).join(",");
  if (!q) throw new Error("无有效代码");
  const res = await gfetch(TX_QUOTE_URL + encodeURIComponent(q),
    { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" }, 15000);
  if (!res.ok) throw new Error("tx HTTP " + res.status);
  const buf = await res.arrayBuffer();
  let text;
  try { text = new TextDecoder("gbk").decode(buf); } catch (e) { text = new TextDecoder("utf-8").decode(buf); }
  const map = new Map();
  for (const seg of text.split(";")) {
    const m = seg.trim().match(/^v_([a-z]{2})(\d{6})="([\s\S]*)"$/);
    if (!m) continue;
    const p = m[3].split("~");
    if (p.length < 38) continue;
    map.set(m[2], {
      code: m[2],
      name: p[1],
      price: num(p[3]),
      prev_close: num(p[4]),
      time: p[30] || "",
      amount: num(String(p[35] || "").split("/")[2]),
    });
  }
  return map;
}

async function fetchLatestNav(code) {
  const res = await gfetch(EM_NAV_JS + code + ".js",
    { "User-Agent": "Mozilla/5.0", "Referer": "https://fund.eastmoney.com/" }, 25000);
  if (!res.ok) throw new Error("nav HTTP " + res.status);
  const text = await res.text();
  const m = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("未找到 Data_netWorthTrend");
  const arr = JSON.parse(m[1]);
  if (!arr.length) throw new Error("净值为空");
  const last = arr[arr.length - 1];
  return { nav: num(last.y), date: bjDate(last.x) };
}

async function fetchEtfPremium(codes) {
  const errs = [];
  const digits = codes.map((c) => String(c).replace(/[^0-9]/g, "")).filter((d) => d.length === 6);
  if (!digits.length) return { rows: [], errs: ["无有效 6 位代码"] };

  let quotes = new Map();
  try {
    quotes = await fetchTxQuotes(digits);
  } catch (e) {
    errs.push("quote " + String(e.message || e));
  }

  const rows = [];
  await mapLimit(digits, 4, async (code) => {
    let navInfo = null;
    try {
      navInfo = await fetchLatestNav(code);
    } catch (e) {
      errs.push(code + " nav " + String(e.message || e));
    }
    const q = quotes.get(code);
    if (!q || q.price == null) { errs.push(code + " 无行情"); return; }
    const priceDate = q.time && q.time.length >= 8
      ? q.time.slice(0, 4) + "-" + q.time.slice(4, 6) + "-" + q.time.slice(6, 8) : "";
    let premium = null;
    if (navInfo && navInfo.nav) premium = +(((q.price - navInfo.nav) / navInfo.nav) * 100).toFixed(4);
    rows.push({
      code,
      name: q.name || "",
      price: q.price,
      nav: navInfo ? navInfo.nav : null,
      price_date: priceDate,
      nav_date: navInfo ? navInfo.date : "",
      premium_pct: premium,
      stale: !!(priceDate && navInfo && navInfo.date && priceDate !== navInfo.date),
    });
  });

  rows.sort((a, b) => (a.code < b.code ? -1 : 1));
  return { rows, errs };
}

// ── 市场宽度：东财 push2ex（涨跌分布 / 涨停池 / 跌停池）──
// 全部集中在 push2ex.eastmoney.com 一个域名，与已知被 WAF 拦的 push2.eastmoney.com 不同。
// 重要限制：这三个接口**忽略 date 参数，永远返回当天**（实测传 20261103 仍回 qdate=20261104），
// 所以只能每天抓一次当日快照自行累积历史，无法回填。
// 口径说明：涨跌家数由「涨跌幅分布直方图」求和得出（与 push2 的 f104/f105/f106 交叉校验过，
// 差异在 1.5% 以内，源于是否含北交所与停牌股）；涨停/跌停家数取池子的 tc 字段。
const P2EX_URL = "https://push2ex.eastmoney.com";
const P2EX_UT = "7eea3edcaed734bea9cbfc24409ed989";
const P2EX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://quote.eastmoney.com/ztb/detail",
  "Accept": "*/*",
};

async function p2exGet(path) {
  const res = await gfetch(P2EX_URL + path, P2EX_HEADERS, 12000);
  if (!res.ok) throw new Error("push2ex HTTP " + res.status);
  const j = await res.json();
  return j && j.data;
}

async function fetchMarketBreadth() {
  const today = bjToday().replace(/-/g, "");
  const errs = [];
  const settle = await Promise.allSettled([
    p2exGet("/getTopicZDFenBu?ut=" + P2EX_UT + "&dpt=wz.ztzt&date=" + today),
    p2exGet("/getTopicZTPool?ut=" + P2EX_UT + "&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=" + today),
    p2exGet("/getTopicDTPool?ut=" + P2EX_UT + "&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fund%3Aasc&date=" + today),
  ]);
  const val = (i, label) => {
    const r = settle[i];
    if (r.status === "fulfilled" && r.value) return r.value;
    errs.push(label + " " + String((r.reason && r.reason.message) || "empty"));
    return null;
  };
  const dist = val(0, "zdfenbu");
  const zt = val(1, "ztpool");
  const dt = val(2, "dtpool");

  let up = 0, down = 0, flat = 0;
  const fenbu = (dist && dist.fenbu) || [];
  for (const item of fenbu) {
    for (const k of Object.keys(item)) {
      const bucket = Number(k);
      const n = Number(item[k]) || 0;
      if (bucket > 0) up += n;
      else if (bucket < 0) down += n;
      else flat += n;
    }
  }
  const total = up + down + flat;

  const streakDist = {};
  let maxStreak = 0;
  for (const p of (zt && zt.pool) || []) {
    const n = Number(p.lbc) || 0;
    if (n > 0) {
      streakDist[n] = (streakDist[n] || 0) + 1;
      if (n > maxStreak) maxStreak = n;
    }
  }

  const qdate = (dist && dist.qdate) || (zt && zt.qdate) || null;
  const dateStr = qdate ? String(qdate).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : "";

  return {
    date: dateStr,
    is_today: dateStr === bjToday(),
    history_supported: false,
    up,
    down,
    flat,
    total,
    up_pct: total ? +((up / total) * 100).toFixed(1) : null,
    limit_up: zt && zt.tc != null ? Number(zt.tc) : null,
    limit_down: dt && dt.tc != null ? Number(dt.tc) : null,
    max_streak: maxStreak,
    streak_dist: streakDist,
    dist: fenbu,
    errs,
  };
}

// ── 商品 / 贵金属 / 原油 / 全球指数（新浪 hq.sinajs.cn + 上金所）────────
// 接口改编自 simonlin1212/a-stock-data Layer 13（Apache-2.0）；外盘 hf_ 与
// 全球指数 znb_ 为该项目的 _sina_hq() 通用 helper 的直接延伸（文档未列这两个前缀）。
const SINA_HQ_URL = "https://hq.sinajs.cn/list=";
const SINA_FUT_KLINE_URL = "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/"
  + "var%20_{code}=/InnerFuturesNewService.getDailyKLine";
const SGE_DAILY_URL = "https://www.sge.com.cn/graph/Dailyhq";
const SINA_HDR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://finance.sina.com.cn/",
  "Accept": "*/*",
};

// 国内用 nf_ 前缀（六家期货交易所），外盘用 hf_ 前缀；全部主力连续 / 连续合约
const COMMODITY_DEFS = {
  AU0:  { market: "CN",   name: "沪金主力连续",     unit: "元/克",    venue: "上期所 SHFE" },
  AG0:  { market: "CN",   name: "沪银主力连续",     unit: "元/千克",  venue: "上期所 SHFE" },
  SC0:  { market: "CN",   name: "上海原油主力连续", unit: "元/桶",    venue: "上期能源 INE" },
  GC:   { market: "INTL", name: "纽约黄金 COMEX",   unit: "美元/盎司", venue: "COMEX" },
  SI:   { market: "INTL", name: "纽约白银 COMEX",   unit: "美元/盎司", venue: "COMEX" },
  CL:   { market: "INTL", name: "WTI 纽约原油",     unit: "美元/桶",   venue: "NYMEX" },
  OIL:  { market: "INTL", name: "布伦特原油",       unit: "美元/桶",   venue: "ICE" },
};
const DEFAULT_COMMODITIES = Object.keys(COMMODITY_DEFS);

// znb_ 全球指数：实测 KOSPI / HSI / FTSE 有值，DJI / IXIC / N225 返回空串，故不列入
const GLOBAL_DEFS = {
  KOSPI: { name: "韩国 KOSPI (KRX:KOSPI)", region: "KR" },
  HSI:   { name: "香港恒生指数",           region: "HK" },
  FTSE:  { name: "富时100",                region: "UK" },
};

function cnum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// hq.sinajs.cn 返回 GB18030。Workers 的 TextDecoder 支持 gbk；万一运行时不支持，
// 退回 utf-8 只会把中文变成替换字符，逗号分隔的数字字段不受影响，解析照样成立。
async function gbkText(res) {
  const buf = await res.arrayBuffer();
  try { return new TextDecoder("gbk").decode(buf); }
  catch (_) { return new TextDecoder("utf-8").decode(buf); }
}

function parseHqVars(text) {
  const out = {};
  const re = /var hq_str_([^=]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1]] = m[2] ? m[2].split(",") : [];
  return out;
}

async function sinaHq(keys) {
  const res = await gfetch(SINA_HQ_URL + keys.join(","), SINA_HDR, 12000);
  if (!res.ok) throw new Error("hq.sinajs.cn HTTP " + res.status);
  return parseHqVars(await gbkText(res));
}

async function fetchCommodityQuotes(symbols) {
  const keys = symbols.map((s) =>
    (COMMODITY_DEFS[s].market === "CN" ? "nf_" : "hf_") + s);
  const hq = await sinaHq(keys);
  const rows = [], errs = [];
  for (const s of symbols) {
    const def = COMMODITY_DEFS[s];
    const f = hq[(def.market === "CN" ? "nf_" : "hf_") + s];
    if (!f || !f.length) { errs.push(s + ": 上游返回空（代码不存在或已摘牌）"); continue; }
    if (def.market === "CN") {
      if (f.length < 18) { errs.push(s + ": 字段数只有 " + f.length); continue; }
      const clock = String(f[1] || "").padStart(6, "0");
      rows.push({
        symbol: s, ...def, upstream_name: f[0] || null,
        last: cnum(f[8]), open: cnum(f[2]), high: cnum(f[3]), low: cnum(f[4]),
        bid: cnum(f[6]), ask: cnum(f[7]), bid_vol: cnum(f[11]), ask_vol: cnum(f[12]),
        volume: cnum(f[14]), open_interest: cnum(f[13]),
        pre_settle: cnum(f[10]), avg_price: cnum(f[27]),
        date: f[17] || null,
        time: clock.length === 6
          ? clock.slice(0, 2) + ":" + clock.slice(2, 4) + ":" + clock.slice(4, 6) : null,
      });
    } else {
      if (f.length < 14) { errs.push(s + ": 字段数只有 " + f.length); continue; }
      rows.push({
        symbol: s, ...def, upstream_name: f[13] || null,
        last: cnum(f[0]), open: cnum(f[8]), high: cnum(f[4]), low: cnum(f[5]),
        bid: cnum(f[2]), ask: cnum(f[3]), pre_settle: cnum(f[7]),
        date: f[12] || null, time: f[6] || null,
      });
    }
  }
  return { rows, errs };
}

async function fetchFuturesKline(symbol) {
  const u = SINA_FUT_KLINE_URL.replace("{code}", symbol)
    + "?symbol=" + encodeURIComponent(symbol);
  const res = await gfetch(u, SINA_HDR, 20000);
  if (!res.ok) throw new Error("sina futures kline HTTP " + res.status);
  const text = await gbkText(res);
  // 返回形如 /*<script>...*/ var _AU0=([{...}]);  —— 只取 var 之后的括号内容
  const p = text.indexOf("var _");
  if (p < 0) throw new Error("新浪期货日K 返回不是预期的 JSONP");
  const seg = text.slice(p);
  const op = seg.indexOf("("), cp = seg.lastIndexOf(")");
  if (op < 0 || cp <= op) throw new Error("新浪期货日K JSONP 括号缺失");
  const body = seg.slice(op + 1, cp).trim();
  if (body === "null") throw new Error("无此合约日K（代码不存在或合约过老）");
  let items;
  try { items = JSON.parse(body); } catch (e) { throw new Error("新浪期货日K 不是合法 JSON"); }
  if (!Array.isArray(items)) throw new Error("新浪期货日K 返回不是数组");
  const rows = items.map((r) => ({
    date: String(r.d || ""), open: cnum(r.o), high: cnum(r.h), low: cnum(r.l),
    close: cnum(r.c), settle: cnum(r.s) || null,   // 新浪缺结算价时给 0
    volume: cnum(r.v), open_interest: cnum(r.p),
  })).filter((r) => r.date && r.close != null);
  rows.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
  if (!rows.length) throw new Error("区间内无有效日K");
  return rows;
}

async function postForm(url, headers, body, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

async function fetchSgeSpot(instrument) {
  const res = await postForm(SGE_DAILY_URL, {
    "User-Agent": SINA_HDR["User-Agent"],
    "Referer": "https://www.sge.com.cn/",
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "*/*",
  }, "instid=" + encodeURIComponent(instrument));
  if (!res.ok) throw new Error("上金所 HTTP " + res.status);
  const j = await res.json();
  if (!j || !Array.isArray(j.time)) throw new Error("上金所日线返回结构改变");
  // 每条 [date, open, close, low, high]；无成交日交易所填 0，剔除
  const rows = [];
  for (const rec of j.time) {
    if (!Array.isArray(rec) || rec.length < 5) continue;
    const o = cnum(rec[1]), c = cnum(rec[2]), l = cnum(rec[3]), h = cnum(rec[4]);
    if (!o || !c || !l || !h) continue;
    rows.push({ date: String(rec[0]), open: o, close: c, low: l, high: h });
  }
  rows.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
  if (!rows.length) throw new Error("上金所没有 " + instrument + " 的有效行情（代码不存在时返回全 0）");
  return rows;
}

async function fetchGlobalIndex(symbols) {
  const hq = await sinaHq(symbols.map((s) => "znb_" + s));
  const rows = [], errs = [];
  for (const s of symbols) {
    const f = hq["znb_" + s];
    if (!f || !f.length) { errs.push(s + ": 新浪该指数返回空"); continue; }
    rows.push({
      symbol: s, ...GLOBAL_DEFS[s], upstream_name: f[0] || null,
      last: cnum(f[1]), change: cnum(f[2]), change_pct: cnum(f[3]),
      date: f[6] || null, time: f[7] || null,
      open: cnum(f[8]), pre_close: cnum(f[9]),
      high: cnum(f[10]), low: cnum(f[11]),
    });
  }
  return { rows, errs };
}


// ── 跨资产比价：外盘连续合约日K + KOSPI/GOLD 固定阈值 ──────────
const GLOBAL_FUT_KLINE_URL = "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/"
  + "var%20_{code}=/GlobalFuturesService.getGlobalFuturesDailyKLine";
const MACRO_SYMBOLS = ["GC", "SI", "CL", "OIL", "HG", "CAD"];
const KOSPI_HI = 1.85;
const KOSPI_LO = 1.10;

function mround(x, n) {
  if (x == null || !Number.isFinite(x)) return null;
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}

async function fetchGlobalFuturesDaily(code) {
  const u = GLOBAL_FUT_KLINE_URL.replace("{code}", code)
    + "?symbol=" + encodeURIComponent(code);
  const res = await gfetch(u, SINA_HDR, 20000);
  if (!res.ok) throw new Error("global futures kline " + code + " HTTP " + res.status);
  const text = await gbkText(res);
  const p = text.indexOf("var _");
  if (p < 0) throw new Error("global futures kline " + code + " 不是预期 JSONP");
  const seg = text.slice(p);
  const op = seg.indexOf("("), cp = seg.lastIndexOf(")");
  if (op < 0 || cp <= op) throw new Error("global futures kline " + code + " 括号缺失");
  const body = seg.slice(op + 1, cp).trim();
  let items;
  try { items = JSON.parse(body); } catch (e) { throw new Error("global futures kline " + code + " 非 JSON"); }
  if (!Array.isArray(items)) throw new Error("global futures kline " + code + " 返回不是数组");
  const m = new Map();
  for (const r of items) {
    const day = String(r.date || "");
    const close = cnum(r.close);
    if (day && close != null && close > 0) m.set(day, close);
  }
  if (!m.size) throw new Error("global futures kline " + code + " 无有效收盘价");
  return m;
}

function ratioStats(a, b, scale) {
  const dates = [...a.keys()].filter((d) => b.has(d) && b.get(d) > 0).sort();
  if (!dates.length) return null;
  const vals = dates.map((d) => a.get(d) / b.get(d) * scale);
  const n = vals.length;
  const cur = vals[n - 1];
  const prev = vals[Math.max(0, n - 21)];
  const win = vals.slice(-250);
  return {
    value: mround(cur, 3),
    chg20_pct: mround((cur / prev - 1) * 100, 2),
    pct250: mround(win.filter((x) => x <= cur).length / win.length * 100, 1),
    min250: mround(Math.min(...win), 3),
    max250: mround(Math.max(...win), 3),
    asof: dates[n - 1],
    n: n,
  };
}

async function fetchMacroRatios() {
  const settled = await Promise.all(MACRO_SYMBOLS.map(async (s) => {
    try { return [s, await fetchGlobalFuturesDaily(s)]; }
    catch (e) { return [s, null, String(e.message || e)]; }
  }));
  const maps = {}, errs = [];
  for (const [s, m, err] of settled) {
    if (m) maps[s] = m; else errs.push(s + ": " + err);
  }
  for (const s of ["GC", "SI", "CL", "HG"]) {
    if (!maps[s]) throw new Error("核心品种缺失 " + s + "；" + errs.join(" | "));
  }
  const kg = await sinaHq(["znb_KOSPI"]);
  const kf = kg["znb_KOSPI"];
  const kospi = kf && cnum(kf[1]);
  if (kospi == null || kospi <= 0) throw new Error("znb_KOSPI 无有效报价");
  const gcDates = [...maps.GC.keys()].sort();
  const gold = maps.GC.get(gcDates[gcDates.length - 1]);
  const kgVal = kospi / gold;
  return {
    asof: gcDates[gcDates.length - 1],
    gold_close: mround(gold, 3),
    kospi: mround(kospi, 2),
    gold_silver: ratioStats(maps.GC, maps.SI, 1),
    gold_oil: ratioStats(maps.GC, maps.CL, 1),
    copper_gold: ratioStats(maps.HG, maps.GC, 1000),
    kospi_gold: {
      value: mround(kgVal, 4),
      hi: KOSPI_HI, lo: KOSPI_LO,
      signal: kgVal > KOSPI_HI ? "sell" : (kgVal < KOSPI_LO ? "buy" : "neutral"),
      dist_hi_pct: mround((KOSPI_HI / kgVal - 1) * 100, 2),
      dist_lo_pct: mround((KOSPI_LO / kgVal - 1) * 100, 2),
    },
    errs: errs,
  };
}


// ── 主路由 ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
   if (request.method === "OPTIONS") {
     return new Response(null, {
       status: 204,
       headers: {
         "Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Methods": "GET, OPTIONS",
         "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
         "Access-Control-Max-Age": "86400",
       },
     });
   }
   try {
    const url = new URL(request.url);
    // 只允许持有密钥的本人仓库调用；fork 不继承 GitHub Secrets，其请求会被拒
    if (url.pathname !== "/" && request.headers.get("X-API-Key") !== env.API_KEY) {
      return json({ error: "unauthorized", message: "X-API-Key required" }, 401);
    }

    // /api/kline?symbol=sz399006&start=2010-01-01
    if (url.pathname === "/api/kline") {
      const symbol = (url.searchParams.get("symbol") || "sz399006").toLowerCase();
      const period = url.searchParams.get("period") || "day";
      const start = url.searchParams.get("start") || "2015-01-01";
      const end = bjToday();
      const key = `kline:${symbol}:${period}:${start}:${end}`;

      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }

      const rows = await fetchKlineFull(symbol, period, start, end);
      if (!rows || rows.length === 0) {
        return json({ error: "fetch failed or empty", symbol }, 502);
      }
      const payload = {
        symbol, period, start, end, count: rows.length,
        updated: Date.now(),
        data: rows.map((r) => ({ date: r[0], open: r[1], close: r[2], high: r[3], low: r[4], volume: r[5] })),
      };
      ctx.waitUntil(
        env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
      );
      return json(payload);
    }

    // /api/csindex?symbol=H30269&start=20160803&end=20261104
    if (url.pathname === "/api/csindex") {
      const symbol = (url.searchParams.get("symbol") || "H30269").toUpperCase();
      const start = url.searchParams.get("start") || "20100101";
      const end = url.searchParams.get("end") || bjToday().replace(/-/g, "");
      const key = `csindex:${symbol}:${start}:${end}`;

      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }

      const rows = await fetchCsindex(symbol, start, end);
      if (!rows || rows.length === 0) {
        return json({ error: "fetch failed or empty", symbol }, 502);
      }
      const payload = {
        symbol, start, end, count: rows.length,
        updated: Date.now(), data: rows,
      };
      ctx.waitUntil(
        env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
      );
      return json(payload);
    }

    // /api/etf-shares?exchange=SZ&date=2026-09-18&code=510300
    if (url.pathname === "/api/etf-shares") {
      const exchange = (url.searchParams.get("exchange") || "ALL").toUpperCase();
      const date = url.searchParams.get("date") || bjToday();
      const code = (url.searchParams.get("code") || "").replace(/[^0-9]/g, "");
      const key = `etfshares:${exchange}:${date}:${code}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }

      let sh = [], sz = null, shDate = date, szDate = "";
      // 上交所对 Cloudflare 出口也会偶发限流（回空/HTML 而非 JSON），一次失败就丢一天。
      // 2026-11-04 实测单次成功率只有 ~40%（9 天里 5~6 天首抓为空、隔一会儿再问就有），
      // 因此这里重试 3 次、每次间隔 400ms —— 若真是按 IP 的短窗口限流，拉开间隔比连续重试有效。
      let shErr = null;
      if (exchange === "SH" || exchange === "ALL") {
        for (let attempt = 0; attempt < 3 && sh.length === 0; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 400));
          try {
            sh = await fetchSseEtfShares(date);
            shDate = (sh[0] && sh[0].date) || date;
            shErr = null;
          } catch (e) {
            sh = [];
            shErr = String(e.message || e);
          }
        }
      }
      if (exchange === "SZ" || exchange === "ALL") {
        try { const s = await fetchSzseEtfShares(); sz = s.rows; szDate = s.snapshot_date; }
        catch (e) { sz = []; }
      }
      let combined = exchange === "SH" ? sh : exchange === "SZ" ? (sz || []) : sh.concat(sz || []);
      if (code) combined = combined.filter((r) => (r.code || "").includes(code));
      const payload = {
        exchange, date, code: code || null, count: combined.length,
        sh: { date: shDate, count: sh.length },
        sz: { date: szDate, count: sz ? sz.length : 0 },
        unit: "shares_10k = 万份", updated: Date.now(), data: combined,
      };
      // 空结果绝不写缓存：上游一次失败会被缓存 1 小时，下游据此判定「当天无数据」，
      // 结果是一整段时间里反复拿到同一份空表（2026-11-04 就是这样静默丢了 5 天）。
      // 同时把空表的原因显式回给调用方，别让它看起来像「确实没有数据」。
      if (combined.length === 0 && shErr) payload.upstream_error = shErr;
      // 只缓存「最近 5 个自然日」：历史日期抓一次永不变化，写它只是烧 KV 的
      // 1000 次/天写配额（250 天回填 = 250 个键）。旧行为是 250 次全写。
      if (combined.length > 0 && shouldCacheDate(date)) {
        ctx.waitUntil(
          env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
        );
      }
      return json(payload);
    }

    // /api/fund-flow?code=510300&days=60
    if (url.pathname === "/api/fund-flow") {
      const code = url.searchParams.get("code") || "510300";
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "60", 10) || 60, 1), 240);
      const key = `fundflow:${code}:${days}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }

      try {
        const rows = await fetchFundFlow(code, days);
        const payload = {
          code, daima: sinaFlowPrefix(code), days, count: rows.length,
          unit: "net_amount = 元", updated: Date.now(), data: rows,
        };
        ctx.waitUntil(
          env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
        );
        return json(payload);
      } catch (e) {
        return json({ error: "fund-flow fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/research?code=600519&pages=3   (qType=1 行业研报，industry=行业码 或 *)
    if (url.pathname === "/api/research") {
      const code = url.searchParams.get("code") || "600519";
      const pages = Math.min(Math.max(parseInt(url.searchParams.get("pages") || "3", 10) || 3, 1), 10);
      const qType = url.searchParams.get("qType") === "1" ? 1 : 0;
      const industry = url.searchParams.get("industry") || "*";
      const key = `research:${code}:${qType}:${industry}:${pages}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }

      try {
        const rows = await fetchResearch(code, pages, qType, industry);
        const payload = {
          code, qType, industry, count: rows.length,
          updated: Date.now(), data: rows,
        };
        ctx.waitUntil(
          env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
        );
        return json(payload);
      } catch (e) {
        return json({ error: "research fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/fund-nav?code=510300&start=&end=
    if (url.pathname === "/api/fund-nav") {
      const code = (url.searchParams.get("code") || "510300").replace(/[^0-9]/g, "");
      const start = url.searchParams.get("start") || "";
      const end = url.searchParams.get("end") || "";
      const key = `fundnav:${code}:${start}:${end}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const rows = await fetchFundNav(code, start, end);
        const payload = { code, count: rows.length, updated: Date.now(), data: rows };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "fund-nav fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/trade-calendar?start=2010-01-01&end=2026-12-31
    if (url.pathname === "/api/trade-calendar") {
      const start = url.searchParams.get("start") || "2010-01-01";
      const end = url.searchParams.get("end") || bjToday();
      const key = `cal:${start}:${end}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const dates = await fetchTradeCalendar(start, end);
        const payload = { start, end, count: dates.length, updated: Date.now(), data: dates };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "trade-calendar fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/bond-yield?start=2015-01-01&include_us=0
    if (url.pathname === "/api/bond-yield") {
      const start = url.searchParams.get("start") || "2015-01-01";
      const includeUs = url.searchParams.get("include_us") === "1";
      const maxPages = Math.min(Math.max(parseInt(url.searchParams.get("max_pages") || "12", 10) || 12, 1), 40);
      const key = `bond:${start}:${includeUs ? 1 : 0}:${maxPages}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const rows = await fetchBondYield(start, includeUs, maxPages);
        const payload = { start, include_us: includeUs, count: rows.length, unit: "收益率 %", updated: Date.now(), data: rows };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "bond-yield fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/cn-rates?days=250
    if (url.pathname === "/api/cn-rates") {
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "250", 10) || 250, 20), 1200);
      const key = `cnrates:${days}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const r = await fetchCnRates(days);
        if (!r.rows.length) return json({ error: "cn-rates 无数据" }, 502);
        const payload = {
          days, count: r.rows.length,
          unit: "收益率 %；cn_5y_2y / cn_30y_10y / cn_10y_2y 为利差 %（×100 即 bp），派生字段为 bp",
          fields: {
            cn_2y: "2 年期国债到期收益率", cn_5y: "5 年期", cn_10y: "10 年期", cn_30y: "30 年期",
            cn_10y_2y: "10Y-2Y 期限利差（上游自带）",
            cn_5y_2y: "5Y-2Y（本端点派生）", cn_30y_10y: "30Y-10Y（本端点派生）",
          },
          note: "覆盖最近 days 个交易日；修 curve 形态看 cn_10y_2y，为负即倒挂。"
            + "与 /api/bond-yield 同源（东财 RPTA_WEB_TREASURYYIELD），但只回尾部窗口、体积小得多。",
          latest: r.latest, derived: r.derived,
          updated: Date.now(), data: r.rows,
        };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "cn-rates fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/margin-account?start=2018-01-01
    if (url.pathname === "/api/margin-account") {
      const start = url.searchParams.get("start") || "2018-01-01";
      const maxPages = Math.min(Math.max(parseInt(url.searchParams.get("max_pages") || "10", 10) || 10, 1), 30);
      const key = `margin:${start}:${maxPages}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const rows = await fetchMarginAccount(start, maxPages);
        const payload = { start, count: rows.length, updated: Date.now(), data: rows };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "margin-account fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/market-turnover?symbols=sh000001,sz399001  (兼容 secids=1.000001,0.399001)
    if (url.pathname === "/api/market-turnover") {
      const raw = url.searchParams.get("symbols") || url.searchParams.get("secids") || "sh000001,sz399001";
      const symbols = raw.split(",").map((t) => {
        t = t.trim().toLowerCase();
        if (t.includes(".")) {
          const [mkt, code] = t.split(".");
          return (mkt === "1" ? "sh" : mkt === "0" ? "sz" : mkt) + code;
        }
        return t;
      }).filter(Boolean).join(",");
      const key = `turnover:${symbols}`;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const { rows, total } = await fetchMarketTurnover(symbols);
        const payload = { symbols, count: rows.length, total_amount: total, unit: "amount = 元", updated: Date.now(), data: rows };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "market-turnover fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/index-valuation?codes=SH000300,SZ399006  (也接受 sh000300 / 000300)
    if (url.pathname === "/api/index-valuation") {
      const raw = url.searchParams.get("codes") || url.searchParams.get("code") || "SH000300,SZ399006";
      const codes = raw.split(",").map(djIndexCode).filter(Boolean);
      if (!codes.length) return json({ error: "bad_request", message: "codes 无法解析成指数代码" }, 400);
      const key = "idxval:" + codes.join(",");
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      const { rows, errs } = await fetchIndexValuation(codes);
      const payload = {
        count: rows.length,
        unit: { pe_pct: "0~1, 越大越贵", roe: "小数(0.0993=9.93%)", dividend_yield: "小数", peg: "倍" },
        note: "pe_pct 即上游 pe_percentile；pe_over_history 是其互补值(1-pe_pct)，仅透传备查，勿混用。"
          + "upstream_bond_yield 口径不明（常数级），不要拿去算股债性价比。",
        updated: Date.now(),
        data: rows,
      };
      if (errs.length) payload.upstream_error = errs.join(" | ");
      if (rows.length > 0) {
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
      }
      return json(payload);
    }

    // /api/cn-liquidity?days=60  (SHIBOR 八期限 + FR/FDR 回购定盘，单位 %)
    if (url.pathname === "/api/cn-liquidity") {
      const days = Math.max(5, Math.min(250, parseInt(url.searchParams.get("days") || "60", 10) || 60));
      const key = "cnliq:" + days;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      const r = await fetchCnLiquidity(days);
      const payload = {
        count: r.rows.length,
        unit: "% (年化)",
        fields: {
          dr001: "DR001 存款类机构质押式回购定盘利率(隔夜)",
          dr007: "DR007 存款类机构质押式回购定盘利率(7天)，央行公开市场操作锚",
          dr014: "DR014",
          fr001: "FR001 银行间质押式回购定盘利率(隔夜)",
          fr007: "FR007",
          fr014: "FR014",
          shibor_on: "SHIBOR 隔夜",
          shibor_1w: "SHIBOR 1周",
          shibor_1m: "SHIBOR 1月",
          shibor_3m: "SHIBOR 3月（中期资金成本）",
          shibor_1y: "SHIBOR 1年",
        },
        derived_unit: "bp（1bp = 0.01 个百分点）",
        updated: Date.now(),
        latest: r.latest || null,
        derived: r.derived || null,
        data: r.rows,
      };
      if (r.errs && r.errs.length) payload.upstream_error = r.errs.join(" | ");
      if (r.rows.length > 0) {
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 1800 }).catch(() => {}));
      }
      return json(payload);
    }

    // /api/etf-premium?codes=510300,159919  (折溢价率 %，附 stale 标记)
    if (url.pathname === "/api/etf-premium") {
      const raw = url.searchParams.get("codes") || url.searchParams.get("code") || "510300,159919";
      const codes = raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30);
      if (!codes.length) return json({ error: "bad_request", message: "codes 为空" }, 400);
      const key = "premium:" + codes.map((c) => c.replace(/[^0-9]/g, "")).join(",");
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      const { rows, errs } = await fetchEtfPremium(codes);
      const payload = {
        count: rows.length,
        unit: "premium_pct = %；price = 元；nav = 元",
        note: "折溢价 = (市价 − 净值) / 净值 × 100。stale=true 表示价格日期与净值日期不同"
          + "（盘中必然如此），此时该值只反映「相对昨日净值的偏离」，不要当收盘折溢价用。",
        updated: Date.now(),
        data: rows,
      };
      if (errs.length) payload.upstream_error = errs.join(" | ");
      if (rows.length > 0) {
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 600 }).catch(() => {}));
      }
      return json(payload);
    }

    // /api/market-breadth  (涨跌家数 / 涨停跌停 / 连板高度，仅当日，不支持历史)
    if (url.pathname === "/api/market-breadth") {
      const key = "breadth:today";
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      const r = await fetchMarketBreadth();
      const payload = {
        unit: "counts（家）",
        note: "涨跌家数由涨跌幅分布直方图求和；涨停/跌停取池子 tc；max_streak 为最高连板高度。"
          + "上游三个接口忽略 date 参数、永远返回当日快照，因此 history_supported=false，无法回填历史。",
        updated: Date.now(),
        ...r,
      };
      if (r.errs && r.errs.length) payload.upstream_error = r.errs.join(" | ");
      // 盘中数据每分钟都在变，只给 5 分钟；且只有拿到有效分布才缓存
      if (r.total > 0) {
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {}));
      }
      return json(payload);
    }

    // /api/commodity-quote?symbols=AU0,AG0,SC0,GC,SI,CL,OIL
    // 国内沪金/沪银/SC原油主力连续 + 纽约黄金白银/WTI/布伦特，一次请求全部拿到。
    if (url.pathname === "/api/commodity-quote") {
      const raw = url.searchParams.get("symbols") || DEFAULT_COMMODITIES.join(",");
      const symbols = raw.split(",").map((s) => s.trim().toUpperCase()
        .replace(/^NF_/, "").replace(/^HF_/, "")).filter((s) => COMMODITY_DEFS[s]);
      if (!symbols.length) return json({ error: "bad_request", message: "symbols 无有效代码", supported: DEFAULT_COMMODITIES }, 400);
      const key = "commodity:" + symbols.join(",");
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const { rows, errs } = await fetchCommodityQuotes(symbols);
        if (!rows.length) return json({ error: "upstream_empty", errs, symbols }, 502);
        const payload = {
          symbols, count: rows.length, updated: Date.now(),
          note: "国内 nf_ 主力连续（元/克、元/千克、元/桶）；外盘 hf_ 连续合约（美元计价）。"
            + "盘中为实时价，收盘后为当日快照；国内结算价以上期所官方为准。",
          data: rows,
        };
        if (errs.length) payload.upstream_error = errs.join(" | ");
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "commodity-quote fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/futures-kline?symbol=AU0&days=250  (主力连续日K；也可 AG0 / SC0 / RB0 / M0)
    if (url.pathname === "/api/futures-kline") {
      const symbol = (url.searchParams.get("symbol") || "AU0").toUpperCase()
        .replace(/^NF_/, "");
      if (!/^[A-Z]{1,2}\d{1,4}$/.test(symbol)) {
        return json({ error: "bad_request", message: "symbol 格式应为 AU0 / AG0 / SC0 / RB2601" }, 400);
      }
      const days = Math.max(1, Math.min(6000, parseInt(url.searchParams.get("days") || "250", 10) || 250));
      const start = normDate(url.searchParams.get("start")) || null;
      const end = normDate(url.searchParams.get("end")) || null;
      const key = "futk:" + symbol + ":" + days + ":" + (start || "") + ":" + (end || "");
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        let rows = await fetchFuturesKline(symbol);
        if (start) rows = rows.filter((r) => r.date >= start);
        if (end) rows = rows.filter((r) => r.date <= end);
        if (rows.length > days) rows = rows.slice(rows.length - days);
        if (!rows.length) return json({ error: "no_rows_in_range", symbol, start, end }, 404);
        const payload = {
          symbol, count: rows.length, unit: "price = 交易所报价单位；settle 为结算价(缺则 null)",
          note: "新浪 InnerFuturesNewService 主力连续，换月会跳空、未复权；结算价给 0 时置 null。"
            + "返回的是该代码全历史后本地裁剪，故 start/end/days 不影响上游流量。",
          updated: Date.now(), data: rows,
        };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "futures-kline fetch failed", symbol, message: String(e.message || e) }, 502);
      }
    }

    // /api/sge-spot?instrument=Au99.99&days=250  (上金所现货：Au99.99 / Au(T+D) / Ag(T+D) / Pt99.95)
    if (url.pathname === "/api/sge-spot") {
      const instrument = url.searchParams.get("instrument") || "Au99.99";
      // days=0 / 不传 = 返回全历史；不能用 Math.max(1,...) 夹，否则「全历史」会被压成最后 1 条
      const daysRaw = parseInt(url.searchParams.get("days") || "0", 10) || 0;
      const days = daysRaw > 0 ? Math.min(6000, daysRaw) : 0;
      const key = "sge:" + instrument + ":" + days;
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        let rows = await fetchSgeSpot(instrument);
        if (days && rows.length > days) rows = rows.slice(rows.length - days);
        const payload = {
          instrument, count: rows.length,
          unit: /^Ag/i.test(instrument) ? "元/千克" : "元/克",
          note: "上海黄金交易所现货日线，2016-12 起；无成交日(全 0)已剔除。"
            + "少数交易日收盘价略超高低区间是原始数据如此。",
          updated: Date.now(), data: rows,
        };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "sge-spot fetch failed", instrument, message: String(e.message || e) }, 502);
      }
    }

    // /api/global-index?symbols=KOSPI,HSI,FTSE  (KRX:KOSPI 等，仅实时快照)
    if (url.pathname === "/api/global-index") {
      const raw = url.searchParams.get("symbols") || "KOSPI";
      const symbols = raw.split(",").map((s) => s.trim().toUpperCase()
        .replace(/^ZNB_/, "").replace(/^KRX:/, "")).filter((s) => GLOBAL_DEFS[s]);
      if (!symbols.length) {
        return json({ error: "bad_request", message: "symbols 无有效代码", supported: Object.keys(GLOBAL_DEFS) }, 400);
      }
      const key = "gidx:" + symbols.join(",");
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const { rows, errs } = await fetchGlobalIndex(symbols);
        if (!rows.length) return json({ error: "upstream_empty", errs, symbols }, 502);
        const payload = {
          symbols, count: rows.length, updated: Date.now(),
          history_supported: false,
          note: "新浪 znb_ 全球指数快照。KRX:KOSPI 请传 symbols=KOSPI。"
            + "实测 DJI / IXIC / N225 该前缀返回空串，故未列入；"
            + "免费纯 HTTP 源暂无可靠历史日K，本端点只提供实时/收盘快照。",
          data: rows,
        };
        if (errs.length) payload.upstream_error = errs.join(" | ");
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "global-index fetch failed", message: String(e.message || e) }, 502);
      }
    }

    // /api/macro-ratios  跨资产比价：金银比 / 金油比 / 铜金比 + KOSPI/GOLD 固定阈值信号
    if (url.pathname === "/api/macro-ratios") {
      const key = "macroratios:v1";
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }
      try {
        const r = await fetchMacroRatios();
        const payload = {
          updated: Date.now(), ...r,
          definitions: {
            gold_silver: "纽约黄金 GC(美元/盎司) ÷ 纽约白银 SI(美元/盎司)",
            gold_oil: "纽约黄金 GC ÷ WTI 原油 CL(美元/桶)",
            copper_gold: "美铜 HG(美分/磅) ÷ 纽约黄金 GC × 1000",
            kospi_gold: "KOSPI 点位 ÷ 纽约黄金 GC 日K收盘(美元/盎司)",
          },
          note: "外盘为新浪 GlobalFuturesService 连续合约日K，最后一根是当日盘中快照、非结算价；"
            + "KOSPI 为 znb_ 实时/收盘快照，两者时点略有错位。"
            + "pct250 为近 250 交易日分位(0=最低,100=最高)，chg20_pct 为 20 交易日前至今变化。"
            + "KOSPI/GOLD 采用固定阈值 1.85 / 1.10，dist_hi_pct / dist_lo_pct 表示当前值需变动多少百分比才触线。",
          history_supported: true,
        };
        ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {}));
        return json(payload);
      } catch (e) {
        return json({ error: "macro-ratios fetch failed", message: String(e.message || e) }, 502);
      }
    }

    return json({
      service: "a-stock-api",
      source: "腾讯财经 + 中证指数官网（改编自 simonlin1212/a-stock-data, Apache-2.0）",
      endpoints: {
        kline: "/api/kline?symbol=sz399006&start=2010-01-01",
        csindex: "/api/csindex?symbol=H30269&start=20160803",
        "etf-shares": "/api/etf-shares?exchange=SZ  (exchange=SH|SZ|ALL, date=上交所历史日, code=可选过滤)",
        "fund-flow": "/api/fund-flow?code=510300&days=60  (code 支持 6位/前缀/带市场)",
        research: "/api/research?code=600519&pages=3  (qType=1 行业研报，industry=行业码)",
        "fund-nav": "/api/fund-nav?code=510300  (基金/ETF 净值历史)",
        "trade-calendar": "/api/trade-calendar?start=2010-01-01  (交易日历，派生自上证指数K线)",
        "bond-yield": "/api/bond-yield?start=2015-01-01&include_us=0  (国债收益率 %)",
        "margin-account": "/api/margin-account?start=2018-01-01  (两融账户统计)",
        "market-turnover": "/api/market-turnover?symbols=sh000001,sz399001  (两市成交额 元)",
        "index-valuation": "/api/index-valuation?codes=SH000300,SZ399006  (PE/PB 及历史分位, 0~1)",
        "cn-liquidity": "/api/cn-liquidity?days=60  (SHIBOR 八期限 + DR001/DR007/DR014，单位 %)",
        "etf-premium": "/api/etf-premium?codes=510300,159919  (折溢价率 %，附 stale 标记)",
        "market-breadth": "/api/market-breadth  (涨跌家数/涨停跌停/连板高度，仅当日)",
        "cn-rates": "/api/cn-rates?days=250  (国债 2/5/10/30Y 曲线 + 期限利差 %（×100 为 bp），尾部窗口)",
        "commodity-quote": "/api/commodity-quote?symbols=AU0,AG0,SC0,GC,SI,CL,OIL  (沪金/沪银/SC原油 + 纽约金银/WTI/布伦特)",
        "futures-kline": "/api/futures-kline?symbol=AU0&days=250  (期货主力连续日K)",
        "sge-spot": "/api/sge-spot?instrument=Au99.99&days=250  (上金所黄金/白银现货日线)",
        "global-index": "/api/global-index?symbols=KOSPI  (KRX:KOSPI 等全球指数实时，无历史)",
        "macro-ratios": "/api/macro-ratios  (金银比/金油比/铜金比 + KOSPI-GOLD 阈值信号)",
      },
      examples: {
        "创业板指": "sz399006",
        "沪深300": "sh000300",
        "上证指数": "sh000001",
        "中证红利低波": "H30269",
      },
    });
   } catch (e) {
    console.error("worker error:", e && e.stack ? e.stack : e);
    return json({ error: "worker_exception", message: String((e && e.message) || e) }, 500);
   }
  },
};
