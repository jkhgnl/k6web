// 创意工坊 - 作品详情 + 下载地址（公开）
// GET ?id=<uuid>[&include_file=1]
// 下载地址：R2 已启用时返回永久公开 URL；否则回退 Supabase 临时签名 URL
// include_file=1 时额外在服务端拉取文件内容转 base64（供"应用此图片"等场景，
// 避免浏览器对对象存储的 CORS 限制）；仅对开机图片等小文件启用。
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, handleOptions } from "../_shared/cors.ts";
import { r2Enabled, r2PublicUrl } from "../_shared/r2.ts";

const MAX_INLINE = 5 * 1024 * 1024; // 内联返回上限 5MB

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const includeFile = url.searchParams.get("include_file") === "1";
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

    let fileB64: string | null = null;
    if (includeFile && downloadUrl) {
      if (data.file_size > MAX_INLINE) {
        return jsonResponse({ item: data, download_url: downloadUrl, file_b64: null, error: "文件过大，无法内联" }, 200);
      }
      const resp = await fetch(downloadUrl);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        fileB64 = bytesToBase64(new Uint8Array(buf));
      }
    }

    return jsonResponse({ item: data, download_url: downloadUrl, file_b64: fileB64 });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});
