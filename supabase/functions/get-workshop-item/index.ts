// 创意工坊 - 作品详情 + 下载地址（公开）
// GET ?id=<uuid>
// 下载地址：R2 已启用时返回永久公开 URL；否则回退 Supabase 临时签名 URL
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";
import { r2Enabled, r2PublicUrl } from "../_shared/r2.ts";

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

    let downloadUrl: string | null = null;
    if (r2Enabled()) {
      downloadUrl = r2PublicUrl(data.file_path);
    } else {
      const { data: signed } = await supabase
        .storage
        .from("workshop")
        .createSignedUrl(data.file_path, 3600);
      downloadUrl = signed?.signedUrl || null;
    }

    return jsonResponse({ item: data, download_url: downloadUrl });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
