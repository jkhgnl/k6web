// 站内信 - 创建通知（供内部调用，处理回复和@提及）
// POST body: { user_id, type, title, content, from_user_id, from_username, item_id, item_type, comment_id }
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { user_id, type, title, content, from_user_id, from_username, item_id, item_type, comment_id } = body;

    if (!user_id || !type || !title) {
      return jsonResponse({ error: "缺少必要参数" }, 400);
    }

    // 不通知自己
    if (user_id === from_user_id) {
      return jsonResponse({ success: true, skipped: true });
    }

    const { data, error } = await supabase
      .from("notifications")
      .insert({
        user_id,
        type,
        title,
        content: content || null,
        from_user_id: from_user_id || null,
        from_username: from_username || null,
        item_id: item_id || null,
        item_type: item_type || null,
        comment_id: comment_id || null,
      })
      .select("id")
      .single();

    if (error) throw error;

    // 异步发送邮件通知（不阻塞响应）
    try {
      // 获取用户邮箱
      const { data: userData } = await supabase.auth.admin.getUserById(user_id);
      if (userData?.user?.email) {
        // 调用邮件通知 Edge Function
        await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/send-notification-email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
          },
          body: JSON.stringify({
            to: userData.user.email,
            type,
            title,
            content,
            from_username,
          }),
        });
      }
    } catch (emailErr) {
      // 邮件发送失败不阻塞主流程
      console.error("邮件发送失败:", emailErr);
    }

    return jsonResponse({ success: true, id: data.id });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
