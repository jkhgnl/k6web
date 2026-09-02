// 创意工坊 - 上传作品（需登录）
// POST multipart/form-data: title, description, category, file
// 文件大小限制 1.5MB（Supabase Edge Function body 上限 2MB，留出余量）
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, getUser, handleOptions } from "../_shared/cors.ts";

const MAX_FILE_SIZE = 1.5 * 1024 * 1024; // 1.5MB
const ALLOWED_EXT = [".bin", ".csv", ".txt", ".json", ".py", ".js", ".html", ".zip", ".dat"];
const ALLOWED_CATEGORIES = new Set(["theme", "channel", "extension", "other"]);

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

    // 确保 workshop 存储桶存在（不存在则创建，私有桶 + 签名 URL 下载）
    const { data: bucket } = await supabase.storage.getBucket("workshop");
    if (!bucket) {
      await supabase.storage.createBucket("workshop", { public: false });
    }

    const form = await req.formData();
    const title = (form.get("title") as string || "").trim();
    const description = (form.get("description") as string || "").trim();
    const category = (form.get("category") as string || "other").trim();
    const file = form.get("file") as File | null;

    if (!title || title.length > 60) return jsonResponse({ error: "标题必填且不超过 60 字符" }, 400);
    if (description.length > 1000) return jsonResponse({ error: "描述不超过 1000 字符" }, 400);
    if (!ALLOWED_CATEGORIES.has(category)) return jsonResponse({ error: "分类不合法" }, 400);
    if (!file) return jsonResponse({ error: "请选择文件" }, 400);
    if (file.size > MAX_FILE_SIZE) return jsonResponse({ error: "文件超过 1.5MB 限制" }, 413);
    if (file.size === 0) return jsonResponse({ error: "文件为空" }, 400);

    const lowerName = file.name.toLowerCase();
    if (!ALLOWED_EXT.some((ext) => lowerName.endsWith(ext))) {
      return jsonResponse({ error: "不支持的文件类型" }, 400);
    }

    // 上传到 Storage（路径：<userId>/<timestamp>_<fileName>）
    const ext = lowerName.slice(lowerName.lastIndexOf("."));
    const filePath = `${user.id}/${Date.now()}_${crypto.randomUUID()}${ext}`;
    const { error: upErr } = await supabase.storage
      .from("workshop")
      .upload(filePath, file, { contentType: file.type || "application/octet-stream" });
    if (upErr) throw upErr;

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
      })
      .select("id, title, description, category, file_name, file_size, download_count, created_at")
      .single();
    if (error) throw error;

    return jsonResponse({ item: data }, 201);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
