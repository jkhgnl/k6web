// 创意工坊 - 删除作品（仅限本人）
// DELETE ?id=<uuid>
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  if (req.method !== "DELETE") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY")!,
    );
    const user = await getUser(req, supabase);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);

    // 读取记录确认归属 + 拿 Storage 路径
    const { data: item, error: getErr } = await supabase
      .from("workshop_items")
      .select("user_id, file_path")
      .eq("id", id)
      .single();
    if (getErr || !item) return jsonResponse({ error: "作品不存在" }, 404);
    if (item.user_id !== user.id) return jsonResponse({ error: "无权删除他人作品" }, 403);

    // 删数据库记录
    const { error: delErr } = await supabase
      .from("workshop_items")
      .delete()
      .eq("id", id);
    if (delErr) throw delErr;

    // 删 Storage 文件（尽力而为，失败不影响返回）
    await supabase.storage.from("workshop").remove([item.file_path]);

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
