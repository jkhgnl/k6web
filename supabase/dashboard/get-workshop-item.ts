// get-workshop-item - Dashboard 内联版（共享代码已内联，无需 _shared 目录）
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

// 创意工坊 - 作品详情 + 临时下载地址（公开）
// GET ?id=<uuid>
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase
      .from("workshop_items")
      .select("*, profiles(username, avatar_url)")
      .eq("id", id)
      .single();
    if (error || !data) return jsonResponse({ error: "作品不存在" }, 404);

    // 生成临时下载链接（公开桶的签名 URL）
    const { data: signed } = await supabase
      .storage
      .from("workshop")
      .createSignedUrl(data.file_path, 3600);

    return jsonResponse({ item: data, download_url: signed?.signedUrl || null });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});