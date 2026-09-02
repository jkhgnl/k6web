// 站内信 - 通知列表（需登录）
// GET ?page=1&page_size=20&unread_only=false
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions, getUser } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const user = await getUser(req, supabase);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("page_size") || "20", 10)));
    const unreadOnly = url.searchParams.get("unread_only") === "true";

    let query = supabase
      .from("notifications")
      .select("id, type, title, content, from_username, item_id, item_type, comment_id, is_read, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (unreadOnly) query = query.eq("is_read", false);

    const { data, error } = await query;
    if (error) throw error;

    // 获取未读数
    const { count: unreadCount } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false);

    const { count: total } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    return jsonResponse({
      notifications: data || [],
      unread_count: unreadCount || 0,
      total: total || 0,
      page,
      page_size: pageSize,
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
