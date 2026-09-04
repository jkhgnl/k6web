// 创意工坊 - 作品列表（公开）
// GET ?page=1&page_size=12&category=theme&q=关键词
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("page_size") || "12", 10) || 12));
    const category = url.searchParams.get("category") || null;
    const q = (url.searchParams.get("q") || "").trim();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase
      .from("workshop_items")
      .select("id, user_id, title, description, category, file_name, file_size, thumbnail_url, download_count, created_at, profiles(username, avatar_url)")
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    let countQuery = supabase
      .from("workshop_items")
      .select("id", { count: "exact", head: true });

    if (category && category !== "all") {
      query = query.eq("category", category);
      countQuery = countQuery.eq("category", category);
    }
    if (q) {
      const pattern = `%${q}%`;
      query = query.or(`title.ilike.${pattern},description.ilike.${pattern},file_name.ilike.${pattern}`);
      countQuery = countQuery.or(`title.ilike.${pattern},description.ilike.${pattern},file_name.ilike.${pattern}`);
    }

    const [{ data, error }, { count }] = await Promise.all([query, countQuery]);
    if (error) throw error;

    return jsonResponse({
      items: data,
      page,
      page_size: pageSize,
      total: count || 0,
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
