// 站内信 - 发送邮件通知（供 create-notification 调用）
// POST body: { to, type, title, content, from_username }
import { jsonResponse, handleOptions } from "../_shared/cors.ts";

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
    const typeLabel = type === "reply" ? "回复" : type === "mention" ? "@提及" : "通知";
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

    // 使用 Resend 发送邮件（免费额度 100 封/天）
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.log("RESEND_API_KEY 未配置，跳过邮件发送");
      return jsonResponse({ success: true, skipped: true, reason: "no_api_key" });
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: "K6Web <notifications@jkhgnl.top>",
        to: [to],
        subject,
        html: htmlContent,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("邮件发送失败:", err);
      return jsonResponse({ success: false, error: err }, 500);
    }

    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message || "Internal Error" }, 500);
  }
});

function escapeHtml(s: string): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
