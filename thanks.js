/**
 * K6Web 鸣谢榜 - 请他喝咖啡弹窗内的感谢名单
 * 依赖：window.K5AUTH（auth.js）
 *       window.SUPABASE_URL（index.html 配置）
 * 暴露：window.K5THANKS
 */
(function () {
  "use strict";

  const FUNC_BASE = (window.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1";
  const $ = (id) => document.getElementById(id);

  let items = [];          // 当前鸣谢列表
  let editingId = null;    // null = 新增；非空 = 编辑该记录 id

  function anonHeaders() {
    const h = { Authorization: "Bearer " + (window.SUPABASE_PUBLISHABLE_KEY || "") };
    if (window.SUPABASE_PUBLISHABLE_KEY) h.apikey = window.SUPABASE_PUBLISHABLE_KEY;
    return h;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 管理员判定（与 manage-thanks Edge Function 保持一致）
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

  function fmtAmount(amount) {
    if (amount == null || amount === "") return "";
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return "";
    return " · 💰 " + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)) + " 元";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ---------- 列表 ----------
  async function loadThanks() {
    const listEl = $("coffeeThanksList");
    if (!listEl) return;
    listEl.innerHTML = `<div class="coffee-thanks-loading">加载中…</div>`;
    try {
      const resp = await fetch(`${FUNC_BASE}/list-thanks`, { headers: anonHeaders() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      items = data.items || [];
      renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="coffee-thanks-empty">鸣谢榜加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  function renderList() {
    const listEl = $("coffeeThanksList");
    const admin = isAdmin(window.K5AUTH.getUser());
    if (!listEl) return;

    if (!items.length) {
      listEl.innerHTML = `<div class="coffee-thanks-empty">还没有鸣谢记录，期待你的名字出现在这里 ☕</div>`;
      return;
    }

    listEl.innerHTML = items.map((it) => {
      const callsignHtml = it.callsign
        ? `<span class="coffee-callsign">${escapeHtml(it.callsign)}</span>`
        : "";
      const msgHtml = it.message
        ? `<div class="coffee-thanks-msg">${escapeHtml(it.message)}</div>`
        : "";
      const metaHtml = `<div class="coffee-thanks-meta">${fmtDate(it.created_at)}${fmtAmount(it.amount)}</div>`;
      const actionsHtml = admin
        ? `<div class="coffee-thanks-actions">
             <button type="button" class="edit" data-id="${it.id}" title="编辑">✏️</button>
             <button type="button" class="danger" data-id="${it.id}" title="删除">🗑️</button>
           </div>`
        : "";
      return `
        <div class="coffee-thanks-item" data-id="${it.id}">
          <span class="coffee-thanks-avatar">☕</span>
          <div class="coffee-thanks-main">
            <div class="coffee-thanks-name">${escapeHtml(it.name)}${callsignHtml}</div>
            ${msgHtml}${metaHtml}
          </div>
          ${actionsHtml}
        </div>`;
    }).join("");

    // 管理员操作绑定
    if (admin) {
      listEl.querySelectorAll(".coffee-thanks-actions .edit").forEach((b) => {
        b.addEventListener("click", () => openForm(items.find((x) => x.id === b.dataset.id)));
      });
      listEl.querySelectorAll(".coffee-thanks-actions .danger").forEach((b) => {
        b.addEventListener("click", () => deleteThanks(b.dataset.id));
      });
    }
  }

  // ---------- 管理员 UI ----------
  function renderAdminUI() {
    const admin = isAdmin(window.K5AUTH.getUser());
    const addBtn = $("coffeeThanksAdd");
    const hint = $("coffeeThanksAdminHint");
    if (addBtn) addBtn.style.display = admin ? "" : "none";
    if (hint) hint.style.display = admin ? "" : "none";
    // 非管理员时隐藏编辑表单
    if (!admin) hideForm();
    if (items.length || document.querySelectorAll("#coffeeThanksList .coffee-thanks-empty").length) renderList();
  }

  // ---------- 新增 / 编辑表单 ----------
  function openForm(item) {
    editingId = item ? item.id : null;
    const form = $("coffeeThanksForm");
    if (!form) return;
    $("coffeeThanksFormTitle").textContent = editingId ? "编辑鸣谢" : "新增鸣谢";
    $("thName").value = item ? (item.name || "") : "";
    $("thCallsign").value = item ? (item.callsign || "") : "";
    $("thAmount").value = item && item.amount != null ? item.amount : "";
    $("thMessage").value = item ? (item.message || "") : "";
    setFormStatus("", "");
    form.style.display = "flex";
  }

  function hideForm() {
    const form = $("coffeeThanksForm");
    if (form) form.style.display = "none";
    editingId = null;
  }

  function setFormStatus(msg, cls) {
    const el = $("coffeeThanksFormStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "coffee-thanks-form-status" + (cls ? " " + cls : "");
  }

  // ---------- 保存（新增 POST / 编辑 PUT） ----------
  async function saveThanks() {
    const name = ($("thName").value || "").trim();
    const callsign = ($("thCallsign").value || "").trim();
    const amountRaw = ($("thAmount").value || "").trim();
    const message = ($("thMessage").value || "").trim();

    if (!name) { setFormStatus("请填写姓名或昵称", "err"); return; }
    if (callsign && !/^[A-Za-z0-9\-/]{2,12}$/.test(callsign)) {
      setFormStatus("呼号格式不正确（2-12 位字母/数字/-//）", "err");
      return;
    }
    let amount = null;
    if (amountRaw !== "") {
      const n = Number(amountRaw);
      if (!Number.isFinite(n) || n < 0) { setFormStatus("金额不合法", "err"); return; }
      amount = n;
    }
    if (message.length > 200) { setFormStatus("留言不超过 200 字符", "err"); return; }

    const token = await window.K5AUTH.getToken();
    if (!token) { setFormStatus("登录状态已失效，请重新登录", "err"); window.K5AUTH.openModal(); return; }

    const btn = $("coffeeThanksFormSave");
    const oldText = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
    try {
      const url = editingId
        ? `${FUNC_BASE}/manage-thanks?id=${encodeURIComponent(editingId)}`
        : `${FUNC_BASE}/manage-thanks`;
      const resp = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
        },
        body: JSON.stringify({ name, callsign, amount, message }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);

      setFormStatus(editingId ? "✅ 已保存" : "✅ 已添加", "ok");
      hideForm();
      await loadThanks();
    } catch (e) {
      setFormStatus("保存失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  // ---------- 删除 ----------
  async function deleteThanks(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`确定删除 ${it.name || "该记录"} 的鸣谢吗？删除后不可恢复。`)) return;

    const token = await window.K5AUTH.getToken();
    if (!token) { alert("登录状态已失效，请重新登录"); window.K5AUTH.openModal(); return; }

    try {
      const resp = await fetch(`${FUNC_BASE}/manage-thanks?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + token,
          apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
        },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
      await loadThanks();
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  }

  // ---------- 初始化 ----------
  function init() {
    const addBtn = $("coffeeThanksAdd");
    const cancelBtn = $("coffeeThanksFormCancel");
    const saveBtn = $("coffeeThanksFormSave");

    if (addBtn) addBtn.addEventListener("click", () => openForm(null));
    if (cancelBtn) cancelBtn.addEventListener("click", hideForm);
    if (saveBtn) saveBtn.addEventListener("click", saveThanks);

    // 打开弹窗时刷新榜单
    const coffeeBtn = $("coffeeBtn");
    if (coffeeBtn) coffeeBtn.addEventListener("click", () => { renderAdminUI(); loadThanks(); });

    // 登录状态变化时刷新管理员 UI
    if (window.K5AUTH) window.K5AUTH.onAuth(() => renderAdminUI());

    // 首次加载
    loadThanks();
  }

  window.K5THANKS = { init, loadThanks, isAdmin };
})();
