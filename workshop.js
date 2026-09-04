/**
 * K6Web 创意工坊 - 作品浏览/上传/下载逻辑
 * 依赖：window.K5AUTH（auth.js）
 *       window.SUPABASE_URL（index.html 配置）
 * 暴露：window.K5WORKSHOP
 */
(function () {
  "use strict";

  const FUNC_BASE = (window.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1";
  const CATEGORIES = {
    theme:     { label: "🎨 自定义主题",  icon: "🎨" },
    channel:   { label: "📋 信道模板",    icon: "📋" },
    extension: { label: "⚙️ 功能扩展",    icon: "⚙️" },
    firmware:  { label: "💾 固件",        icon: "💾" },
    logo:      { label: "🖼️ 开机图片",    icon: "🖼️" },
    other:     { label: "📦 其他作品",    icon: "📦" },
  };
  const CATEGORY_KEYS = ["theme", "channel", "extension", "firmware", "logo", "other"];

  let currentCategory = "all";
  let currentPage = 1;
  let total = 0;
  const PAGE_SIZE = 12;

  const $ = (id) => document.getElementById(id);
  const log = (msg, cls) => {
    const line = (cls ? `[${cls}] ` : "") + msg;
    console.log(line);
    const el = $("log");
    if (el) { el.textContent += line + "\n"; el.scrollTop = el.scrollHeight; }
  };

  function fmtSize(bytes) {
    if (!bytes) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 作者显示：带头像（仅 http/https 合法地址），否则回退首字母
  function safeAvatarUrl(u) {
    return /^https?:\/\//i.test(u || "") ? u : "";
  }
  function authorHtml(profiles, userId) {
    const name = escapeHtml((profiles && profiles.username) || "匿名");
    const avatar = safeAvatarUrl(profiles && profiles.avatar_url);
    const head = avatar
      ? `<img class="ws-author-avatar" src="${avatar}" alt="" loading="lazy">`
      : `<span class="ws-author-avatar ws-author-txt">${escapeHtml((profiles && profiles.username || "匿").charAt(0).toUpperCase())}</span>`;
    const link = userId ? `href="public-profile.html?id=${encodeURIComponent(userId)}"` : "";
    return `<a class="ws-author" ${link} onclick="event.stopPropagation()"><span class="ws-avatar-wrap">${head}</span>${name}</a>`;
  }

  // ---------- 公共请求头：Supabase Edge Function 网关要求带 key ----------
  // 公开接口用 publishable key（匿名角色）；需登录的接口由调用方传入用户 token
  function anonHeaders() {
    const h = { Authorization: "Bearer " + (window.SUPABASE_PUBLISHABLE_KEY || "") };
    if (window.SUPABASE_PUBLISHABLE_KEY) h.apikey = window.SUPABASE_PUBLISHABLE_KEY;
    return h;
  }

  // ---------- 列表 ----------
  async function loadList(page = currentPage, category = currentCategory) {
    const grid = $("workshopGrid");
    const status = $("workshopStatus");
    if (!grid) return;
    currentPage = page;
    currentCategory = category;
    grid.innerHTML = `<div class="ws-loading">加载中…</div>`;
    if (status) status.textContent = "";

    const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (category && category !== "all") params.set("category", category);

    try {
      const resp = await fetch(`${FUNC_BASE}/list-workshop?${params}`, { headers: anonHeaders() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      total = data.total || 0;
      renderList(data.items || []);
    } catch (e) {
      grid.innerHTML = `<div class="ws-empty">加载失败：${escapeHtml(e.message)}<br><small>请确认 Edge Function 已部署，或稍后重试</small></div>`;
      if (status) status.textContent = "加载失败";
    }
  }

  function renderList(items) {
    const grid = $("workshopGrid");
    const status = $("workshopStatus");
    if (!grid) return;

    if (!items.length) {
      grid.innerHTML = `<div class="ws-empty">还没有作品，快来上传第一个吧 🚀</div>`;
    } else {
      grid.innerHTML = items.map((it) => {
        const cat = CATEGORIES[it.category] || CATEGORIES.other;
        const authorName = (it.profiles && it.profiles.username) || "匿名";
        const thumbHtml = it.thumbnail_url
          ? `<img class="ws-item-thumb" src="${escapeHtml(it.thumbnail_url)}" alt="" loading="lazy">`
          : `<div class="ws-item-nothumb">${cat.icon}</div>`;
        return `
          <div class="ws-item" data-id="${it.id}" title="${escapeHtml(it.title)}">
            ${thumbHtml}
            <div class="ws-item-top">
              <span class="ws-item-cat">${cat.label.replace(/^[^\s]*\s/, "")}</span>
            </div>
            <div class="ws-item-title">${escapeHtml(it.title)}</div>
            <div class="ws-item-desc">${escapeHtml(it.description || "")}</div>
            <div class="ws-item-foot">
              <span class="ws-item-meta">
                <span title="作者">${authorHtml(it.profiles, it.user_id)}</span>
                <span title="下载次数">⬇️ ${it.download_count || 0}</span>
                <span title="文件大小">${fmtSize(it.file_size)}</span>
              </span>
              <span class="ws-item-date">${fmtDate(it.created_at)}</span>
            </div>
          </div>`;
      }).join("");
    }

    // 点击作品 → 详情
    grid.querySelectorAll(".ws-item").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.dataset.id));
    });

    // 分页
    renderPagination();
    if (status) status.textContent = `共 ${total} 个作品`;
  }

  function renderPagination() {
    const wrap = $("workshopPagination");
    if (!wrap) return;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (pages <= 1) { wrap.innerHTML = ""; return; }
    let html = `<button class="ws-page-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""}>‹ 上一页</button>
                <span class="ws-page-info">第 ${currentPage} / ${pages} 页</span>
                <button class="ws-page-btn" data-page="${currentPage + 1}" ${currentPage >= pages ? "disabled" : ""}>下一页 ›</button>`;
    wrap.innerHTML = html;
    wrap.querySelectorAll(".ws-page-btn:not([disabled])").forEach((b) => {
      b.addEventListener("click", () => loadList(parseInt(b.dataset.page, 10), currentCategory));
    });
  }

  // ---------- 详情 ----------
  function openDetail(id) {
    const modal = $("wsDetailModal");
    if (!modal) return;
    modal.classList.add("show");
    const body = $("wsDetailBody");
    const dlBtn = $("btnWsDownload");
    const editBtn = $("btnWsEdit");
    const delBtn = $("btnWsDelete");
    detailId = id;
    detailItem = null;
    body.innerHTML = `<div class="ws-loading">加载中…</div>`;
    dlBtn.disabled = true;
    if (editBtn) editBtn.style.display = "none";
    if (delBtn) delBtn.style.display = "none";

    // 隐藏评论区
    const commentsSection = $("wsComments");
    if (commentsSection) commentsSection.style.display = "none";

    fetch(`${FUNC_BASE}/get-workshop-item?id=${encodeURIComponent(id)}`, { headers: anonHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (!data.item) throw new Error(data.error || "加载失败");
        const it = data.item;
        detailItem = it;
        const cat = CATEGORIES[it.category] || CATEGORIES.other;
        const thumbHtml = it.thumbnail_url
          ? `<img class="ws-detail-thumb" src="${escapeHtml(it.thumbnail_url)}" alt="" loading="lazy">`
          : "";
        body.innerHTML = `
          ${thumbHtml}
          <div style="font-size:34px">${cat.icon}</div>
          <h3 style="margin:6px 0 2px">${escapeHtml(it.title)}</h3>
          <div style="font-size:12px;color:#888;margin-bottom:8px">${cat.label.replace(/^[^\s]*\s/, "")} · ${fmtDate(it.created_at)} · ${authorHtml(it.profiles, it.user_id)}</div>
          <div style="font-size:13px;color:#555;white-space:pre-wrap;margin-bottom:10px">${escapeHtml(it.description || "（无描述）")}</div>
          <div style="font-size:12px;color:#999">文件名：${escapeHtml(it.file_name)}（${fmtSize(it.file_size)}）· 下载 ${it.download_count || 0} 次</div>`;
        dlBtn.disabled = false;
        dlBtn.dataset.id = it.id;
        dlBtn.dataset.path = data.download_url || "";

        // 作者本人 → 显示编辑/删除按钮
        const isOwner = window.K5AUTH.isLoggedIn() && window.K5AUTH.getUserId() === it.user_id;
        if (editBtn) editBtn.style.display = isOwner ? "inline-flex" : "none";
        if (delBtn) delBtn.style.display = isOwner ? "inline-flex" : "none";

        // 开机图片分类 → 显示"下载&使用此图片"
        const useLogoBtn = $("btnWsUseLogo");
        if (useLogoBtn) useLogoBtn.style.display = it.category === "logo" ? "inline-flex" : "none";

        // 加载评论
        if (commentsSection && window.K5COMMENTS) {
          commentsSection.style.display = "block";
          if (window._wsCommentCtrl) window._wsCommentCtrl.setItemId(it.id);
          window.K5COMMENTS.load(it.id, "workshop", "wsCommentList");
        }
      })
      .catch((e) => {
        body.innerHTML = `<div class="ws-empty">加载失败：${escapeHtml(e.message)}</div>`;
      });
  }

  function closeDetail() {
    const modal = $("wsDetailModal");
    if (modal) modal.classList.remove("show");
    detailId = null;
    detailItem = null;
    const editBtn = $("btnWsEdit");
    const delBtn = $("btnWsDelete");
    if (editBtn) editBtn.style.display = "none";
    if (delBtn) delBtn.style.display = "none";
  }

  function download() {
    const btn = $("btnWsDownload");
    const url = btn.dataset.path;
    const id = btn.dataset.id;
    if (!url) return;

    // 先通知计数（不阻塞下载）
    fetch(`${FUNC_BASE}/bump-download?id=${encodeURIComponent(id)}`, { method: "POST", headers: anonHeaders() }).catch(() => {});

    // 触发浏览器下载
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- 分类切换 ----------
  function initCategoryTabs() {
    const wrap = $("workshopCategories");
    if (!wrap) return;
    const keys = ["all", ...CATEGORY_KEYS];
    wrap.innerHTML = keys.map((k) => {
      const label = k === "all" ? "全部" : CATEGORIES[k].label;
      return `<button class="ws-cat-btn ${k === currentCategory ? "active" : ""}" data-cat="${k}">${label}</button>`;
    }).join("");
    wrap.querySelectorAll(".ws-cat-btn").forEach((b) => {
      b.addEventListener("click", () => {
        wrap.querySelectorAll(".ws-cat-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        loadList(1, b.dataset.cat);
      });
    });
  }

  // ---------- 发布 / 编辑 / 删除 ----------
  let selectedCat = "theme";   // 发布/编辑弹窗当前分类
  let editingId = null;        // null = 发布新作品；非空 = 编辑该作品 id
  let detailId = null;         // 详情弹窗当前作品 id
  let detailItem = null;       // 详情弹窗当前作品数据
  let refreshUploadBtn = null; // initPublishForm 内注册，供 doPublish 结束后刷新按钮

  function showFiles(files) {
    const fileInfo = $("wsFileInfo");
    const fileNameEl = $("wsFileName");
    const fileSizeEl = $("wsFileSize");
    if (!fileInfo) return;
    if (!files || files.length === 0) { fileInfo.hidden = true; return; }
    let totalSize = 0;
    const names = [];
    for (const f of files) {
      totalSize += f.size;
      names.push(escapeHtml(f.name) + " (" + fmtSize(f.size) + ")");
    }
    fileNameEl.innerHTML = names.join("<br>");
    const warn = totalSize > 50 * 1024 * 1024 ? ' · <span style="color:#c62828">⚠️ 单个文件不能超过 50MB</span>' : "";
    fileSizeEl.innerHTML = "共 " + files.length + " 个文件，" + fmtSize(totalSize) + warn;
    fileInfo.hidden = false;
  }

  function openPublishModal(mode, item) {
    const modal = $("wsPublishModal");
    if (!modal) return;
    editingId = mode === "edit" && item ? item.id : null;

    const titleEl = $("workshopTitle");
    const descEl = $("workshopDesc");
    const fileEl = $("workshopFile");
    const thumbEl = $("workshopThumb");
    const thumbEnabled = $("wsThumbEnabled");
    const thumbPicker = $("wsThumbPicker");
    const thumbPreview = $("wsThumbPreview");

    // 标题与副标题
    $("wsPublishTitle").textContent = editingId ? "编辑作品" : "发布作品";
    $("wsPublishSub").textContent = editingId
      ? `保留当前文件《${item.file_name}》· 不选新文件则不改动文件，其余修改即时生效。`
      : "分享你的信道模板、配置方案、固件或脚本扩展。支持 .bin / .csv / .txt / .json / .py / .zip 等格式，文件 ≤ 50MB。";

    // 预填 / 清空表单
    titleEl.value = editingId ? item.title : "";
    descEl.value = editingId ? (item.description || "") : "";
    fileEl.value = "";
    thumbEl.value = "";
    thumbEnabled.checked = false;
    if (thumbPicker) thumbPicker.hidden = true;
    if (thumbPreview) thumbPreview.innerHTML = "🖼️";
    showFiles(null);

    // 分类：编辑时选中当前分类
    selectedCat = editingId ? (item.category || "theme") : "theme";
    document.querySelectorAll("#workshopCategoryBtns .ws-cat-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.cat === selectedCat);
    });

    modal.classList.add("show");
    if (refreshUploadBtn) refreshUploadBtn();
  }

  function closePublishModal() {
    const modal = $("wsPublishModal");
    if (modal) modal.classList.remove("show");
  }

  function initPublishForm() {
    const titleEl = $("workshopTitle");
    const descEl = $("workshopDesc");
    const fileEl = $("workshopFile");
    const catWrap = $("workshopCategoryBtns");
    const btn = $("btnWorkshopUpload");
    const dz = $("wsDropzone");
    const fileInfo = $("wsFileInfo");
    const fileRemove = $("wsFileRemove");
    const thumbEl = $("workshopThumb");
    const thumbBtn = $("wsThumbBtn");
    const thumbPreview = $("wsThumbPreview");
    const thumbEnabled = $("wsThumbEnabled");
    const thumbPicker = $("wsThumbPicker");

    if (!catWrap || !btn) return;

    // 缩略图开关
    if (thumbEnabled && thumbPicker) {
      thumbEnabled.addEventListener("change", () => {
        thumbPicker.hidden = !thumbEnabled.checked;
        if (!thumbEnabled.checked) {
          if (thumbEl) thumbEl.value = "";
          if (thumbPreview) thumbPreview.innerHTML = "🖼️";
        }
        refresh();
      });
    }

    // 缩略图选择
    if (thumbBtn && thumbEl) {
      thumbBtn.addEventListener("click", () => thumbEl.click());
      thumbEl.addEventListener("change", () => {
        const f = thumbEl.files[0];
        if (!f) { thumbPreview.innerHTML = "🖼️"; return; }
        if (f.size > 20 * 1024 * 1024) { alert("展示图不能超过 20MB"); thumbEl.value = ""; return; }
        if (!/\.(jpe?g|png|gif|webp)$/i.test(f.name)) { alert("仅支持 jpg/png/gif/webp"); thumbEl.value = ""; return; }
        const reader = new FileReader();
        reader.onload = () => { thumbPreview.innerHTML = `<img src="${reader.result}" alt="预览">`; };
        reader.readAsDataURL(f);
        refresh();
      });
    }

    // 分类按钮组
    catWrap.innerHTML = CATEGORY_KEYS.map((k) =>
      `<button type="button" class="ws-cat-btn ${k === selectedCat ? "active" : ""}" data-cat="${k}">${CATEGORIES[k].label}</button>`
    ).join("");
    catWrap.querySelectorAll(".ws-cat-btn").forEach((b) => {
      b.addEventListener("click", () => {
        catWrap.querySelectorAll(".ws-cat-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        selectedCat = b.dataset.cat;
        refresh();
      });
    });

    // 拖拽上传
    if (dz) {
      dz.addEventListener("click", () => fileEl.click());
      ["dragenter", "dragover"].forEach((ev) =>
        dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
      ["dragleave", "drop"].forEach((ev) =>
        dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
      dz.addEventListener("drop", (e) => {
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          fileEl.files = files;
          showFiles(files);
          refresh();
        }
      });
    }
    fileEl.addEventListener("change", () => {
      showFiles(fileEl.files);
      refresh();
    });
    if (fileRemove) fileRemove.addEventListener("click", () => {
      fileEl.value = "";
      showFiles(null);
      refresh();
    });

    function refresh() {
      const title = titleEl.value.trim();
      const hasFile = fileEl.files && fileEl.files.length > 0;
      const logged = window.K5AUTH.isLoggedIn();
      // 编辑时可不换文件；发布时必须选文件
      btn.disabled = !(logged && title && (editingId || hasFile));
      if (!logged) {
        btn.textContent = "🔒 登录后上传";
      } else if (editingId) {
        btn.textContent = "💾 保存修改";
      } else if (title && hasFile) {
        btn.textContent = "🚀 提交作品";
      } else {
        btn.textContent = "填写标题并选择文件";
      }
    }
    refreshUploadBtn = refresh;

    [titleEl, descEl, fileEl].forEach((el) => {
      if (el) { el.addEventListener("input", refresh); el.addEventListener("change", refresh); }
    });

    // 提交按钮：未登录先提示登录
    btn.addEventListener("click", async () => {
      if (!window.K5AUTH.isLoggedIn()) {
        window.K5AUTH.openModal();
        return;
      }
      await doPublish(titleEl, descEl, fileEl, btn);
    });

    // 登录状态变化时刷新按钮
    window.K5AUTH.onAuth(() => refresh());
    refresh();
  }

  async function doPublish(titleEl, descEl, fileEl, btn) {
    const title = titleEl.value.trim();
    const desc = descEl.value.trim();
    const files = fileEl.files;

    // 获取缩略图（可选）
    const thumbEl = $("workshopThumb");
    const thumbEnabled = $("wsThumbEnabled");
    const thumbFile = (thumbEnabled && thumbEnabled.checked && thumbEl) ? thumbEl.files[0] : null;
    if (thumbEnabled && thumbEnabled.checked && !thumbFile) { alert("已勾选展示图但未选择文件"); return; }

    const token = await window.K5AUTH.getToken();
    if (!token) { alert("登录状态已失效，请重新登录"); window.K5AUTH.openModal(); return; }

    // ===== 编辑：单作品提交到 update-workshop =====
    if (editingId) {
      const newFile = files && files.length > 0 ? files[0] : null;
      if (newFile && newFile.size > 50 * 1024 * 1024) {
        alert(`文件 "${newFile.name}" 超过 50MB 限制`);
        return;
      }

      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = "⏳ 保存中...";
      try {
        const form = new FormData();
        form.append("id", editingId);
        form.append("title", title);
        form.append("description", desc);
        form.append("category", selectedCat);
        if (newFile) form.append("file", newFile);
        if (thumbFile) form.append("thumbnail", thumbFile);

        const resp = await fetch(`${FUNC_BASE}/update-workshop`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
          },
          body: form,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);

        alert("✅ 修改已保存！");
        closePublishModal();
        loadList(currentPage, currentCategory);
        // 若详情弹窗正开着同一作品，刷新详情
        if (detailId === editingId && $("wsDetailModal").classList.contains("show")) {
          openDetail(editingId);
        }
      } catch (e) {
        log(`❌ 保存失败：${e.message}`, "工坊");
        alert(`保存失败：${e.message}`);
      }
      btn.textContent = oldText;
      if (refreshUploadBtn) refreshUploadBtn();
      return;
    }

    // ===== 发布：多文件逐个提交到 upload-workshop =====
    if (!files || files.length === 0) return;
    for (const f of files) {
      if (f.size > 50 * 1024 * 1024) {
        alert(`文件 "${f.name}" 超过 50MB 限制`);
        return;
      }
    }

    btn.disabled = true;
    const oldText = btn.textContent;
    const total = files.length;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < total; i++) {
      const f = files[i];
      btn.textContent = `⏳ 上传中 (${i + 1}/${total})...`;

      try {
        const form = new FormData();
        form.append("title", total > 1 ? `${title} - ${f.name.replace(/\.[^.]+$/, "")}` : title);
        form.append("description", desc);
        form.append("category", selectedCat);
        form.append("file", f);
        if (thumbFile) form.append("thumbnail", thumbFile);

        const resp = await fetch(`${FUNC_BASE}/upload-workshop`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
          },
          body: form,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
        successCount++;
        log(`✅ 作品《${f.name}》上传成功`, "工坊");
      } catch (e) {
        failCount++;
        log(`❌ 上传失败：${f.name} - ${e.message}`, "工坊");
      }
    }

    // 清空表单
    titleEl.value = ""; descEl.value = ""; fileEl.value = "";
    showFiles(null);
    if (thumbEl) { thumbEl.value = ""; }
    if (thumbEnabled) thumbEnabled.checked = false;
    const thumbPicker = $("wsThumbPicker");
    if (thumbPicker) thumbPicker.hidden = true;
    const thumbPreview = $("wsThumbPreview");
    if (thumbPreview) thumbPreview.innerHTML = "🖼️";

    if (total === 1) {
      alert(successCount > 0 ? "✅ 作品上传成功！" : "上传失败");
    } else {
      alert(`上传完成：${successCount} 个成功，${failCount} 个失败`);
    }

    closePublishModal();
    loadList(1, "all");
    // 切回全部分类
    document.querySelectorAll("#workshopCategories .ws-cat-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.cat === "all");
    });

    btn.textContent = oldText;
    if (refreshUploadBtn) refreshUploadBtn();
  }

  // 删除当前详情作品（仅作者可见入口）
  async function deleteDetailItem() {
    const id = detailId;
    if (!id) return;
    if (!confirm("确定删除这个作品吗？删除后不可恢复。")) return;

    const token = await window.K5AUTH.getToken();
    if (!token) { alert("登录状态已失效，请重新登录"); window.K5AUTH.openModal(); return; }

    const btn = $("btnWsDelete");
    const oldText = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "⏳ 删除中..."; }
    try {
      const resp = await fetch(`${FUNC_BASE}/delete-workshop?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + token,
          apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
        },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);

      alert("🗑️ 作品已删除");
      closeDetail();
      loadList(currentPage, currentCategory);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }

  // 供其他页面（如开机图片）上传单个作品文件：标题/描述/分类/文件
  // 成功返回 { id, title }，失败抛异常
  async function uploadFile({ title, description = "", category = "other", file }) {
    if (!title || !file) throw new Error("标题和文件必填");
    const token = await window.K5AUTH.getToken();
    if (!token) { alert("登录状态已失效，请重新登录"); window.K5AUTH.openModal(); return null; }

    const form = new FormData();
    form.append("title", title);
    form.append("description", description);
    form.append("category", category);
    form.append("file", file);

    const resp = await fetch(`${FUNC_BASE}/upload-workshop`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
      },
      body: form,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
    return data.item || data;
  }

  // ---------- 初始化 ----------
  function init() {
    initCategoryTabs();
    initPublishForm();
    loadList(1, "all");

    const closeBtn = $("btnWsDetailClose");
    if (closeBtn) closeBtn.addEventListener("click", closeDetail);
    const dlBtn = $("btnWsDownload");
    if (dlBtn) dlBtn.addEventListener("click", download);
    const modal = $("wsDetailModal");
    if (modal) modal.addEventListener("click", (e) => {
      if (e.target === modal) closeDetail();
    });

    // 发布按钮（顶部）
    const publishBtn = $("btnWsPublish");
    if (publishBtn) {
      publishBtn.addEventListener("click", () => {
        if (!window.K5AUTH.isLoggedIn()) {
          window.K5AUTH.openModal();
          return;
        }
        openPublishModal("create", null);
      });
    }
    // 发布弹窗：取消 / 点遮罩关闭
    const publishCancel = $("btnWsPublishCancel");
    if (publishCancel) publishCancel.addEventListener("click", closePublishModal);
    const publishModal = $("wsPublishModal");
    if (publishModal) publishModal.addEventListener("click", (e) => {
      if (e.target === publishModal) closePublishModal();
    });
    // 编辑 / 删除（仅作者可见，详情弹窗内）
    const editBtn = $("btnWsEdit");
    if (editBtn) editBtn.addEventListener("click", () => openPublishModal("edit", detailItem));
    const delBtn = $("btnWsDelete");
    if (delBtn) delBtn.addEventListener("click", deleteDetailItem);

    // 开机图片：下载&使用此图片（跳转开机图片页并载入预览）
    const useLogoBtn = $("btnWsUseLogo");
    if (useLogoBtn) {
      useLogoBtn.addEventListener("click", async () => {
        const url = $("btnWsDownload")?.dataset.path;
        if (!url) { alert("暂无可下载地址"); return; }
        useLogoBtn.disabled = true;
        const oldText = useLogoBtn.textContent;
        useLogoBtn.textContent = "⏳ 下载中...";
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const blob = await resp.blob();
          const fileName = detailItem?.file_name || "logo.png";
          const file = new File([blob], fileName, { type: blob.type || "image/png" });
          closeDetail();
          if (typeof window.switchTab === "function") window.switchTab("tabLogo");
          // 等页面切换完成后再载入图片
          setTimeout(() => {
            if (window.K5LOGO && window.K5LOGO.loadLogoFile) {
              window.K5LOGO.loadLogoFile(file);
              alert("✅ 已载入开机图片预览，可在下方调整反色/阈值后写入对讲机");
            } else {
              alert("开机图片模块未就绪，请稍后重试");
            }
          }, 100);
        } catch (e) {
          alert("下载失败：" + e.message);
        } finally {
          useLogoBtn.disabled = false;
          useLogoBtn.textContent = oldText;
        }
      });
    }

    // 登录状态变化时，若详情弹窗开着，重刷作者按钮显隐
    window.K5AUTH.onAuth(() => {
      if (detailId && $("wsDetailModal").classList.contains("show")) {
        openDetail(detailId);
      }
    });

    // 初始化工坊评论区
    if (window.K5COMMENTS) {
      window._wsCommentCtrl = window.K5COMMENTS.init({
        inputId: "wsCommentText",
        submitBtnId: "wsCommentSubmit",
        listContainerId: "wsCommentList",
        itemType: "workshop",
      });
    }

    // 进入工坊 tab 时刷新（首次 init 已加载；重复进入只刷新一次避免刷屏）
    let loadedOnce = false;
    const origSwitch = window.switchTab;
    if (typeof origSwitch === "function") {
      const orig = origSwitch;
      window.switchTab = function (tabId) {
        orig.apply(this, arguments);
        if (tabId === "tabWorkshop" && !loadedOnce) {
          loadedOnce = true;
          // 延迟等待 DOM/布局就绪
          setTimeout(() => loadList(currentPage, currentCategory), 50);
        }
      };
    }

    // 处理公开主页作品的深链接：index.html#ws-<作品ID>
    const hash = window.location.hash || "";
    if (hash.startsWith("#ws-")) {
      const workId = hash.slice(4).trim();
      if (workId && typeof window.switchTab === "function") {
        window.switchTab("tabWorkshop");
        openDetail(workId);
      }
    }
  }

  window.K5WORKSHOP = { init, loadList, uploadFile };
})();
