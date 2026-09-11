// 友情链接 - 管理接口（仅管理员 Jkhgnl 可写）
// POST   { name, description, avatar_url, site_url, display_order }  -> 新增
// PUT    ?id=xxx + { name, description, avatar_url, site_url, display_order } -> 更新
// DELETE ?id=xxx  -> 删除
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";
import { isAdminUser } from "../_shared/admin.ts";

const MAX = { name: 60, description: 300, url: 500 };

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 校验并归一化字段；返回 { error } 或 { name, description, avatar_url, site_url, displayOrder }
function parseBody(body: Record<string, unknown>) {
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const avatarUrl = String(body.avatar_url || "").trim();
  const siteUrl = String(body.site_url || "").trim();
  const displayOrder = body.display_order != null ? parseInt(String(body.display_order), 10) : 0;

  if (!name) return { error: "网站名称必填" };
  if (name.length > MAX.name) return { error: `网站名称不超过 ${MAX.name} 字符` };
  if (description.length > MAX.description) return { error: `网站简介不超过 ${MAX.description} 字符` };
  if (!siteUrl) return { error: "网站链接必填" };
  if (siteUrl.length > MAX.url) return { error: "网站链接不超过 500 字符" };
  if (!isHttpUrl(siteUrl)) return { error: "网站链接需以 http:// 或 https:// 开头" };
  if (avatarUrl) {
    if (avatarUrl.length > MAX.url) return { error: "头像链接不超过 500 字符" };
    if (!isHttpUrl(avatarUrl)) return { error: "头像链接需以 http:// 或 https:// 开头" };
  }

  return {
    name,
    description: description || null,
    avatar_url: avatarUrl || null,
    site_url: siteUrl,
    displayOrder: Number.isFinite(displayOrder) ? displayOrder : 0,
  };
}

const SELECT = "id, name, description, avatar_url, site_url, display_order, created_at";

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
    if (!isAdminUser(user)) return jsonResponse({ error: "仅管理员可操作友情链接" }, 403);

    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // ---------- DELETE ----------
    if (method === "DELETE") {
      const id = url.searchParams.get("id")?.trim();
      if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);
      const { error } = await supabase.from("friend_links").delete().eq("id", id);
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    // ---------- PUT / PATCH : 更新 ----------
    if (method === "PUT" || method === "PATCH") {
      const id = url.searchParams.get("id")?.trim();
      if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);
      const body = await req.json().catch(() => ({}));
      const parsed = parseBody(body);
      if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);

      const updates: Record<string, unknown> = {
        name: parsed.name,
        description: parsed.description,
        avatar_url: parsed.avatar_url,
        site_url: parsed.site_url,
      };
      if (Number.isFinite(parsed.displayOrder)) updates.display_order = parsed.displayOrder;

      const { data, error } = await supabase
        .from("friend_links")
        .update(updates)
        .eq("id", id)
        .select(SELECT)
        .single();
      if (error) throw error;
      return jsonResponse({ item: data });
    }

    // ---------- POST : 新增 ----------
    if (method === "POST") {
      const body = await req.json().catch(() => ({}));
      const parsed = parseBody(body);
      if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);

      const { data, error } = await supabase
        .from("friend_links")
        .insert({
          name: parsed.name,
          description: parsed.description,
          avatar_url: parsed.avatar_url,
          site_url: parsed.site_url,
          display_order: parsed.displayOrder,
        })
        .select(SELECT)
        .single();
      if (error) throw error;
      return jsonResponse({ item: data }, 201);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
