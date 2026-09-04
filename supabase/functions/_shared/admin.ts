// 共享管理员判定（Jkhgnl）
// 邮箱或用户名/昵称匹配即视为管理员
export function isAdminUser(user: { email?: string; user_metadata?: Record<string, unknown> } | null): boolean {
  if (!user) return false;
  const email = (user.email || "").toLowerCase().trim();
  if (email === "jkhgnl@outlook.com" || email === "jkhgnl@outlook") return true;
  const meta = user.user_metadata || {};
  const candidates = [meta["user_name"], meta["name"], meta["full_name"], meta["preferred_username"]];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim().toLowerCase() === "jkhgnl") return true;
  }
  return false;
}
