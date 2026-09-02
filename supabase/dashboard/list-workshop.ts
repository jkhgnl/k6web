// list-workshop - Dashboard 内联版（共享代码已内联，无需 _shared 目录）
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-auth",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders },
  });
}
async function getUser(req, supabase) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
function handleOptions(req) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

// 创意工坊 - 作品列表（公开）
// GET ?page=1&page_size=12&category=theme
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("page_size") || "12", 10) || 12));
    const category = url.searchParams.get("category") || null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase
      .from("workshop_items")
      .select("id, title, description, category, file_name, file_size, download_count, created_at, profiles(username, avatar_url)")
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    let countQuery = supabase
      .from("workshop_items")
      .select("id", { count: "exact", head: true });

    if (category && category !== "all") {
      query = query.eq("category", category);
      countQuery = countQuery.eq("category", category);
    }

    const [{ data, error }, { count }] = await Promise.all([query, countQuery]);
    if (error) throw error;

    return jsonResponse({
      items: data,
      page,
      page_size: pageSize,
      total: count || 0,
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});