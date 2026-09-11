/**
 * K6Web 友情链接 - 侧边栏「友链」选项卡
 * 依赖：window.K5AUTH（auth.js）
 *       window.SUPABASE_URL（index.html 配置）
 * 暴露：window.K5FRIENDS
 */
(function () {
  "use strict";

  const FUNC_BASE = (window.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1";
  const $ = (id) => document.getElementById(id);

  let items = [];          // 当前友链列表
  let editingId = null;    // null = 新增；非空 = 编辑该记录 id
  let inited = false;

  function anonHeaders() {
    const h = { Authorization: "Bearer " + (window.SUPABASE_PUBLISHABLE_KEY || "") };
    if (window.SUPABASE_PUBLISHABLE_KEY) h.apikey = window.SUPABASE_PUBLISHABLE_KEY;
    return h;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 管理员判定（与 manage-friend-links Edge Function 保持一致）
  function isAdmin(user) {
    if (!user) return false;
    const email = (user.email || "").toLowerCase().trim();
    if (email === "jkhgnl@outlook.com" || email === "jkhgnl@outlook") return true;
    const meta = user.user_metadata || {};
    for (const k of ["user_name", "name", "full_name", "preferred_username"]) {
      if (typeof meta[k] === "string" && meta[k].trim().toLowerCase() === "jkhgnl") return true;
    }
    return false;
  }

  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; }
  }

  // ---------- 列表 ----------
  async function loadFriends() {
    const listEl = $("friendLinksList");
    if (!listEl) return;
    listEl.innerHTML = `<div class="flink-loading">加载中…</div>`;
    try {
      const resp = await fetch(`${FUNC_BASE}/list-friend-links?page_size=100`, { headers: anonHeaders() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      items = data.items || [];
      renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="flink-empty">友链加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  function renderList() {
    const listEl = $("friendLinksList");
    const admin = isAdmin(window.K5AUTH && window.K5AUTH.getUser());
    if (!listEl) return;

    if (!items.length) {
      listEl.innerHTML = `<div class="flink-empty">还没有友情链接，欢迎联系作者交换友链 🔗</div>`;
      return;
    }

    listEl.innerHTML = items.map((it) => {
      const url = escapeHtml(it.site_url);
      const initial = (it.name || "?").trim().charAt(0).toUpperCase();
      const avatarHtml = it.avatar_url
        ? `<img src="${escapeHtml(it.avatar_url)}" alt="${escapeHtml(it.name)}" loading="lazy">`
        : "";
      const descHtml = it.description
        ? `<div class="flink-desc">${escapeHtml(it.description)}</div>`
        : "";
      const actionsHtml = admin
        ? `<div class="flink-actions">
             <button type="button" class="edit" data-id="${it.id}" title="编辑">✏️</button>
             <button type="button" class="danger" data-id="${it.id}" title="删除">🗑️</button>
           </div>`
        : "";
      return `
        <div class="flink-card" data-id="${it.id}">
          <a class="flink-avatar" href="${url}" target="_blank" rel="noopener noreferrer">
            ${avatarHtml}
            <span class="flink-avatar-fallback"${avatarHtml ? ' style="display:none"' : ""}>${escapeHtml(initial)}</span>
          </a>
          <div class="flink-body">
            <a class="flink-name" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.name)}</a>
            <div class="flink-host">${escapeHtml(hostOf(it.site_url))}</div>
            ${descHtml}
          </div>
          ${actionsHtml}
        </div>`;
    }).join("");

    // 头像加载失败时回退到首字母
    listEl.querySelectorAll(".flink-avatar img").forEach((img) => {
      img.addEventListener("error", () => {
        img.style.display = "none";
        const fb = img.parentElement.querySelector(".flink-avatar-fallback");
        if (fb) fb.style.display = "flex";
      });
    });

    // 管理员操作绑定
    if (admin) {
      listEl.querySelectorAll(".flink-actions .edit").forEach((b) => {
        b.addEventListener("click", () => openForm(items.find((x) => x.id === b.dataset.id)));
      });
      listEl.querySelectorAll(".flink-actions .danger").forEach((b) => {
        b.addEventListener("click", () => deleteFriend(b.dataset.id));
      });
    }
  }

  // ---------- 管理员 UI ----------
  function renderAdminUI() {
    const admin = isAdmin(window.K5AUTH && window.K5AUTH.getUser());
    const addBtn = $("friendLinksAdd");
    const hint = $("friendLinksAdminHint");
    if (addBtn) addBtn.style.display = admin ? "" : "none";
    if (hint) hint.style.display = admin ? "" : "none";
    if (!admin) hideForm();
    if (items.length || document.querySelector("#friendLinksList .flink-empty")) renderList();
  }

  // ---------- 新增 / 编辑表单 ----------
  function openForm(item) {
    editingId = item ? item.id : null;
    const form = $("friendLinksForm");
    if (!form) return;
    $("friendLinksFormTitle").textContent = editingId ? "编辑友链" : "新增友链";
    $("flName").value = item ? (item.name || "") : "";
    $("flDesc").value = item ? (item.description || "") : "";
    $("flAvatar").value = item ? (item.avatar_url || "") : "";
    $("flSite").value = item ? (item.site_url || "") : "";
    setFormStatus("", "");
    form.style.display = "flex";
  }

  function hideForm() {
    const form = $("friendLinksForm");
    if (form) form.style.display = "none";
    editingId = null;
  }

  function setFormStatus(msg, cls) {
    const el = $("friendLinksFormStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "flink-form-status" + (cls ? " " + cls : "");
  }

  function isHttpUrl(v) {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  // ---------- 保存（新增 POST / 编辑 PUT） ----------
  async function saveFriend() {
    const name = ($("flName").value || "").trim();
    const description = ($("flDesc").value || "").trim();
    const avatarUrl = ($("flAvatar").value || "").trim();
    const siteUrl = ($("flSite").value || "").trim();

    if (!name) { setFormStatus("请填写网站名称", "err"); return; }
    if (name.length > 60) { setFormStatus("网站名称不超过 60 字符", "err"); return; }
    if (description.length > 300) { setFormStatus("网站简介不超过 300 字符", "err"); return; }
    if (!siteUrl) { setFormStatus("请填写网站链接", "err"); return; }
    if (!isHttpUrl(siteUrl)) { setFormStatus("网站链接需以 http:// 或 https:// 开头", "err"); return; }
    if (avatarUrl && !isHttpUrl(avatarUrl)) {
      setFormStatus("头像链接需以 http:// 或 https:// 开头", "err");
      return;
    }

    const token = await window.K5AUTH.getToken();
    if (!token) { setFormStatus("登录状态已失效，请重新登录", "err"); window.K5AUTH.openModal(); return; }

    const btn = $("friendLinksFormSave");
    const oldText = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
    try {
      const url = editingId
        ? `${FUNC_BASE}/manage-friend-links?id=${encodeURIComponent(editingId)}`
        : `${FUNC_BASE}/manage-friend-links`;
      const resp = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
        },
        body: JSON.stringify({ name, description, avatar_url: avatarUrl, site_url: siteUrl }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);

      setFormStatus(editingId ? "✅ 已保存" : "✅ 已添加", "ok");
      hideForm();
      await loadFriends();
    } catch (e) {
      setFormStatus("保存失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  // ---------- 删除 ----------
  async function deleteFriend(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`确定删除友链「${it.name || "该网站"}」吗？删除后不可恢复。`)) return;

    const token = await window.K5AUTH.getToken();
    if (!token) { alert("登录状态已失效，请重新登录"); window.K5AUTH.openModal(); return; }

    try {
      const resp = await fetch(`${FUNC_BASE}/manage-friend-links?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + token,
          apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
        },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
      await loadFriends();
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  }

  // ---------- 初始化 ----------
  function init() {
    if (inited) return;
    inited = true;

    const addBtn = $("friendLinksAdd");
    const cancelBtn = $("friendLinksFormCancel");
    const saveBtn = $("friendLinksFormSave");

    if (addBtn) addBtn.addEventListener("click", () => openForm(null));
    if (cancelBtn) cancelBtn.addEventListener("click", hideForm);
    if (saveBtn) saveBtn.addEventListener("click", saveFriend);

    if (window.K5AUTH) window.K5AUTH.onAuth(() => renderAdminUI());

    loadFriends().then(renderAdminUI);
  }

  window.K5FRIENDS = { init, load: loadFriends, isAdmin };
})();
