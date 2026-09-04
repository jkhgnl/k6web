// 鸣谢榜 - 管理接口（仅管理员 Jkhgnl 可写）
// POST   { name, callsign, amount, message, display_order }  -> 新增
// PUT    ?id=xxx + { name, callsign, amount, message, display_order } -> 更新
// DELETE ?id=xxx  -> 删除
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";

function isAdmin(user: { email?: string; user_metadata?: Record<string, unknown> }): boolean {
  const email = (user.email || "").toLowerCase().trim();
  if (email === "jkhgnl@outlook.com" || email === "jkhgnl@outlook") return true;
  const meta = user.user_metadata || {};
  const candidates = [
    meta["user_name"],
    meta["name"],
    meta["full_name"],
    meta["preferred_username"],
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim().toLowerCase() === "jkhgnl") return true;
  }
  return false;
}

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
    if (!isAdmin(user)) return jsonResponse({ error: "仅管理员可操作鸣谢榜" }, 403);

    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // ---------- DELETE ----------
    if (method === "DELETE") {
      const id = url.searchParams.get("id")?.trim();
      if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);
      const { error } = await supabase.from("thanks").delete().eq("id", id);
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    // ---------- PUT / PATCH : 更新 ----------
    if (method === "PUT" || method === "PATCH") {
      const id = url.searchParams.get("id")?.trim();
      if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      const callsign = String(body.callsign || "").trim();
      const message = String(body.message || "").trim();
      const displayOrder = body.display_order != null ? parseInt(String(body.display_order), 10) : undefined;
      let amount: number | null = null;
      if (body.amount != null && String(body.amount).trim() !== "") {
        const n = Number(body.amount);
        if (!Number.isFinite(n) || n < 0) return jsonResponse({ error: "金额不合法" }, 400);
        amount = n;
      }
      if (!name) return jsonResponse({ error: "姓名必填" }, 400);
      if (name.length > 40) return jsonResponse({ error: "姓名不超过 40 字符" }, 400);
      if (callsign && !/^[A-Za-z0-9\-\/]{2,12}$/.test(callsign)) {
        return jsonResponse({ error: "呼号格式不合法（2-12 位字母/数字/-//，如 BG2XXX）" }, 400);
      }
      if (callsign.length > 20) return jsonResponse({ error: "呼号不超过 20 字符" }, 400);
      if (message.length > 200) return jsonResponse({ error: "留言不超过 200 字符" }, 400);

      const updates: Record<string, unknown> = {
        name,
        callsign: callsign ? callsign.toUpperCase() : null,
        amount,
        message: message || null,
      };
      if (Number.isFinite(displayOrder as number)) updates.display_order = displayOrder;

      const { data, error } = await supabase
        .from("thanks")
        .update(updates)
        .eq("id", id)
        .select("id, name, callsign, amount, message, display_order, created_at")
        .single();
      if (error) throw error;
      return jsonResponse({ item: data });
    }

    // ---------- POST : 新增 ----------
    if (method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      const callsign = String(body.callsign || "").trim();
      const message = String(body.message || "").trim();
      const displayOrder = body.display_order != null ? parseInt(String(body.display_order), 10) : 0;
      let amount: number | null = null;
      if (body.amount != null && String(body.amount).trim() !== "") {
        const n = Number(body.amount);
        if (!Number.isFinite(n) || n < 0) return jsonResponse({ error: "金额不合法" }, 400);
        amount = n;
      }
      if (!name) return jsonResponse({ error: "姓名必填" }, 400);
      if (name.length > 40) return jsonResponse({ error: "姓名不超过 40 字符" }, 400);
      if (callsign && !/^[A-Za-z0-9\-\/]{2,12}$/.test(callsign)) {
        return jsonResponse({ error: "呼号格式不合法（2-12 位字母/数字/-//，如 BG2XXX）" }, 400);
      }
      if (callsign.length > 20) return jsonResponse({ error: "呼号不超过 20 字符" }, 400);
      if (message.length > 200) return jsonResponse({ error: "留言不超过 200 字符" }, 400);

      const { data, error } = await supabase
        .from("thanks")
        .insert({
          name,
          callsign: callsign ? callsign.toUpperCase() : null,
          amount,
          message: message || null,
          display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
        })
        .select("id, name, callsign, amount, message, display_order, created_at")
        .single();
      if (error) throw error;
      return jsonResponse({ item: data }, 201);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
