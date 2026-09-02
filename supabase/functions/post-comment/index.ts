// 创意工坊/反馈区 - 发表评论（需登录）
// POST body: { item_id, item_type, content, parent_id? }
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions, getUser } from "../_shared/cors.ts";

// 异步发邮件（不阻塞主流程）
async function sendEmailToUser(supabase: any, userId: string, type: string, title: string, content: string, fromUsername: string) {
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(userId);
    if (!userData?.user?.email) return;
    const funcBase = Deno.env.get("SUPABASE_URL") + "/functions/v1";
    await fetch(`${funcBase}/send-notification-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      },
      body: JSON.stringify({ to: userData.user.email, type, title, content, from_username: fromUsername }),
    });
  } catch (e) { console.error("邮件发送失败:", e); }
}

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

    // 获取当前用户资料
    const { data: myProfile } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", user.id)
      .single();
    const myUsername = myProfile?.username || "匿名";

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

    // 如果是回复，验证父评论存在并获取父评论作者
    let parentCommentUserId: string | null = null;
    let parentCommentContent = "";
    if (parent_id) {
      const { data: parentComment, error: parentError } = await supabase
        .from("comments")
        .select("id, parent_id, user_id, content")
        .eq("id", parent_id)
        .single();

      if (parentError || !parentComment) {
        return jsonResponse({ error: "父评论不存在" }, 404);
      }

      // 限制嵌套深度
      if (parentComment.parent_id) {
        return jsonResponse({ error: "只支持两层嵌套回复" }, 400);
      }

      parentCommentUserId = parentComment.user_id;
      parentCommentContent = parentComment.content;
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

    // ---------- 触发通知 ----------
    const notifiedUsers = new Set<string>(); // 去重

    // 1. 回复通知：通知父评论作者
    if (parent_id && parentCommentUserId && parentCommentUserId !== user.id) {
      notifiedUsers.add(parentCommentUserId);
      try {
        await supabase.from("notifications").insert({
          user_id: parentCommentUserId,
          type: "reply",
          title: "回复了你的评论",
          content: trimmedContent.slice(0, 100),
          from_user_id: user.id,
          from_username: myUsername,
          item_id,
          item_type,
          comment_id: comment.id,
        });
        // 异步发邮件
        sendEmailToUser(supabase, parentCommentUserId, "reply", "回复了你的评论", trimmedContent.slice(0, 100), myUsername);
      } catch (e) { console.error("回复通知失败:", e); }
    }

    // 2. @提及通知：解析 content 中的 @username
    const mentionRegex = /@(\S+)/g;
    let match;
    while ((match = mentionRegex.exec(trimmedContent)) !== null) {
      const mentionedName = match[1];
      // 查找被@用户
      const { data: mentionedUser } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", mentionedName)
        .single();

      if (mentionedUser && mentionedUser.id !== user.id && !notifiedUsers.has(mentionedUser.id)) {
        notifiedUsers.add(mentionedUser.id);
        try {
          await supabase.from("notifications").insert({
            user_id: mentionedUser.id,
            type: "mention",
            title: "在评论中提到了你",
            content: trimmedContent.slice(0, 100),
            from_user_id: user.id,
            from_username: myUsername,
            item_id,
            item_type,
            comment_id: comment.id,
          });
          // 异步发邮件
          sendEmailToUser(supabase, mentionedUser.id, "mention", "在评论中提到了你", trimmedContent.slice(0, 100), myUsername);
        } catch (e) { console.error("提及通知失败:", e); }
      }
    }

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
