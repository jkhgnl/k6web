// 创意工坊/反馈区 - 点赞/取消点赞（需登录）
// POST body: { comment_id }
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

    // 验证评论存在
    const { data: comment, error: fetchError } = await supabase
      .from("comments")
      .select("id")
      .eq("id", comment_id)
      .single();

    if (fetchError || !comment) {
      return jsonResponse({ error: "评论不存在" }, 404);
    }

    // 检查是否已点赞
    const { data: existingLike } = await supabase
      .from("comment_likes")
      .select("id")
      .eq("comment_id", comment_id)
      .eq("user_id", user.id)
      .limit(1)
      .single();

    let liked = false;

    if (existingLike) {
      // 已点赞 → 取消点赞
      const { error: deleteError } = await supabase
        .from("comment_likes")
        .delete()
        .eq("id", existingLike.id);

      if (deleteError) throw deleteError;
      liked = false;
    } else {
      // 未点赞 → 点赞
      const { error: insertError } = await supabase
        .from("comment_likes")
        .insert({
          comment_id,
          user_id: user.id,
        });

      if (insertError) throw insertError;
      liked = true;
    }

    // 获取最新点赞数
    const { count: likesCount } = await supabase
      .from("comment_likes")
      .select("id", { count: "exact", head: true })
      .eq("comment_id", comment_id);

    return jsonResponse({
      liked,
      likes_count: likesCount || 0,
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
