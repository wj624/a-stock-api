// a-stock-api — A股共享数据源 API（Cloudflare Worker）
// 取数逻辑改编自 simonlin1212/a-stock-data（Apache-2.0），并补充中证指数官方源。
// 数据源：
//   - 指数日K线 /api/kline：腾讯财经 web.ifzq.gtimg.cn（免Key、多 host 轮换）
//   - 中证自定义指数日线 /api/csindex：中证指数官网 csindex.com.cn（免Key）
//   - ETF 份额 /api/etf-shares：上交所 query.sse.com.cn（按日期历史） + 深交所 fund.szse.cn（当前快照）
//   - 个股资金流 /api/fund-flow：新浪 MoneyFlow.ssl_qsfx_zjlrqs（日度四档单净额）
//   - 研报 /api/research：东财 reportapi.eastmoney.com（含评级/目标价/机构）
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
      if (exchange === "SH" || exchange === "ALL") {
        try { sh = await fetchSseEtfShares(date); shDate = (sh[0] && sh[0].date) || date; }
        catch (e) { sh = []; }
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
      ctx.waitUntil(
        env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
      );
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

    return json({
      service: "a-stock-api",
      source: "腾讯财经 + 中证指数官网（改编自 simonlin1212/a-stock-data, Apache-2.0）",
      endpoints: {
        kline: "/api/kline?symbol=sz399006&start=2010-01-01",
        csindex: "/api/csindex?symbol=H30269&start=20160803",
        "etf-shares": "/api/etf-shares?exchange=SZ  (exchange=SH|SZ|ALL, date=上交所历史日, code=可选过滤)",
        "fund-flow": "/api/fund-flow?code=510300&days=60  (code 支持 6位/前缀/带市场)",
        research: "/api/research?code=600519&pages=3  (qType=1 行业研报，industry=行业码)",
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
