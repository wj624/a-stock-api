// a-stock-api — A股共享数据源 API（Cloudflare Worker）
// 取数逻辑改编自 simonlin1212/a-stock-data（Apache-2.0），并补充中证指数官方源。
// 数据源：
//   - 指数日K线 /api/kline：腾讯财经 web.ifzq.gtimg.cn（免Key、多 host 轮换）
//   - 中证自定义指数日线 /api/csindex：中证指数官网 csindex.com.cn（免Key）
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

    return json({
      service: "a-stock-api",
      source: "腾讯财经 + 中证指数官网（改编自 simonlin1212/a-stock-data, Apache-2.0）",
      endpoints: {
        kline: "/api/kline?symbol=sz399006&start=2010-01-01",
        csindex: "/api/csindex?symbol=H30269&start=20160803",
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
