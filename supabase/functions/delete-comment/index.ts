// 创意工坊/反馈区 - 删除评论（需登录，仅限作者或管理员）
// POST body: { comment_id }
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions, getUser } from "../_shared/cors.ts";
import { isAdminUser } from "../_shared/admin.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 验证登录
    const user = await getUser(req, supabase);
    if (!user) {
      return jsonResponse({ error: "请先登录" }, 401);
    }

    // 解析请求体
    const body = await req.json();
    const { comment_id } = body;

    if (!comment_id) {
      return jsonResponse({ error: "comment_id 不能为空" }, 400);
    }

    // 验证评论存在且属于当前用户
    const { data: comment, error: fetchError } = await supabase
      .from("comments")
      .select("id, user_id")
      .eq("id", comment_id)
      .single();

    if (fetchError || !comment) {
      return jsonResponse({ error: "评论不存在" }, 404);
    }

    if (comment.user_id !== user.id && !isAdminUser(user)) {
      return jsonResponse({ error: "只能删除自己的评论" }, 403);
    }

    // 删除评论（级联删除会自动删除回复和点赞）
    const { error: deleteError } = await supabase
      .from("comments")
      .delete()
      .eq("id", comment_id);

    if (deleteError) throw deleteError;

    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
