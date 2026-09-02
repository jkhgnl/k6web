// 站内信 - 发送邮件通知（SMTP 直连）
// POST body: { to, type, title, content, from_username }
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

// SMTP 配置（阿里云企业邮箱）
const SMTP_HOST = "smtp.qiye.aliyun.com";
const SMTP_PORT = 465;
const SMTP_USER = "noreply@jkhgnl.top";
const SMTP_PASS = "6429891nihqO!";
const SMTP_FROM = "K6Web <noreply@jkhgnl.top>";

// 简易 SMTP over TLS 实现
async function sendSmtp(to: string, subject: string, htmlBody: string): Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // TLS 连接（端口 465 直连 TLS）
  const conn = await Deno.connectTls({ hostname: SMTP_HOST, port: SMTP_PORT });

  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();

  async function send(line: string): Promise<string> {
    await writer.write(encoder.encode(line + "\r\n"));
    const result = await reader.read();
    return decoder.decode(result.value);
  }

  async function readBanner(): Promise<string> {
    const result = await reader.read();
    return decoder.decode(result.value);
  }

  // 读取服务器 banner
  await readBanner();

  // EHLO
  let r = await send("EHLO jkhgnl.top");
  console.log("EHLO:", r);

  // AUTH LOGIN
  r = await send("AUTH LOGIN");
  console.log("AUTH:", r);

  // 用户名（base64）
  r = await send(btoa(SMTP_USER));
  console.log("USER:", r);

  // 密码（base64）
  r = await send(btoa(SMTP_PASS));
  console.log("PASS:", r);

  // MAIL FROM
  r = await send(`MAIL FROM:<${SMTP_USER}>`);
  console.log("MAIL FROM:", r);

  // RCPT TO
  r = await send(`RCPT TO:<${to}>`);
  console.log("RCPT TO:", r);

  // DATA
  r = await send("DATA");
  console.log("DATA:", r);

  // 邮件内容
  const rawEmail = [
    `From: ${SMTP_FROM}`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${btoa(encodeURIComponent(subject).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))))}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    btoa(unescape(encodeURIComponent(htmlBody))),
    ".",
  ].join("\r\n");

  r = await send(rawEmail);
  console.log("DATA END:", r);

  // QUIT
  await send("QUIT");

  conn.close();
}

function escapeHtml(s: string): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const body = await req.json();
    const { to, type, title, content, from_username } = body;

    if (!to || !title) {
      return jsonResponse({ error: "缺少必要参数" }, 400);
    }

    // 构建邮件内容
    const subject = `[K6Web] ${from_username || "用户"}${title}`;
    const htmlContent = `
      <div style="font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #2f6fdc, #5b8def); border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
          <h1 style="color: #fff; margin: 0; font-size: 20px;">🛰️ K6Web 站内信通知</h1>
        </div>
        <div style="background: #f8f9fb; border-radius: 10px; padding: 16px; margin-bottom: 16px;">
          <p style="margin: 0 0 8px; font-size: 14px; color: #333;">
            <strong>${escapeHtml(from_username || "用户")}</strong> ${escapeHtml(title)}
          </p>
          ${content ? `<p style="margin: 0; font-size: 13px; color: #666; background: #fff; padding: 10px; border-radius: 6px; border-left: 3px solid #2f6fdc;">${escapeHtml(content)}</p>` : ""}
        </div>
        <p style="font-size: 12px; color: #999; text-align: center;">
          登录 <a href="https://jkhgnl.top" style="color: #2f6fdc;">jkhgnl.top</a> 查看完整通知
        </p>
      </div>
    `;

    // 通过 SMTP 发送邮件
    await sendSmtp(to, subject, htmlContent);

    return jsonResponse({ success: true });
  } catch (e) {
    console.error("邮件发送失败:", e);
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});
