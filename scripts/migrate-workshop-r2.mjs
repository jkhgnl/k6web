#!/usr/bin/env node
/**
 * 创意工坊存量数据迁移脚本：Supabase Storage → Cloudflare R2
 *
 * 用途：把 workshop_items 表里已有的文件（主文件 + 缩略图）搬运到 R2 桶，
 *       并把 thumbnail_url 更新为 R2 公开 URL（方案 A）。
 *
 * 前置条件：
 *   1. R2 桶已创建并绑定自定义域名（workshop.jkhgnl.top）
 *   2. 已生成 R2 API Token（Object Read & Write）
 *   3. 已部署新版 upload/get/update/delete-workshop 函数（R2 优先）
 *
 * 环境变量：
 *   SUPABASE_URL            如 https://cvlrmxqaidnyvsexyesf.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY 页面里的 anon/publishable key
 *   SUPABASE_PERSONAL_TOKEN  sbp_ 开头的个人访问令牌（用于 SQL 更新 thumbnail_url）
 *   R2_ACCOUNT_ID            14a86e1ce4d1aa9b673f18b184c24ff1
 *   R2_ACCESS_KEY            R2 API Token Access Key ID
 *   R2_SECRET_KEY            R2 API Token Secret
 *   R2_BUCKET                k6web-workshop
 *   R2_PUBLIC_URL            https://workshop.jkhgnl.top
 *
 * 用法：
 *   SUPABASE_URL=... ... node scripts/migrate-workshop-r2.mjs
 */
import { createHmac, createHash } from "node:crypto";

// ---------- 配置 ----------
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SB_TOKEN = process.env.SUPABASE_PERSONAL_TOKEN || "";
const R2 = {
  accountId: process.env.R2_ACCOUNT_ID || "",
  accessKey: process.env.R2_ACCESS_KEY || "",
  secretKey: process.env.R2_SECRET_KEY || "",
  bucket: process.env.R2_BUCKET || "k6web-workshop",
  publicUrl: (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, ""),
};
const REF = (SB_URL.match(/https:\/\/([^.]+)\.supabase\.co/) || [])[1];

const missing = [];
if (!SB_URL) missing.push("SUPABASE_URL");
if (!SB_KEY) missing.push("SUPABASE_PUBLISHABLE_KEY");
if (!SB_TOKEN) missing.push("SUPABASE_PERSONAL_TOKEN");
if (!R2.accountId) missing.push("R2_ACCOUNT_ID");
if (!R2.accessKey) missing.push("R2_ACCESS_KEY");
if (!R2.secretKey) missing.push("R2_SECRET_KEY");
if (!R2.publicUrl) missing.push("R2_PUBLIC_URL");
if (missing.length) {
  console.error("缺少环境变量:", missing.join(", "));
  process.exit(1);
}

// ---------- AWS SigV4 签名（S3 兼容）----------
function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function encodeKey(key) {
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}
async function signedFetch(method, key, body = null, contentType = "") {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const host = `${R2.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${R2.bucket}/${key.split("/").map((seg) => encodeURIComponent(seg)).join("/")}`;
  const payloadHash = body ? sha256Hex(body) : sha256Hex("");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  const hKeys = Object.keys(headers).sort();
  const canonicalHeaders = hKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaderList = hKeys.join(";");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaderList, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + R2.secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = kSigning.length ? Buffer.from(hmac(kSigning, stringToSign)).toString("hex") : "";
  const auth = `AWS4-HMAC-SHA256 Credential=${R2.accessKey}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`;
  const resp = await fetch(`https://${host}/${R2.bucket}/${encodeKey(key)}`, {
    method,
    headers: { ...headers, Authorization: auth },
    body: body || undefined,
  });
  return resp;
}

// ---------- Supabase 辅助 ----------
async function listItems() {
  // 分页拉全量（每页 1000）
  const items = [];
  let page = 1;
  for (;;) {
    const resp = await fetch(`${SB_URL}/functions/v1/list-workshop?page=${page}&page_size=1000`, {
      headers: { Authorization: "Bearer " + SB_KEY, apikey: SB_KEY },
    });
    const data = await resp.json();
    const rows = data.items || [];
    items.push(...rows);
    if (rows.length < 1000) break;
    page++;
  }
  return items;
}

async function getItem(id) {
  const resp = await fetch(`${SB_URL}/functions/v1/get-workshop-item?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: "Bearer " + SB_KEY, apikey: SB_KEY },
  });
  const data = await resp.json();
  if (!data.item) throw new Error(`作品 ${id} 不存在: ${data.error}`);
  return data;
}

async function updateThumbnailUrl(id, url) {
  // 通过 Management API 执行 SQL（绕过 RLS）
  const resp = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + SB_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `update public.workshop_items set thumbnail_url = $1 where id = $2`,
      parameters: [url, id],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`更新 thumbnail_url 失败 HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
}

// ---------- 迁移 ----------
function parseKeyFromUrl(url) {
  if (!url) return null;
  const prefix = `${R2.publicUrl}/`;
  if (url.startsWith(prefix)) return decodeURIComponent(url.slice(prefix.length));
  const m = url.match(/\/storage\/v1\/object\/sign\/workshop\/([^?]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

async function downloadBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url.slice(0, 120)}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function main() {
  console.log("🔍 拉取作品列表...");
  const items = await listItems();
  console.log(`共 ${items.length} 个作品\n`);

  let ok = 0, fail = 0, skip = 0;
  for (const it of items) {
    try {
      const detail = await getItem(it.id);
      const item = detail.item;
      const filePath = item.file_path;
      if (!filePath) { skip++; continue; }

      // 1. 主文件：从 Supabase 下载（download_url 为签名 URL）→ 上传 R2 同 key
      const dlUrl = detail.download_url;
      if (dlUrl) {
        const buf = await downloadBuffer(dlUrl);
        const put = await signedFetch("PUT", filePath, buf, "application/octet-stream");
        if (!put.ok) throw new Error(`R2 主文件上传 HTTP ${put.status}: ${(await put.text()).slice(0, 120)}`);
        console.log(`✅ 主文件 ${filePath}`);
      }

      // 2. 缩略图：下载 → 上传 R2 → 更新 thumbnail_url
      const oldThumb = item.thumbnail_url;
      const thumbKey = oldThumb ? parseKeyFromUrl(oldThumb) : null;
      if (thumbKey && oldThumb) {
        const buf = await downloadBuffer(oldThumb);
        const put = await signedFetch("PUT", thumbKey, buf, "image/jpeg");
        if (!put.ok) throw new Error(`R2 缩略图上传 HTTP ${put.status}`);
        const newUrl = `${R2.publicUrl}/${thumbKey.split("/").map(encodeURIComponent).join("/")}`;
        await updateThumbnailUrl(item.id, newUrl);
        console.log(`✅ 缩略图 ${thumbKey} → ${newUrl}`);
      }
      ok++;
    } catch (e) {
      fail++;
      console.error(`❌ ${it.id} ${it.title}: ${e.message}`);
    }
  }

  console.log(`\n迁移完成：成功 ${ok}，失败 ${fail}，跳过 ${skip}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
