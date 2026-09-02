// 站内信 - 标记全部已读（需登录）
// POST body: {}
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

    const user = await getUser(req, supabase);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);

    const { error } = await supabase.rpc("mark_all_read", { uid: user.id });
    if (error) throw error;

    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
