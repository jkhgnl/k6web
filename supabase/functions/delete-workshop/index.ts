// 创意工坊 - 删除作品（仅限本人或管理员）
// DELETE ?id=<uuid>
// 文件删除：R2 与 Supabase Storage 双端尽力清理（迁移期间新旧文件可能分散在两处）
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";
import { isAdminUser } from "../_shared/admin.ts";
import { r2DeleteObject } from "../_shared/r2.ts";

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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
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
    if (item.user_id !== user.id && !isAdminUser(user)) return jsonResponse({ error: "无权删除他人作品" }, 403);

    // 删数据库记录
    const { error: delErr } = await supabase
      .from("workshop_items")
      .delete()
      .eq("id", id);
    if (delErr) throw delErr;

    // 删文件（尽力而为，失败不影响返回；双端都尝试以覆盖迁移过渡期）
    if (item.file_path) {
      await r2DeleteObject(item.file_path).catch(() => {});
      await supabase.storage.from("workshop").remove([item.file_path]).catch(() => {});
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
