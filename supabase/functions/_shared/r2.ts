// 共享 R2 工具：S3 兼容上传/删除 + 公开 URL 生成
// 环境变量：
//   R2_ACCOUNT_ID   Cloudflare 账号 ID（用于拼接 S3 endpoint）
//   R2_ACCESS_KEY   R2 API Token 的 Access Key ID
//   R2_SECRET_KEY   R2 API Token 的 Secret Access Key
//   R2_BUCKET       桶名（如 k6web-workshop）
//   R2_PUBLIC_URL   公开访问基址（如 https://workshop.jkhgnl.top）
// 不提供 R2_ACCESS_KEY / R2_SECRET_KEY 时回退到 Supabase Storage（迁移过渡期双写兼容）

import { jsonResponse } from "./cors.ts";

export function r2Config() {
  return {
    accountId: Deno.env.get("R2_ACCOUNT_ID") || "",
    accessKey: Deno.env.get("R2_ACCESS_KEY") || "",
    secretKey: Deno.env.get("R2_SECRET_KEY") || "",
    bucket: Deno.env.get("R2_BUCKET") || "k6web-workshop",
    publicUrl: (Deno.env.get("R2_PUBLIC_URL") || "").replace(/\/+$/, ""),
  };
}

export function r2Enabled(): boolean {
  const c = r2Config();
  return !!(c.accountId && c.accessKey && c.secretKey && c.publicUrl);
}

// 对象公开访问 URL（方案 A：公开桶 + 自定义域名）
export function r2PublicUrl(key: string): string {
  const c = r2Config();
  return `${c.publicUrl}/${key.replace(/^\/+/, "")}`;
}

// ---- 最小 AWS SigV4 签名（S3 兼容，无需外部依赖）----
async function hmac(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, typeof data === "string" ? new TextEncoder().encode(data) : data);
  return new Uint8Array(sig);
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// S3 端点：https://{account_id}.r2.cloudflarestorage.com/{bucket}/{key}
function r2Endpoint(key: string): string {
  const c = r2Config();
  return `https://${c.accountId}.r2.cloudflarestorage.com/${c.bucket}/${encodeKey(key)}`;
}

function encodeKey(key: string): string {
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

async function signedHeaders(
  method: string,
  key: string,
  body: ArrayBuffer | null,
  extraHeaders: Record<string, string>,
): Promise<Record<string, string>> {
  const c = r2Config();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";

  const host = `${c.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${c.bucket}/${key.split("/").map((seg) => encodeURIComponent(seg)).join("/")}`;
  const payloadHash = body ? await sha256Hex(new Uint8Array(body)) : await sha256Hex("");

  const hNames = ["host", "x-amz-content-sha256", "x-amz-date"];
  const hVals: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const hKeys = Object.keys(hVals).sort();
  const canonicalHeaders = hKeys.map((k) => `${k}:${hVals[k]}\n`).join("");
  const signedHeaderList = hKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(new TextEncoder().encode("AWS4" + c.secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    "Authorization": `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
}

// 上传对象（返回 public URL）；失败抛异常
export async function r2PutObject(
  key: string,
  data: Uint8Array,
  contentType: string,
): Promise<string> {
  if (!r2Enabled()) throw new Error("R2 未配置（缺少 R2_ACCESS_KEY / R2_SECRET_KEY）");
  const headers = await signedHeaders("PUT", key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
    "content-type": contentType,
  });
  const resp = await fetch(r2Endpoint(key), { method: "PUT", headers, body: data });
  if (!resp.ok) {
    throw new Error(`R2 上传失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return r2PublicUrl(key);
}

// 删除对象
export async function r2DeleteObject(key: string): Promise<void> {
  if (!r2Enabled()) return;
  const headers = await signedHeaders("DELETE", key, null, {});
  const resp = await fetch(r2Endpoint(key), { method: "DELETE", headers });
  // 404 = 对象本就不存在，忽略
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`R2 删除失败 HTTP ${resp.status}`);
  }
}

// 从 thumbnail_url / download_url 中解析对象 key（公开 URL 形如 https://workshop.jkhgnl.top/{key}）
export function r2KeyFromUrl(url: string): string | null {
  if (!url) return null;
  const c = r2Config();
  const prefix = c.publicUrl ? `${c.publicUrl}/` : "";
  if (prefix && url.startsWith(prefix)) return decodeURIComponent(url.slice(prefix.length));
  // 兼容旧 Supabase 签名 URL：/storage/v1/object/sign/workshop/{key}?token=...
  const m = url.match(/\/storage\/v1\/object\/sign\/workshop\/([^?]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

export { jsonResponse };
