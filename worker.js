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
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
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
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" },
      });
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
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.csindex.com.cn/" },
    });
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

async function fetchSseEtfShares(date) {
  const url = `${SSE_ETF_URL}?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`
    + `&STAT_DATE=${encodeURIComponent(date)}&isPagination=true`
    + `&pageHelp.pageSize=10000&pageHelp.beginPage=1&pageHelp.endPage=1`;
  const res = await gfetch(url, {
    "User-Agent": "Mozilla/5.0", "Referer": "https://www.sse.com.cn/",
  });
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

// ── 主路由 ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
   try {
    const url = new URL(request.url);

    // /api/kline?symbol=sz399006&start=2010-01-01
    if (url.pathname === "/api/kline") {
      const symbol = (url.searchParams.get("symbol") || "sz399006").toLowerCase();
      const period = url.searchParams.get("period") || "day";
      const start = url.searchParams.get("start") || "2015-01-01";
      const end = new Date().toISOString().slice(0, 10);
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
      const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10).replace(/-/g, "");
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
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
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
      if (combined.length > 0) {
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
      const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
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
