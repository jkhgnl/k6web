// 创意工坊 - 上传作品（需登录）
// POST multipart/form-data: title, description, category, file, thumbnail?
// 文件大小限制 1.5MB，缩略图限制 500KB
// 存储：优先 Cloudflare R2（方案 A 公开桶）；未配置 R2 时回退 Supabase Storage
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";
import { r2Enabled, r2PutObject, r2PublicUrl } from "../_shared/r2.ts";

const MAX_FILE_SIZE = 1.5 * 1024 * 1024; // 1.5MB
const MAX_THUMB_SIZE = 500 * 1024; // 500KB
const ALLOWED_EXT = [".bin", ".bxt", ".csv", ".txt", ".json", ".py", ".js", ".html", ".zip", ".dat"];
const ALLOWED_CATEGORIES = new Set(["theme", "channel", "extension", "firmware", "other"]);
const ALLOWED_IMG_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

function isAllowedExt(name: string): boolean {
  if (!Array.isArray(ALLOWED_EXT)) return true;
  const lowerName = name.toLowerCase();
  return ALLOWED_EXT.some((ext) => lowerName.endsWith(ext));
}

function isAllowedImgExt(name: string): boolean {
  const lowerName = name.toLowerCase();
  return ALLOWED_IMG_EXT.some((ext) => lowerName.endsWith(ext));
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const user = await getUser(req, supabase);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);

    // 确保 workshop 存储桶存在（仅在回退 Supabase Storage 时需要）
    const useR2 = r2Enabled();
    if (!useR2) {
      const { data: bucket } = await supabase.storage.getBucket("workshop");
      if (!bucket) {
        await supabase.storage.createBucket("workshop", { public: false });
      }
    }

    const form = await req.formData();
    const title = (form.get("title") as string || "").trim();
    const description = (form.get("description") as string || "").trim();
    const category = (form.get("category") as string || "other").trim();
    const file = form.get("file") as File | null;
    const thumbnail = form.get("thumbnail") as File | null;

    if (!title || title.length > 60) return jsonResponse({ error: "标题必填且不超过 60 字符" }, 400);
    if (description.length > 1000) return jsonResponse({ error: "描述不超过 1000 字符" }, 400);
    if (!ALLOWED_CATEGORIES.has(category)) return jsonResponse({ error: "分类不合法" }, 400);
    if (!file) return jsonResponse({ error: "请选择文件" }, 400);
    if (file.size > MAX_FILE_SIZE) return jsonResponse({ error: "文件超过 1.5MB 限制" }, 413);
    if (file.size === 0) return jsonResponse({ error: "文件为空" }, 400);
    if (!isAllowedExt(file.name)) {
      return jsonResponse({ error: "不支持的文件类型" }, 400);
    }

    // 验证缩略图（可选）
    if (thumbnail) {
      if (thumbnail.size > MAX_THUMB_SIZE) return jsonResponse({ error: "展示图不能超过 500KB" }, 413);
      if (!isAllowedImgExt(thumbnail.name)) {
        return jsonResponse({ error: "展示图仅支持 jpg/png/gif/webp" }, 400);
      }
    }

    const ext = file.name.toLowerCase().slice(file.name.toLowerCase().lastIndexOf("."));
    const filePath = `${user.id}/${Date.now()}_${crypto.randomUUID()}${ext}`;

    // 上传主文件
    let downloadUrl = "";
    if (useR2) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await r2PutObject(filePath, bytes, file.type || "application/octet-stream");
      downloadUrl = r2PublicUrl(filePath);
    } else {
      const { error: upErr } = await supabase.storage
        .from("workshop")
        .upload(filePath, file, { contentType: file.type || "application/octet-stream" });
      if (upErr) throw upErr;
    }

    // 上传缩略图（可选）
    let thumbnailUrl = "";
    if (thumbnail) {
      const thumbExt = thumbnail.name.toLowerCase().slice(thumbnail.name.toLowerCase().lastIndexOf("."));
      const thumbPath = `${user.id}/${Date.now()}_thumb_${crypto.randomUUID()}${thumbExt}`;
      if (useR2) {
        const bytes = new Uint8Array(await thumbnail.arrayBuffer());
        await r2PutObject(thumbPath, bytes, thumbnail.type || "image/jpeg");
        thumbnailUrl = r2PublicUrl(thumbPath);
      } else {
        const { error: thumbErr } = await supabase.storage
          .from("workshop")
          .upload(thumbPath, thumbnail, { contentType: thumbnail.type || "image/jpeg" });
        if (thumbErr) throw thumbErr;

        const { data: thumbUrlData } = await supabase.storage
          .from("workshop")
          .createSignedUrl(thumbPath, 3600 * 24 * 365);
        thumbnailUrl = thumbUrlData?.signedUrl || "";
      }
    }

    // 写入数据库
    const { data, error } = await supabase
      .from("workshop_items")
      .insert({
        user_id: user.id,
        title,
        description,
        category,
        file_path: filePath,
        file_name: file.name,
        file_size: file.size,
        thumbnail_url: thumbnailUrl,
      })
      .select("id, title, description, category, file_name, file_size, thumbnail_url, download_count, created_at")
      .single();
    if (error) throw error;

    return jsonResponse({ item: data, download_url: downloadUrl }, 201);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
