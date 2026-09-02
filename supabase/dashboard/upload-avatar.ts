// upload-avatar - Dashboard 内联版（共享代码已内联，无需 _shared 目录）
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

// 上传头像（需登录）
// POST multipart/form-data: file（图片 JPG/PNG/GIF/WebP ≤2MB）
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_SIZE = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

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

    // 确保 avatars 公共桶存在
    const { data: bucket } = await supabase.storage.getBucket("avatars");
    if (!bucket) {
      await supabase.storage.createBucket("avatars", {
        public: true,
        allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
        fileSizeLimit: MAX_SIZE,
      });
    }

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return jsonResponse({ error: "请选择图片" }, 400);
    if (file.size > MAX_SIZE) return jsonResponse({ error: "头像图片不超过 2MB" }, 413);
    if (!ALLOWED_MIME.has(file.type)) {
      return jsonResponse({ error: "仅支持 JPG/PNG/GIF/WebP 格式" }, 400);
    }

    const lowerName = file.name.toLowerCase();
    const ext = [...ALLOWED_EXT].find((e) => lowerName.endsWith(e)) || ".jpg";
    const filePath = `${user.id}/avatar${ext}`;

    const { error: upErr } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, { contentType: file.type, upsert: true });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from("avatars").getPublicUrl(filePath);
    const avatarUrl = pub.publicUrl;

    const { error: dbErr } = await supabase
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);
    if (dbErr) throw dbErr;

    return jsonResponse({ avatar_url: avatarUrl }, 200);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});