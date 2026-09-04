// 创意工坊 - 编辑作品（仅限本人）
// POST multipart/form-data: id, title, description, category, [file], [thumbnail]
// 不传 file / thumbnail 时保留原文件；传了则替换并删除旧文件
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";
import { r2Enabled, r2PutObject, r2PublicUrl, r2DeleteObject } from "../_shared/r2.ts";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_THUMB_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_EXT = [".bin", ".bxt", ".csv", ".txt", ".json", ".py", ".js", ".html", ".zip", ".dat"];
const ALLOWED_CATEGORIES = new Set(["theme", "channel", "extension", "firmware", "logo", "other"]);
const ALLOWED_IMG_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

function isAllowedExt(name: string): boolean {
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

    const form = await req.formData();
    const id = (form.get("id") as string || "").trim();
    const title = (form.get("title") as string || "").trim();
    const description = (form.get("description") as string || "").trim();
    const category = (form.get("category") as string || "other").trim();
    const file = form.get("file") as File | null;
    const thumbnail = form.get("thumbnail") as File | null;

    if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);
    if (!title || title.length > 60) return jsonResponse({ error: "标题必填且不超过 60 字符" }, 400);
    if (description.length > 1000) return jsonResponse({ error: "描述不超过 1000 字符" }, 400);
    if (!ALLOWED_CATEGORIES.has(category)) return jsonResponse({ error: "分类不合法" }, 400);

    // 读取记录确认归属
    const { data: item, error: getErr } = await supabase
      .from("workshop_items")
      .select("user_id, file_path, thumbnail_url")
      .eq("id", id)
      .single();
    if (getErr || !item) return jsonResponse({ error: "作品不存在" }, 404);
    if (item.user_id !== user.id) return jsonResponse({ error: "无权编辑他人作品" }, 403);

    // 校验可选的新文件
    if (file) {
      if (file.size > MAX_FILE_SIZE) return jsonResponse({ error: "文件超过 50MB 限制" }, 413);
      if (file.size === 0) return jsonResponse({ error: "文件为空" }, 400);
      if (!isAllowedExt(file.name)) return jsonResponse({ error: "不支持的文件类型" }, 400);
    }
    if (thumbnail) {
      if (thumbnail.size > MAX_THUMB_SIZE) return jsonResponse({ error: "展示图不能超过 20MB" }, 413);
      if (!isAllowedImgExt(thumbnail.name)) {
        return jsonResponse({ error: "展示图仅支持 jpg/png/gif/webp" }, 400);
      }
    }

    // 需要更新的字段
    const updates: Record<string, unknown> = { title, description, category };
    const useR2 = r2Enabled();

    // 替换主文件（可选）
    if (file) {
      const ext = file.name.toLowerCase().slice(file.name.toLowerCase().lastIndexOf("."));
      const filePath = `${user.id}/${Date.now()}_${crypto.randomUUID()}${ext}`;
      if (useR2) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await r2PutObject(filePath, bytes, file.type || "application/octet-stream");
      } else {
        const { error: upErr } = await supabase.storage
          .from("workshop")
          .upload(filePath, file, { contentType: file.type || "application/octet-stream" });
        if (upErr) throw upErr;
      }

      updates.file_path = filePath;
      updates.file_name = file.name;
      updates.file_size = file.size;

      // 删除旧文件（尽力而为，双端都尝试）
      if (item.file_path) {
        await r2DeleteObject(item.file_path).catch(() => {});
        await supabase.storage.from("workshop").remove([item.file_path]).catch(() => {});
      }
    }

    // 替换缩略图（可选）
    if (thumbnail) {
      const thumbExt = thumbnail.name.toLowerCase().slice(thumbnail.name.toLowerCase().lastIndexOf("."));
      const thumbPath = `${user.id}/${Date.now()}_thumb_${crypto.randomUUID()}${thumbExt}`;
      if (useR2) {
        const bytes = new Uint8Array(await thumbnail.arrayBuffer());
        await r2PutObject(thumbPath, bytes, thumbnail.type || "image/jpeg");
        updates.thumbnail_url = r2PublicUrl(thumbPath);
      } else {
        const { error: thumbErr } = await supabase.storage
          .from("workshop")
          .upload(thumbPath, thumbnail, { contentType: thumbnail.type || "image/jpeg" });
        if (thumbErr) throw thumbErr;

        const { data: thumbUrlData } = await supabase.storage
          .from("workshop")
          .createSignedUrl(thumbPath, 3600 * 24 * 365);
        updates.thumbnail_url = thumbUrlData?.signedUrl || "";
      }
    }

    const { data, error } = await supabase
      .from("workshop_items")
      .update(updates)
      .eq("id", id)
      .select("id, title, description, category, file_name, file_size, thumbnail_url, download_count, created_at")
      .single();
    if (error) throw error;

    return jsonResponse({ item: data });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
