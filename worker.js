// a-stock-api — A股共享数据源 API（Cloudflare Worker）
// 端点 /api/kline：指数日K线，取数逻辑改编自 simonlin1212/a-stock-data（Apache-2.0）
// 数据源：腾讯财经 web.ifzq.gtimg.cn（免Key、不封IP、多 host 轮换）
//
// 注意：本仓库是"代码老家"；真正被各看板调用的是「部署后的 Worker 网址」，不是 GitHub 仓库本身。

const HOSTS = [
  "https://web.ifzq.gtimg.cn",
  "https://qt.gtimg.cn",
];

// 腾讯日K线接口：param = symbol,period,start,end,count
// 返回 data[symbol].day = [[date, open, close, high, low, volume], ...]
async function fetchKline(symbol, period, start, end, count) {
  const param = [symbol, period, start, end, count].join(",");
  let lastErr = null;
  for (const host of HOSTS) {
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
      const rows = node.day.map((r) => ({
        date: String(r[0]),
        open: parseFloat(r[1]),
        close: parseFloat(r[2]),
        high: parseFloat(r[3]),
        low: parseFloat(r[4]),
        volume: parseFloat(r[5]),
      }));
      return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  return null;
}

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/kline") {
      const symbol = (url.searchParams.get("symbol") || "sz399006").toLowerCase();
      const period = url.searchParams.get("period") || "day";
      const count = Math.min(parseInt(url.searchParams.get("count") || "365", 10) || 365, 1200);
      const start = url.searchParams.get("start") || "2015-01-01";
      const end = new Date().toISOString().slice(0, 10);
      const key = `kline:${symbol}:${period}:${start}:${end}:${count}`;

      // 1) 先读 KV 缓存
      try {
        const cached = await env.CACHE.get(key);
        if (cached) return json({ ...JSON.parse(cached), cached: true });
      } catch (_) { /* ignore */ }

      // 2) 取数（腾讯，多 host 轮换）
      const rows = await fetchKline(symbol, period, start, end, count);
      if (!rows || rows.length === 0) {
        return json({ error: "fetch failed or empty", symbol }, 502);
      }

      const payload = {
        symbol, period, start, end, count: rows.length,
        updated: Date.now(), data: rows,
      };

      // 3) 写回缓存（TTL 1h；指数日线一天更新一次足够）
      ctx.waitUntil(
        env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
      );
      return json(payload);
    }

    return json({
      service: "a-stock-api",
      source: "腾讯财经 (改编自 simonlin1212/a-stock-data, Apache-2.0)",
      endpoints: {
        kline: "/api/kline?symbol=sz399006&period=day&count=365",
      },
      examples: {
        "创业板指": "sz399006",
        "沪深300": "sh000300",
        "上证指数": "sh000001",
        "中证红利低波(若腾讯有)": "sh000919",
      },
    });
  },
};
