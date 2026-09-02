/**
 * Cloudflare Worker：高德地理编码代理
 *
 * 作用：把高德 Web 服务 Key 放在 Worker 环境变量中，前端无 Key 调用，
 *       避免 Key 暴露在公开的 GitHub Pages 源码里。
 *
 * 接口：
 *   GET /geocode?address=北京市朝阳区          → 地址精确编码（地址→经纬度）
 *   GET /tips?keywords=北京市朝                → 输入提示（边输入边模糊匹配）
 *   GET /regeo?lat=39.9&lon=116.4             → 逆地理编码（经纬度→地址，备用）
 *
 * 部署：
 *   1. wrangler secret put AMAP_KEY   （存高德 Web 服务 Key）
 *   2. wrangler deploy --config wrangler-amap.toml
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const AMAP_BASE = "https://restapi.amap.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function amapFetch(env, path, params) {
  const qs = new URLSearchParams({ key: env.AMAP_KEY, output: "JSON", ...params });
  const resp = await fetch(`${AMAP_BASE}${path}?${qs}`);
  if (!resp.ok) throw new Error("AMAP HTTP " + resp.status);
  return resp.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!env.AMAP_KEY) {
      return json({ error: "AMAP_KEY 未配置" }, 500);
    }
    const path = url.pathname;
    try {
      if (path === "/geocode") {
        const address = url.searchParams.get("address");
        if (!address) return json({ error: "缺少 address 参数" }, 400);
        const d = await amapFetch(env, "/v3/geocode/geo", { address });
        return json(d);
      }
      if (path === "/tips") {
        const keywords = url.searchParams.get("keywords");
        if (!keywords) return json({ error: "缺少 keywords 参数" }, 400);
        const d = await amapFetch(env, "/v3/assistant/inputtips", { keywords });
        return json(d);
      }
      if (path === "/regeo") {
        const lat = url.searchParams.get("lat");
        const lon = url.searchParams.get("lon");
        if (!lat || !lon) return json({ error: "缺少 lat/lon 参数" }, 400);
        const d = await amapFetch(env, "/v3/geocode/regeo", { location: `${lon},${lat}` });
        return json(d);
      }
      return new Response("AMap Geocode Proxy. Usage: /geocode?address=... | /tips?keywords=... | /regeo?lat=..&lon=..", {
        status: 200,
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};
