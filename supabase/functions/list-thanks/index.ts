// 鸣谢榜 - 公开列表
// GET ?page=1&page_size=50  默认一次性返回全部
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size") || "50", 10) || 50));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error, count } = await supabase
      .from("thanks")
      .select("id, name, callsign, amount, message, display_order, created_at", { count: "exact" })
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (error) throw error;

    return jsonResponse({
      items: data || [],
      page,
      page_size: pageSize,
      total: count || 0,
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
