/**
 * Cloudflare Worker：CORS 代理 Gitee 固件下载
 *
 * 部署步骤：
 * 1. 登录 https://dash.cloudflare.com/
 * 2. Workers & Pages → Create application → Create Worker
 * 3. 把本脚本粘贴进去，保存
 * 4. 记录 Worker 的 URL（如 https://k6web-proxy.xxx.workers.dev）
 * 5. 在 app.js 中把 WORKER_PROXY_URL 替换为你的 Worker URL
 */

// 允许代理的域名白名单（安全限制）
const ALLOWED_HOSTS = [
  "gitee.com",
  "raw.giteeusercontent.com",
  "giteeusercontent.com"
];

// 允许的请求来源（根据你的 GitHub Pages 域名调整）
// 生产环境建议改成你的域名，如 "https://jkhgnl.top"
const ALLOWED_ORIGINS = ["*"];

function isAllowedUrl(urlString) {
  try {
    const url = new URL(urlString);
    return ALLOWED_HOSTS.some(host => url.hostname === host || url.hostname.endsWith("." + host));
  } catch (e) {
    return false;
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes("*") ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Disposition"
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // 处理 CORS 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    }

    // 获取目标 URL
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    }

    // 安全校验：只允许 Gitee 域名
    if (!isAllowedUrl(targetUrl)) {
      return new Response(JSON.stringify({ error: "Domain not allowed" }), {
        status: 403,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    }

    try {
      // 转发请求到 Gitee
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: {
          "User-Agent": request.headers.get("User-Agent") || "k6web-cors-proxy/1.0"
        }
      });

      if (!response.ok) {
        return new Response(JSON.stringify({ error: `Upstream error: ${response.status}` }), {
          status: response.status,
          headers: {
            ...corsHeaders(origin),
            "Content-Type": "application/json"
          }
        });
      }

      // 复制响应头并追加 CORS
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(origin))) {
        newHeaders.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || "Proxy failed" }), {
        status: 502,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    }
  }
};
