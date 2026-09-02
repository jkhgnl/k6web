// 创意工坊 - 作品详情 + 临时下载地址（公开）
// GET ?id=<uuid>
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "缺少 id 参数" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SECRET_KEY")!,
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
