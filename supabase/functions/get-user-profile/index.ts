// 公开用户主页 - 获取用户资料和作品
// GET ?id=<user_id>
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 获取用户资料
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, username, avatar_url, bio, created_at")
      .eq("id", id)
      .single();
    if (profileErr || !profile) return jsonResponse({ error: "用户不存在" }, 404);

    // 获取用户作品（最多 20 条）
    const { data: works } = await supabase
      .from("workshop_items")
      .select("id, title, description, category, file_name, file_size, thumbnail_url, download_count, created_at")
      .eq("user_id", id)
      .order("created_at", { ascending: false })
      .limit(20);

    return jsonResponse({ profile, works: works || [] });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
