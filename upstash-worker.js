/**
 * Cloudflare Worker：TLE + 卫星频率 Redis 缓存代理
 *
 * 功能：
 *   GET  /tle   → 返回 Redis 缓存的 TLE 数据（TTL 6h），无缓存则从 Celestrak 抓取
 *   GET  /freq  → 返回 Redis 中的频率数据
 *   POST /freq  → 更新 Redis 中的频率数据（管理接口）
 *
 * 部署：
 *   1. Upstash 创建 Redis 实例
 *   2. wrangler.toml 中设置环境变量 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *   3. wrangler deploy
 */

const TLE_TTL = 21600; // 6 小时（秒）
const FREQ_TTL = 604800; // 7 天（秒）

// Upstash REST API 辅助
async function redis(env, command) {
  const resp = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

// ---------- TLE 数据源（与 app.js 保持一致） ----------
const TLE_SOURCES = [
  { name: "Celestrak amateur(镜像1)", url: "https://api.github.com/repos/satvisorcom/satvisor-data/contents/celestrak/tle/amateur.tle", headers: { Accept: "application/vnd.github.raw+json" } },
  { name: "Celestrak amateur(镜像2)", url: "https://cdn.jsdelivr.net/gh/satvisorcom/satvisor-data@master/celestrak/tle/amateur.tle" },
  { name: "Celestrak active 全量", url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle" },
  { name: "Celestrak active(镜像)", url: "https://cdn.jsdelivr.net/gh/satvisorcom/satvisor-data@master/celestrak/tle/active.tle" },
  { name: "SatNOGS 数据库", url: "https://db.satnogs.org/api/tle/?format=3le" },
  { name: "AMSAT nasabare", url: "https://www.amsat.org/tle/current/nasabare.txt" },
  { name: "R4UAB satonline", url: "https://r4uab.ru/satonline.txt" },
  { name: "ARISS ISS", url: "https://live.ariss.org/iss.txt" },
];

function parseTLE(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const sats = [];
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i + 1] && lines[i + 1].startsWith("1 ") && lines[i + 2] && lines[i + 2].startsWith("2 ")) {
      const name = lines[i].trim();
      sats.push({ name, tle1: lines[i + 1], tle2: lines[i + 2] });
      i += 2;
    }
  }
  return sats;
}

async function fetchAndMergeTLE() {
  const results = await Promise.all(TLE_SOURCES.map(async (src) => {
    try {
      const resp = await fetch(src.url, { headers: src.headers || {} });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const sats = parseTLE(await resp.text());
      if (sats.length === 0) throw new Error("解析为空");
      return { name: src.name, sats };
    } catch (e) {
      return null;
    }
  }));
  const ok = results.filter(Boolean);
  if (ok.length === 0) throw new Error("所有 TLE 源均不可用");
  // 按 NORAD 去重，前面的源优先
  const seen = new Set();
  const merged = [];
  for (const r of ok) {
    for (const s of r.sats) {
      const id = s.tle1.substring(2, 7).trim();
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(s);
      }
    }
  }
  return merged;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders() };

    // ---------- GET /tle ----------
    if (path === "/tle" && request.method === "GET") {
      try {
        // 1. 查 Redis 缓存
        const cached = await redis(env, ["GET", "tle:data"]);
        if (cached) {
          return new Response(JSON.stringify({ ok: true, sats: JSON.parse(cached), source: "redis" }), { headers: jsonHeaders });
        }
      } catch (e) {
        // Redis 不可用，继续走网络
      }
      // 2. 缓存miss，从源抓取
      try {
        const sats = await fetchAndMergeTLE();
        // 存入 Redis
        try {
          await redis(env, ["SET", "tle:data", JSON.stringify(sats), "EX", String(TLE_TTL)]);
        } catch (_) {}
        return new Response(JSON.stringify({ ok: true, sats, source: "live" }), { headers: jsonHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 502, headers: jsonHeaders });
      }
    }

    // ---------- GET /freq ----------
    if (path === "/freq" && request.method === "GET") {
      try {
        const data = await redis(env, ["GET", "freq:data"]);
        if (data) {
          return new Response(JSON.stringify({ ok: true, map: JSON.parse(data) }), { headers: jsonHeaders });
        }
      } catch (e) {}
      return new Response(JSON.stringify({ ok: false }), { headers: jsonHeaders });
    }

    // ---------- POST /freq ----------
    if (path === "/freq" && request.method === "POST") {
      try {
        const body = await request.json();
        await redis(env, ["SET", "freq:data", JSON.stringify(body), "EX", String(FREQ_TTL)]);
        return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: jsonHeaders });
      }
    }

    // ---------- 根路径 ----------
    if (path === "/") {
      return new Response("TLE + Freq Cache Worker (Upstash Redis)", { headers: corsHeaders() });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};
