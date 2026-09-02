/**
 * K6Web 站内信通知模块
 * 依赖：window.K5AUTH（auth.js）
 *       window.SUPABASE_URL（index.html 配置）
 * 暴露：window.K5NOTIFY
 */
(function () {
  "use strict";

  const FUNC_BASE = (window.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1";
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function anonHeaders() {
    const h = { Authorization: "Bearer " + (window.SUPABASE_PUBLISHABLE_KEY || "") };
    if (window.SUPABASE_PUBLISHABLE_KEY) h.apikey = window.SUPABASE_PUBLISHABLE_KEY;
    return h;
  }

  function authHeaders(token) {
    return {
      Authorization: "Bearer " + token,
      apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
      "Content-Type": "application/json",
    };
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 2592000000) return Math.floor(diff / 86400000) + " 天前";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const TYPE_ICON = { reply: "💬", mention: "📢", system: "🔔" };

  // ---------- 获取未读数 ----------
  async function fetchUnreadCount() {
    if (!window.K5AUTH.isLoggedIn()) return 0;
    const token = await window.K5AUTH.getToken();
    if (!token) return 0;
    try {
      const resp = await fetch(`${FUNC_BASE}/list-notifications?page_size=1`, {
        headers: authHeaders(token),
      });
      if (!resp.ok) return 0;
      const data = await resp.json();
      return data.unread_count || 0;
    } catch (e) {
      return 0;
    }
  }

  // ---------- 更新铃铛 badge ----------
  async function refreshBadge() {
    const count = await fetchUnreadCount();
    const badge = $("notifyBadge");
    if (badge) {
      badge.textContent = count > 99 ? "99+" : (count || "");
      badge.style.display = count > 0 ? "flex" : "none";
    }
  }

  // ---------- 获取通知列表 ----------
  async function fetchNotifications(page = 1, unreadOnly = false) {
    if (!window.K5AUTH.isLoggedIn()) return { notifications: [], unread_count: 0, total: 0 };
    const token = await window.K5AUTH.getToken();
    if (!token) return { notifications: [], unread_count: 0, total: 0 };
    try {
      const params = new URLSearchParams({ page: String(page), page_size: "20" });
      if (unreadOnly) params.set("unread_only", "true");
      const resp = await fetch(`${FUNC_BASE}/list-notifications?${params}`, {
        headers: authHeaders(token),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } catch (e) {
      return { notifications: [], unread_count: 0, total: 0 };
    }
  }

  // ---------- 标记已读 ----------
  async function markRead(notificationId) {
    const token = await window.K5AUTH.getToken();
    if (!token) return;
    await fetch(`${FUNC_BASE}/mark-read`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ notification_id: notificationId }),
    });
    refreshBadge();
  }

  // ---------- 标记全部已读 ----------
  async function markAllRead() {
    const token = await window.K5AUTH.getToken();
    if (!token) return;
    await fetch(`${FUNC_BASE}/mark-all-read`, {
      method: "POST",
      headers: authHeaders(token),
      body: "{}",
    });
    refreshBadge();
  }

  // ---------- 渲染通知列表 ----------
  function renderList(notifications) {
    const list = $("notifyList");
    if (!list) return;
    if (!notifications || notifications.length === 0) {
      list.innerHTML = `<div class="notify-empty">暂无通知 🔔</div>`;
      return;
    }
    list.innerHTML = notifications.map((n) => {
      const icon = TYPE_ICON[n.type] || "🔔";
      const readClass = n.is_read ? "" : " unread";
      const fromText = n.from_username ? `<span class="notify-from">${escapeHtml(n.from_username)}</span>` : "";
      return `
        <div class="notify-item${readClass}" data-id="${n.id}" data-type="${n.type}">
          <span class="notify-icon">${icon}</span>
          <div class="notify-body">
            <div class="notify-title">${escapeHtml(n.title)} ${fromText}</div>
            ${n.content ? `<div class="notify-content">${escapeHtml(n.content)}</div>` : ""}
            <div class="notify-time">${fmtTime(n.created_at)}</div>
          </div>
        </div>`;
    }).join("");
  }

  // ---------- 打开通知面板 ----------
  let panelOpen = false;
  let currentFilter = "all";

  async function openPanel() {
    const panel = $("notifyPanel");
    if (!panel) return;
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? "block" : "none";
    if (panelOpen) {
      await loadPanel();
    }
  }

  async function loadPanel() {
    const unreadOnly = currentFilter === "unread";
    const data = await fetchNotifications(1, unreadOnly);
    renderList(data.notifications);

    const countEl = $("notifyCount");
    if (countEl) countEl.textContent = data.unread_count > 0 ? `(${data.unread_count} 条未读)` : "";

    // 绑定点击事件
    const list = $("notifyList");
    if (list) {
      list.querySelectorAll(".notify-item").forEach((el) => {
        el.addEventListener("click", async () => {
          const id = el.dataset.id;
          const type = el.dataset.type;
          el.classList.remove("unread");
          await markRead(id);
        });
      });
    }
  }

  function closePanel() {
    const panel = $("notifyPanel");
    if (panel) panel.style.display = "none";
    panelOpen = false;
  }

  // ---------- 初始化 ----------
  function init() {
    // 通知按钮点击
    const bell = $("notifyBell");
    if (bell) {
      bell.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!window.K5AUTH.isLoggedIn()) {
          window.K5AUTH.openModal();
          return;
        }
        openPanel();
      });
    }

    // 筛选按钮
    $("notifyFilterAll")?.addEventListener("click", () => {
      currentFilter = "all";
      $("notifyFilterAll").classList.add("active");
      $("notifyFilterUnread")?.classList.remove("active");
      loadPanel();
    });
    $("notifyFilterUnread")?.addEventListener("click", () => {
      currentFilter = "unread";
      $("notifyFilterUnread").classList.add("active");
      $("notifyFilterAll")?.classList.remove("active");
      loadPanel();
    });

    // 全部已读
    $("notifyMarkAll")?.addEventListener("click", async () => {
      await markAllRead();
      loadPanel();
    });

    // 点击外部关闭
    document.addEventListener("click", (e) => {
      const panel = $("notifyPanel");
      const bell = $("notifyBell");
      if (panel && panelOpen && !panel.contains(e.target) && !bell?.contains(e.target)) {
        closePanel();
      }
    });

    // 登录状态变化时刷新 badge
    window.K5AUTH.onAuth(() => {
      if (window.K5AUTH.isLoggedIn()) {
        refreshBadge();
      } else {
        const badge = $("notifyBadge");
        if (badge) badge.style.display = "none";
      }
    });

    // 初始加载
    if (window.K5AUTH.isLoggedIn()) refreshBadge();

    // 定时刷新未读数（每 60 秒）
    setInterval(() => {
      if (window.K5AUTH.isLoggedIn()) refreshBadge();
    }, 60000);
  }

  window.K5NOTIFY = { init, refreshBadge, openPanel, closePanel };
})();
