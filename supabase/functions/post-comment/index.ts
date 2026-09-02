// 创意工坊/反馈区 - 发表评论（需登录）
// POST body: { item_id, item_type, content, parent_id? }
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
    const { item_id, item_type = "workshop", content, parent_id } = body;

    if (!item_id || !content) {
      return jsonResponse({ error: "item_id 和 content 不能为空" }, 400);
    }

    // 内容长度限制
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return jsonResponse({ error: "评论内容不能为空" }, 400);
    }
    if (trimmedContent.length > 1000) {
      return jsonResponse({ error: "评论内容不能超过 1000 字" }, 400);
    }

    // 如果是回复，验证父评论存在
    if (parent_id) {
      const { data: parentComment, error: parentError } = await supabase
        .from("comments")
        .select("id, parent_id")
        .eq("id", parent_id)
        .single();

      if (parentError || !parentComment) {
        return jsonResponse({ error: "父评论不存在" }, 404);
      }

      // 限制嵌套深度：父评论不能已经是回复（即只能两层）
      if (parentComment.parent_id) {
        return jsonResponse({ error: "只支持两层嵌套回复" }, 400);
      }
    }

    // 插入评论
    const { data: comment, error: insertError } = await supabase
      .from("comments")
      .insert({
        item_id,
        item_type,
        user_id: user.id,
        content: trimmedContent,
        parent_id: parent_id || null,
      })
      .select("id, content, user_id, parent_id, created_at")
      .single();

    if (insertError) throw insertError;

    // 获取用户资料
    const { data: profile } = await supabase
      .from("profiles")
      .select("username, avatar_url")
      .eq("id", user.id)
      .single();

    return jsonResponse({
      comment: {
        ...comment,
        profiles: profile || { username: "匿名", avatar_url: null },
        likes_count: 0,
        user_has_liked: false,
        replies: [],
      },
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
