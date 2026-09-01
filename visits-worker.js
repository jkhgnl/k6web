/**
 * Cloudflare Worker：今日访问人次统计
 *
 * GET / → 原子递增 D1 今日计数，返回 { count, date }
 */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const today = new Date().toISOString().slice(0, 10);

    try {
      await env.DB.prepare(
        "INSERT INTO visits (date, count) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET count = count + 1"
      ).bind(today).run();

      const row = await env.DB.prepare(
        "SELECT count FROM visits WHERE date = ?"
      ).bind(today).first();

      return new Response(JSON.stringify({ count: row?.count ?? 1, date: today }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }
  },
};
