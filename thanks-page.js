/**
 * K6Web 鸣谢页面 - "鸣谢"选项卡内的感谢名单（分组：首批内测用户 / 赞助支持用户）
 * 依赖：window.K5AUTH（auth.js）
 *       window.SUPABASE_URL（index.html 配置）
 * 暴露：window.K5THANKSPAGE
 */
(function () {
  "use strict";

  const FUNC_BASE = (window.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1";
  const $ = (id) => document.getElementById(id);

  let items = [];          // 全部鸣谢记录
  let editingId = null;    // null = 新增；非空 = 编辑该记录 id

  const CATEGORY_LABEL = { sponsor: "☕ 赞助支持用户", beta: "🚀 首批内测用户" };

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
  async function fetchAllItems() {
    const all = [];
    let page = 1;
    // 分页拉全量（单页上限 100）
    while (true) {
      const resp = await fetch(`${FUNC_BASE}/list-thanks?page=${page}&page_size=100`, { headers: anonHeaders() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const batch = data.items || [];
      all.push(...batch);
      if (all.length >= (data.total || 0) || batch.length < 100) break;
      page++;
    }
    return all;
  }

  async function loadThanks() {
    const betaEl = $("thxBetaList");
    const sponsorEl = $("thxSponsorList");
    if (!betaEl || !sponsorEl) return;
    const loading = `<div class="thx-loading">加载中…</div>`;
    betaEl.innerHTML = loading;
    sponsorEl.innerHTML = loading;
    try {
      items = await fetchAllItems();
      renderLists();
    } catch (e) {
      const errHtml = `<div class="thx-empty">鸣谢榜加载失败：${escapeHtml(e.message)}</div>`;
      betaEl.innerHTML = errHtml;
      sponsorEl.innerHTML = errHtml;
    }
  }

  function renderList(el, category) {
    const admin = isAdmin(window.K5AUTH.getUser());
    const list = items.filter((it) => (it.category || "sponsor") === category);

    if (!list.length) {
      el.innerHTML = `<div class="thx-empty">暂无${CATEGORY_LABEL[category].replace(/^\S+\s/, "")}记录${category === "beta" ? "，期待你的加入 🚀" : "，期待你的名字出现在这里 ☕"}</div>`;
      return;
    }

    el.innerHTML = list.map((it) => {
      // 姓名/呼号均可选（后端要求至少一项）：只填其一时不重复展示
      const displayName = it.name || it.callsign || "";
      const callsignHtml = it.name && it.callsign
        ? `<span class="thx-callsign">${escapeHtml(it.callsign)}</span>`
        : "";
      const msgHtml = it.message
        ? `<div class="thx-msg">${escapeHtml(it.message)}</div>`
        : "";
      // 内测用户不展示金额
      const metaHtml = category === "sponsor"
        ? `<div class="thx-meta">${fmtDate(it.created_at)}${fmtAmount(it.amount)}</div>`
        : `<div class="thx-meta">${fmtDate(it.created_at)}</div>`;
      const actionsHtml = admin
        ? `<div class="thx-actions">
             <button type="button" class="edit" data-id="${it.id}" title="编辑">✏️</button>
             <button type="button" class="danger" data-id="${it.id}" title="删除">🗑️</button>
           </div>`
        : "";
      const avatarIcon = category === "sponsor" ? "☕" : "🚀";
      return `
        <div class="thx-item" data-id="${it.id}">
          <span class="thx-avatar ${category}">${avatarIcon}</span>
          <div class="thx-main">
            <div class="thx-name">${escapeHtml(displayName)}${callsignHtml}</div>
            ${msgHtml}${metaHtml}
          </div>
          ${actionsHtml}
        </div>`;
    }).join("");

    if (admin) {
      el.querySelectorAll(".thx-actions .edit").forEach((b) => {
        b.addEventListener("click", () => openForm(items.find((x) => x.id === b.dataset.id)));
      });
      el.querySelectorAll(".thx-actions .danger").forEach((b) => {
        b.addEventListener("click", () => deleteThanks(b.dataset.id));
      });
    }
  }

  function renderLists() {
    const betaEl = $("thxBetaList");
    const sponsorEl = $("thxSponsorList");
    if (!betaEl || !sponsorEl) return;
    renderList(betaEl, "beta");
    renderList(sponsorEl, "sponsor");

    const betaCount = items.filter((it) => (it.category || "sponsor") === "beta").length;
    const sponsorCount = items.length - betaCount;
    const betaCountEl = $("thxBetaCount");
    const sponsorCountEl = $("thxSponsorCount");
    if (betaCountEl) betaCountEl.textContent = betaCount ? `（${betaCount}）` : "";
    if (sponsorCountEl) sponsorCountEl.textContent = sponsorCount ? `（${sponsorCount}）` : "";
  }

  // ---------- 管理员 UI ----------
  function renderAdminUI() {
    const admin = isAdmin(window.K5AUTH.getUser());
    const addBtn = $("thanksPageAdd");
    const hint = $("thanksPageAdminHint");
    if (addBtn) addBtn.style.display = admin ? "" : "none";
    if (hint) hint.style.display = admin ? "" : "none";
    // 非管理员时隐藏编辑表单
    if (!admin) hideForm();
    // 登录状态变化后重绘操作按钮
    if (items.length || document.querySelectorAll("#thxBetaList .thx-empty, #thxSponsorList .thx-empty").length) renderLists();
  }

  // ---------- 新增 / 编辑表单 ----------
  function toggleAmountField() {
    const category = $("thPageCategory").value;
    $("thPageAmountLabel").style.display = category === "sponsor" ? "" : "none";
  }

  function openForm(item) {
    editingId = item ? item.id : null;
    const form = $("thanksPageForm");
    if (!form) return;
    $("thanksPageFormTitle").textContent = editingId ? "编辑鸣谢" : "新增鸣谢";
    $("thPageCategory").value = item ? (item.category || "sponsor") : "sponsor";
    $("thPageName").value = item ? (item.name || "") : "";
    $("thPageCallsign").value = item ? (item.callsign || "") : "";
    $("thPageAmount").value = item && item.amount != null ? item.amount : "";
    $("thPageMessage").value = item ? (item.message || "") : "";
    toggleAmountField();
    setFormStatus("", "");
    form.style.display = "flex";
  }

  function hideForm() {
    const form = $("thanksPageForm");
    if (form) form.style.display = "none";
    editingId = null;
  }

  function setFormStatus(msg, cls) {
    const el = $("thanksPageFormStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "thx-form-status" + (cls ? " " + cls : "");
  }

  // ---------- 保存（新增 POST / 编辑 PUT） ----------
  async function saveThanks() {
    const category = $("thPageCategory").value;
    const name = ($("thPageName").value || "").trim();
    const callsign = ($("thPageCallsign").value || "").trim();
    const amountRaw = ($("thPageAmount").value || "").trim();
    const message = ($("thPageMessage").value || "").trim();

    if (!name && !callsign) { setFormStatus("姓名与呼号至少填一项", "err"); return; }
    if (callsign && !/^[A-Za-z0-9\-/]{2,12}$/.test(callsign)) {
      setFormStatus("呼号格式不正确（2-12 位字母/数字/-//）", "err");
      return;
    }
    let amount = null;
    if (category === "sponsor" && amountRaw !== "") {
      const n = Number(amountRaw);
      if (!Number.isFinite(n) || n < 0) { setFormStatus("金额不合法", "err"); return; }
      amount = n;
    }
    if (message.length > 200) { setFormStatus("留言不超过 200 字符", "err"); return; }

    const token = await window.K5AUTH.getToken();
    if (!token) { setFormStatus("登录状态已失效，请重新登录", "err"); window.K5AUTH.openModal(); return; }

    const btn = $("thanksPageFormSave");
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
        body: JSON.stringify({ name, callsign, amount, message, category }),
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
    if (!confirm(`确定删除 ${it.name || it.callsign || "该记录"} 的鸣谢吗？删除后不可恢复。`)) return;

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
    const addBtn = $("thanksPageAdd");
    const cancelBtn = $("thanksPageFormCancel");
    const saveBtn = $("thanksPageFormSave");
    const categorySel = $("thPageCategory");

    if (addBtn) addBtn.addEventListener("click", () => openForm(null));
    if (cancelBtn) cancelBtn.addEventListener("click", hideForm);
    if (saveBtn) saveBtn.addEventListener("click", saveThanks);
    if (categorySel) categorySel.addEventListener("change", toggleAmountField);

    // 登录状态变化时刷新管理员 UI
    if (window.K5AUTH) window.K5AUTH.onAuth(() => renderAdminUI());

    // 首次加载
    loadThanks();
  }

  window.K5THANKSPAGE = { init, loadThanks, isAdmin };
})();
