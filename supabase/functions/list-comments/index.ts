// 创意工坊/反馈区 - 评论列表（公开）
// GET ?item_id=xxx&item_type=workshop
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions, getUser } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const itemId = url.searchParams.get("item_id");
    const itemType = url.searchParams.get("item_type") || "workshop";

    if (!itemId) {
      return jsonResponse({ error: "item_id is required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 获取当前登录用户（用于判断是否点赞）
    const user = await getUser(req, supabase);
    const userId = user?.id || null;

    // 获取评论列表（顶级评论）
    const { data: comments, error } = await supabase
      .from("comments")
      .select("id, content, user_id, parent_id, created_at, profiles(username, avatar_url)")
      .eq("item_id", itemId)
      .eq("item_type", itemType)
      .is("parent_id", null)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    // 获取每个评论的回复
    const commentsWithReplies = await Promise.all(
      (comments || []).map(async (comment) => {
        // 获取回复
        const { data: replies } = await supabase
          .from("comments")
          .select("id, content, user_id, parent_id, created_at, profiles(username, avatar_url)")
          .eq("parent_id", comment.id)
          .order("created_at", { ascending: true })
          .limit(20);

        // 获取点赞数
        const { count: likesCount } = await supabase
          .from("comment_likes")
          .select("id", { count: "exact", head: true })
          .eq("comment_id", comment.id);

        // 获取当前用户是否已点赞
        let userHasLiked = false;
        if (userId) {
          const { data: likeData } = await supabase
            .from("comment_likes")
            .select("id")
            .eq("comment_id", comment.id)
            .eq("user_id", userId)
            .limit(1);
          userHasLiked = (likeData || []).length > 0;
        }

        return {
          ...comment,
          likes_count: likesCount || 0,
          user_has_liked: userHasLiked,
          replies: replies || [],
        };
      })
    );

    // 获取总数
    const { count: total } = await supabase
      .from("comments")
      .select("id", { count: "exact", head: true })
      .eq("item_id", itemId)
      .eq("item_type", itemType);

    return jsonResponse({
      comments: commentsWithReplies,
      total: total || 0,
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
