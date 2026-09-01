/**
 * Cloudflare Worker：GPS 扫码传定位中转
 *
 * 流程：
 * 1. 网页生成二维码 → https://<worker>/setgps?t=<token>
 * 2. 手机扫码 → 打开 Worker URL → 浏览器弹出定位授权
 * 3. 手机授权后 → GPS 数据上报到 Worker（存入 KV）
 * 4. 网页轮询 → https://<worker>/getgps?t=<token> → 拿到 GPS 数据
 *
 * 部署：
 * 1. wrangler kv namespace create GPS_KV
 * 2. 把 id 填入 wrangler.toml 的 kv_namespace
 * 3. wrangler deploy
 */

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// 手机端页面：获取 GPS 后自动上报
function gpsPage(token, workerUrl) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>上报位置</title>
<style>
  body { font-family: -apple-system, sans-serif; text-align: center; padding: 40px 20px; color: #333; }
  .msg { margin: 20px 0; font-size: 16px; line-height: 1.6; }
  .ok { color: #16a34a; font-size: 20px; font-weight: bold; }
  .err { color: #dc2626; }
  .coord { font-size: 14px; color: #666; margin: 10px 0; }
</style>
</head>
<body>
<div id="status" class="msg">正在获取位置…</div>
<script>
(function() {
  var token = "${token}";
  var workerUrl = "${workerUrl}";

  if (!navigator.geolocation) {
    document.getElementById("status").innerHTML = '<div class="err">❌ 手机浏览器不支持定位</div>';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      var lat = pos.coords.latitude;
      var lon = pos.coords.longitude;
      var alt = pos.coords.altitude || 0;
      document.getElementById("status").innerHTML =
        '<div class="ok">✅ 位置已上报</div>' +
        '<div class="coord">纬度: ' + lat.toFixed(6) + '<br>经度: ' + lon.toFixed(6) + '<br>海拔: ' + alt.toFixed(1) + ' m</div>';

      // 上报到 Worker
      fetch(workerUrl + "/setgps?t=" + token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: lat, lon: lon, alt: alt })
      }).then(function(r) {
        if (!r.ok) {
          document.getElementById("status").innerHTML =
            '<div class="err">❌ 上报失败 (HTTP ' + r.status + ')</div>' +
            '<div class="coord">纬度: ' + lat.toFixed(6) + '<br>经度: ' + lon.toFixed(6) + '</div>';
        }
      }).catch(function(e) {
        document.getElementById("status").innerHTML =
          '<div class="err">❌ 上报失败: ' + e.message + '</div>' +
          '<div class="coord">纬度: ' + lat.toFixed(6) + '<br>经度: ' + lon.toFixed(6) + '</div>';
      });
    },
    function(err) {
      document.getElementById("status").innerHTML = '<div class="err">❌ 定位失败: ' + err.message + '</div>';
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
})();
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const token = url.searchParams.get("t");
    const origin = request.headers.get("Origin") || "";

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const cors = corsHeaders(origin);
    const jsonHeaders = { "Content-Type": "application/json", ...cors };

    // ---------- /setgps ----------
    if (path === "/setgps" && token) {
      // POST：手机上报 GPS 数据
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { lat, lon, alt } = body;
          console.log("[setgps] POST token=" + token, lat, lon, alt);
          if (typeof lat === "number" && typeof lon === "number") {
            await env.GPS_KV.put("gps:" + token, JSON.stringify({ lat, lon, alt: alt || 0 }), { expirationTtl: 300 });
            console.log("[setgps] KV stored gps:" + token);
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
          }
        } catch (e) { console.log("[setgps] error:", e); }
        return new Response(JSON.stringify({ ok: false, error: "invalid data" }), { status: 400, headers: jsonHeaders });
      }

      // GET：返回手机端定位页面
      const workerUrl = url.origin;
      return new Response(gpsPage(token, workerUrl), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...cors },
      });
    }

    // ---------- /getgps ----------
    if (path === "/getgps" && token) {
      console.log("[getgps] GET token=" + token);
      const data = await env.GPS_KV.get("gps:" + token, "json");
      console.log("[getgps] KV result:", data);
      if (data) {
        return new Response(JSON.stringify({ ok: true, lat: data.lat, lon: data.lon, alt: data.alt || 0 }), { status: 200, headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 200, headers: jsonHeaders });
    }

    // ---------- 根路径：说明页 ----------
    if (path === "/") {
      return new Response("GPS QR Relay Worker. 请通过网页二维码使用。", { status: 200, headers: cors });
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
};
