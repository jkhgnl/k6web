// 鸣谢榜 - 公开列表
// GET ?page=1&page_size=50&category=sponsor|beta  默认一次性返回全部（不分类别）
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size") || "50", 10) || 50));
    const category = url.searchParams.get("category")?.trim();
    if (category && !["sponsor", "beta"].includes(category)) {
      return jsonResponse({ error: "category 仅支持 sponsor / beta" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase
      .from("thanks")
      .select("id, name, callsign, amount, message, category, avatar_url, display_order, created_at", { count: "exact" })
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (category) query = query.eq("category", category);

    const { data, error, count } = await query;
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
