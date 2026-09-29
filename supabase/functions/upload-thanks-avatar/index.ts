// 鸣谢头像上传（仅管理员 Jkhgnl）
// POST multipart/form-data: file（图片 JPG/PNG/GIF/WebP ≤2MB）
// 存入 avatars 公共桶 thanks/ 路径，返回 { avatar_url }，由 manage-thanks 保存
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";
import { isAdminUser } from "../_shared/admin.ts";

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
    if (!isAdminUser(user)) return jsonResponse({ error: "仅管理员可上传鸣谢头像" }, 403);

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
    const filePath = `thanks/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;

    const { error: upErr } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from("avatars").getPublicUrl(filePath);
    return jsonResponse({ avatar_url: pub.publicUrl }, 200);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
