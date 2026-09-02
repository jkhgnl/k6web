// 完善资料：GitHub 登录后设置唯一用户名 + 绑定邮箱（需登录）
// POST json { username, email? }
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions, corsHeaders } from "../_shared/cors.ts";

function isValidUsername(s) {
  return /^[a-zA-Z0-9_]{2,20}$/.test(s);
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const user = await getUser(req, supabase);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);

    const { username, email } = await req.json();
    if (!username || !isValidUsername(username)) {
      return jsonResponse({ error: "用户名需 2-20 字符，仅字母/数字/下划线" }, 400);
    }

    // 检查用户名唯一性（排除自己）
    const { data: existing, error: qErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", username)
      .neq("id", user.id)
      .maybeSingle();
    if (qErr) throw qErr;
    if (existing) {
      return jsonResponse({ error: "用户名已被占用" }, 409);
    }

    // 更新 profiles 表
    const { error: upErr } = await supabase
      .from("profiles")
      .update({ username })
      .eq("id", user.id);
    if (upErr) throw upErr;

    // 更新 user_metadata
    const { error: metaErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...(user.user_metadata || {}), user_name: username, profile_completed: true },
    });
    if (metaErr) throw metaErr;

    // 如果提供了邮箱，更新 auth email
    if (email && email !== user.email) {
      const { error: emailErr } = await supabase.auth.admin.updateUserById(user.id, { email });
      // 邮箱更新失败不阻塞整体流程
      if (emailErr) console.warn("email update failed:", emailErr.message);
    }

    return jsonResponse({ ok: true, username });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});