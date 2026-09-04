/**
 * K6Web 创意工坊 - 认证模块（Supabase Auth）
 * 依赖：window.supabase（supabase-js UMD）
 *       window.SUPABASE_URL / window.SUPABASE_PUBLISHABLE_KEY（index.html 配置）
 * 暴露：window.K5AUTH
 */
(function () {
  "use strict";

  const URL = window.SUPABASE_URL;
  const KEY = window.SUPABASE_PUBLISHABLE_KEY;

  let supabase = null;
  let user = null;        // 当前登录用户（null = 未登录）
  let callbacks = [];     // 认证状态变化回调

  function emit() {
    callbacks.forEach((cb) => { try { cb(user); } catch (e) { console.error(e); } });
  }

  function safeAvatar(url) {
    if (!url) return "";
    // 仅允许 http(s) 或 data:image 开头的头像地址，防注入
    if (/^(https?:)?\/\//i.test(url) || /^data:image\//i.test(url)) return url;
    return "";
  }

  function renderAuthUI() {
    const btn = document.getElementById("btnAuth");
    const badge = document.getElementById("userBadge");
    if (!btn) return;

    if (user) {
      const meta = user.user_metadata || {};
      const name = meta.user_name || meta.name || meta.full_name || meta.preferred_username || user.email || "用户";
      const avatar = safeAvatar(meta.avatar_url || meta.picture);
      if (badge) {
        const avatarHtml = avatar
          ? `<img class="user-avatar user-avatar-btn" src="${avatar}" alt="头像" title="点击更换头像" loading="lazy">`
          : `<span class="user-avatar user-avatar-txt user-avatar-btn" title="点击更换头像">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
        const dropdownAvatar = avatar
          ? `<img class="user-dropdown-avatar" src="${avatar}" alt="" loading="lazy">`
          : `<span class="user-dropdown-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
        badge.innerHTML = avatarHtml + `<span class="user-name">${escapeHtml(name)}</span>`
          + `<div class="user-dropdown">
               <div class="user-dropdown-head">
                 ${dropdownAvatar}
                 <div><div class="user-dropdown-name">${escapeHtml(name)}</div><div class="user-dropdown-email">${escapeHtml(user.email || "")}</div></div>
               </div>
               <div class="user-dropdown-item" id="menuProfile">👤 个人中心</div>
               <div class="user-dropdown-item" id="menuMyWorks">🗂️ 我的作品</div>
               <div class="user-dropdown-item danger" id="menuLogout">🚪 退出登录</div>
             </div>`;
        badge.style.display = "inline-flex";
        bindAvatarClick();
        document.getElementById("menuProfile")?.addEventListener("click", () => { window.location.href = "profile.html"; });
        document.getElementById("menuMyWorks")?.addEventListener("click", openMyWorks);
        document.getElementById("menuLogout")?.addEventListener("click", signOut);
      }
      btn.textContent = "登出";
      btn.classList.add("secondary");
    } else {
      if (badge) { badge.style.display = "none"; badge.innerHTML = ""; }
      btn.textContent = "登录/注册";
      btn.classList.remove("secondary");
    }
  }

  // 点击头像 -> 选择图片上传
  function bindAvatarClick() {
    const avatarEl = document.querySelector("#userBadge .user-avatar-btn");
    const fileEl = document.getElementById("avatarInput");
    if (!avatarEl || !fileEl) return;
    avatarEl.addEventListener("click", () => fileEl.click());
  }

  // 个人中心弹窗
  function openProfile() {
    const modal = document.getElementById("profileModal");
    const body = document.getElementById("profileBody");
    if (!modal || !body || !user) return;
    const meta = user.user_metadata || {};
    const name = meta.user_name || meta.name || meta.full_name || meta.preferred_username || user.email || "用户";
    const avatar = safeAvatar(meta.avatar_url || meta.picture);
    const head = avatar
      ? `<img class="user-dropdown-avatar" src="${avatar}" alt="" loading="lazy">`
      : `<span class="user-dropdown-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
    const joined = user.created_at
      ? `<div class="profile-joined">加入于 ${new Date(user.created_at).toLocaleDateString("zh-CN")}</div>`
      : "";
    body.innerHTML = head
      + `<div class="user-dropdown-name">${escapeHtml(name)}</div>`
      + `<div class="user-dropdown-email">${escapeHtml(user.email || "")}</div>`
      + joined;
    modal.classList.add("show");
  }

  function closeProfile() {
    const modal = document.getElementById("profileModal");
    if (modal) modal.classList.remove("show");
  }

  // 我的作品：REST 直接查询本人上传的作品（RLS 公开可读，无需 Edge Function）
  async function openMyWorks() {
    const modal = document.getElementById("myWorksModal");
    const body = document.getElementById("myWorksBody");
    if (!modal || !body || !user) return;
    body.innerHTML = `<div class="ws-loading">加载中…</div>`;
    modal.classList.add("show");

    try {
      const url = `${URL}/rest/v1/workshop_items?user_id=eq.${encodeURIComponent(user.id)}&select=id,title,category,file_name,file_size,download_count,created_at&order=created_at.desc`;
      const resp = await fetch(url, {
        headers: {
          apikey: KEY,
          Authorization: "Bearer " + KEY,
        },
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const items = await resp.json();

      if (!items.length) {
        body.innerHTML = `<div class="ws-empty">你还没有上传过作品，去创意工坊发布第一个吧 🚀</div>`;
        return;
      }
      const CAT_ICON = { theme: "🎨", channel: "📋", extension: "⚙️", firmware: "💾", other: "📦" };
      const rows = items.map((it) => `
        <div class="my-work-item">
          <span class="my-work-icon">${CAT_ICON[it.category] || "📦"}</span>
          <div class="my-work-main">
            <div class="my-work-title">${escapeHtml(it.title)}</div>
            <div class="my-work-sub">${escapeHtml(it.file_name)} · ${fmtSize(it.file_size)} · ⬇️ ${it.download_count || 0} · ${fmtDate(it.created_at)}</div>
          </div>
        </div>`).join("");
      body.innerHTML = `<div class="my-work-list">${rows}</div>`;
    } catch (e) {
      body.innerHTML = `<div class="ws-empty">加载失败：${escapeHtml(e.message || "请稍后重试")}</div>`;
    }
  }

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

  function closeMyWorks() {
    const modal = document.getElementById("myWorksModal");
    if (modal) modal.classList.remove("show");
  }

  let cropState = null;

  function closeAvatarCrop(resetInput = true) {
    const modal = document.getElementById("avatarCropModal");
    if (modal) modal.classList.remove("show");
    if (cropState?.objectUrl) URL.revokeObjectURL(cropState.objectUrl);
    cropState = null;
    if (resetInput) {
      const input = document.getElementById("avatarInput");
      if (input) input.value = "";
    }
  }

  function clampCropPosition() {
    if (!cropState) return;
    const { image, canvas, scale } = cropState;
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    cropState.x = Math.min(0, Math.max(canvas.width - w, cropState.x));
    cropState.y = Math.min(0, Math.max(canvas.height - h, cropState.y));
  }

  function drawAvatarCrop() {
    if (!cropState) return;
    const { image, canvas, ctx } = cropState;
    clampCropPosition();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#101828";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, cropState.x, cropState.y, image.naturalWidth * cropState.scale, image.naturalHeight * cropState.scale);
  }

  function updateCropZoom(value) {
    if (!cropState) return;
    const oldScale = cropState.scale;
    const nextScale = cropState.baseScale * Number(value);
    const center = cropState.canvas.width / 2;
    cropState.x = center - (center - cropState.x) * nextScale / oldScale;
    cropState.y = center - (center - cropState.y) * nextScale / oldScale;
    cropState.scale = nextScale;
    drawAvatarCrop();
  }

  function openAvatarCrop(file) {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const status = document.getElementById("avatarCropStatus");
    if (!file || !allowed.includes(file.type)) {
      if (status) status.textContent = "仅支持 JPG、PNG、GIF、WebP 格式";
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      if (status) status.textContent = "原图不能超过 20MB";
      return;
    }

    const modal = document.getElementById("avatarCropModal");
    const canvas = document.getElementById("avatarCropCanvas");
    const zoom = document.getElementById("avatarCropZoom");
    const apply = document.getElementById("avatarCropApply");
    if (!modal || !canvas || !zoom || !apply) return;

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    cropState = { image, canvas, ctx: canvas.getContext("2d"), objectUrl, baseScale: 1, scale: 1, x: 0, y: 0, dragging: false };
    if (status) status.textContent = "图片加载中…";
    apply.disabled = true;
    modal.classList.add("show");

    image.onload = () => {
      const baseScale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
      cropState.baseScale = baseScale;
      cropState.scale = baseScale;
      cropState.x = (canvas.width - image.naturalWidth * baseScale) / 2;
      cropState.y = (canvas.height - image.naturalHeight * baseScale) / 2;
      zoom.value = "1";
      apply.disabled = false;
      if (status) status.textContent = "";
      drawAvatarCrop();
    };
    image.onerror = () => {
      if (status) status.textContent = "图片读取失败，请换一张图片";
      apply.disabled = true;
    };
    image.src = objectUrl;
  }

  function initAvatarCrop() {
    const canvas = document.getElementById("avatarCropCanvas");
    const zoom = document.getElementById("avatarCropZoom");
    const apply = document.getElementById("avatarCropApply");
    const cancel = document.getElementById("avatarCropCancel");
    const input = document.getElementById("avatarInput");
    if (!canvas || !zoom || !apply || !cancel || !input) return;

    input.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) openAvatarCrop(file);
    });
    zoom.addEventListener("input", () => updateCropZoom(zoom.value));
    cancel.addEventListener("click", () => closeAvatarCrop());

    let pointer = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (!cropState || apply.disabled) return;
      canvas.setPointerCapture(e.pointerId);
      pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!cropState || !pointer || pointer.id !== e.pointerId) return;
      const rect = canvas.getBoundingClientRect();
      cropState.x += (e.clientX - pointer.x) * canvas.width / rect.width;
      cropState.y += (e.clientY - pointer.y) * canvas.height / rect.height;
      pointer.x = e.clientX; pointer.y = e.clientY;
      drawAvatarCrop();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => {
      canvas.addEventListener(eventName, () => { pointer = null; });
    });

    apply.addEventListener("click", async () => {
      if (!cropState || apply.disabled) return;
      const status = document.getElementById("avatarCropStatus");
      apply.disabled = true;
      if (status) status.textContent = "正在生成并上传…";
      try {
        const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法生成图片")), "image/jpeg", 0.9));
        if (blob.size > 2 * 1024 * 1024) throw new Error("裁剪后的头像不能超过 2MB");
        const cropped = new File([blob], "avatar.jpg", { type: "image/jpeg" });
        await uploadAvatar(cropped);
        closeAvatarCrop();
      } catch (e) {
        apply.disabled = false;
        if (status) status.textContent = e.message || "上传失败，请重试";
      }
    });
  }

  async function uploadAvatar(file) {
    if (!file || file.size > 2 * 1024 * 1024) throw new Error("头像图片不能超过 2MB");
    const token = await getToken();
    if (!token) throw new Error("登录状态已失效，请重新登录");

    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch(URL + "/functions/v1/upload-avatar", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);

    const { error: upErr } = await supabase.auth.updateUser({ data: { avatar_url: data.avatar_url } });
    if (upErr) throw upErr;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function openModal() {
    const modal = document.getElementById("authModal");
    if (modal) modal.classList.add("show");
    setAuthMode("login");
    clearAuthError();
  }
  function closeModal() {
    const modal = document.getElementById("authModal");
    if (modal) modal.classList.remove("show");
  }

  function setAuthMode(mode) {
    const isLogin = mode === "login";
    const submit = document.getElementById("btnAuthSubmit");
    const email = document.getElementById("authEmail");
    const usernameRow = document.getElementById("authUsernameRow");
    const confirmRow = document.getElementById("authConfirmRow");
    const emailRow = document.getElementById("authEmailRow");
    if (submit) submit.textContent = isLogin ? "登录" : "注册";
    document.querySelectorAll(".auth-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.mode === mode);
    });
    if (email) email.placeholder = isLogin ? "邮箱" : "注册邮箱（将发送验证邮件）";
    if (usernameRow) usernameRow.style.display = isLogin ? "none" : "";
    if (confirmRow) {
      confirmRow.style.display = isLogin ? "none" : "";
      confirmRow.classList.remove("match", "mismatch");
    }
    if (emailRow) emailRow.classList.remove("valid", "invalid");
    const forgotRow = document.getElementById("authForgotRow");
    if (forgotRow) forgotRow.style.display = isLogin ? "" : "none";
    const title = document.getElementById("authTitle");
    const sub = document.getElementById("authSub");
    if (title) title.textContent = isLogin ? "欢迎回来" : "创建你的账号";
    if (sub) sub.textContent = isLogin ? "登录后可上传创意工坊作品" : "注册后即可上传作品、同步数据";
  }

  function setAuthError(msg, isError = true) {
    const el = document.getElementById("authError");
    if (!el) return;
    el.textContent = msg || "";
    if (isError) el.classList.add("err"); else el.classList.remove("err");
  }
  function clearAuthError() {
    const el = document.getElementById("authError");
    if (el) { el.textContent = ""; el.classList.remove("err"); }
  }

  function getMode() {
    const active = document.querySelector(".auth-tab.active");
    return active ? active.dataset.mode : "login";
  }

  function isValidUsername(s) {
    return /^[\w\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,20}$/.test(s);
  }

  function isValidEmail(s) {
    if (!s || s.length > 254) return false;
    if (s.includes("..")) return false;
    return /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s);
  }

  async function submitPassword() {
    clearAuthError();
    const email = document.getElementById("authEmail").value.trim();
    const pass = document.getElementById("authPassword").value;
    const username = (document.getElementById("authUsername")?.value || "").trim();
    const confirmPass = (document.getElementById("authConfirmPassword")?.value || "").trim();
    if (!email || !pass) { setAuthError("请填写邮箱和密码"); return; }
    if (!isValidEmail(email)) { setAuthError("请输入有效的邮箱地址"); return; }
    const mode = getMode();
    if (mode === "register") {
      if (!isValidUsername(username)) { setAuthError("用户名需 2-20 字符，支持中文/字母/数字/下划线"); return; }
      if (pass.length < 6) { setAuthError("密码至少 6 位"); return; }
      if (!confirmPass) { setAuthError("请再次输入确认密码"); return; }
      if (pass !== confirmPass) { setAuthError("两次输入的密码不一致"); return; }
    }
    try {
      const btn = document.getElementById("btnAuthSubmit");
      if (btn) {
        btn.disabled = true;
        btn.classList.add("loading");
        btn.dataset.original = btn.textContent;
        btn.textContent = mode === "register" ? "注册中…" : "登录中…";
      }
      const { error } = mode === "register"
        ? await supabase.auth.signUp({ email, password: pass, options: { data: { user_name: username } } })
        : await supabase.auth.signInWithPassword({ email, password: pass });
      if (error) { setAuthError(error.message); return; }
      if (mode === "register") {
        setAuthError("注册成功，请查收邮箱完成验证后登录", false);
      } else {
        closeModal();
      }
    } catch (e) {
      setAuthError(e.message || "登录失败");
    } finally {
      const btn = document.getElementById("btnAuthSubmit");
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.textContent = btn.dataset.original || (mode === "register" ? "注册" : "登录");
        delete btn.dataset.original;
      }
    }
  }

  async function oauth(provider) {
    clearAuthError();
    try {
      const { error } = await supabase.auth.signInWithOAuth({ provider });
      if (error) setAuthError(error.message);
    } catch (e) {
      setAuthError(e.message || "OAuth 登录失败");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  // ---------- 完善资料（GitHub 登录后首次） ----------
  function maybePromptCompleteProfile() {
    if (!user) return;
    // 仅 GitHub 登录且尚未完善资料时提示
    if (user.app_metadata?.provider !== "github") return;
    if (user.user_metadata?.profile_completed) return;
    openCompleteProfile();
  }

  function openCompleteProfile() {
    const modal = document.getElementById("completeProfileModal");
    if (!modal) return;
    const uEl = document.getElementById("cpUsername");
    const eEl = document.getElementById("cpEmail");
    const st = document.getElementById("cpUsernameStatus");
    const err = document.getElementById("cpError");
    const meta = user.user_metadata || {};
    if (uEl) uEl.value = meta.user_name || meta.name || meta.preferred_username || "";
    if (eEl) eEl.value = user.email || "";
    if (st) { st.textContent = ""; st.classList.remove("err", "ok"); }
    if (err) err.textContent = "";
    refreshCpSubmit();
    modal.classList.add("show");
  }

  function closeCompleteProfile() {
    const modal = document.getElementById("completeProfileModal");
    if (modal) modal.classList.remove("show");
  }

  function refreshCpSubmit() {
    const btn = document.getElementById("btnCpSubmit");
    if (!btn) return;
    const u = (document.getElementById("cpUsername")?.value || "").trim();
    const e = (document.getElementById("cpEmail")?.value || "").trim();
    btn.disabled = !(isValidUsername(u) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  }

  async function submitCompleteProfile() {
    const uEl = document.getElementById("cpUsername");
    const eEl = document.getElementById("cpEmail");
    const st = document.getElementById("cpUsernameStatus");
    const err = document.getElementById("cpError");
    const btn = document.getElementById("btnCpSubmit");
    const username = (uEl?.value || "").trim();
    const email = (eEl?.value || "").trim();
    if (!isValidUsername(username)) {
      if (err) err.textContent = "用户名需 2-20 字符，支持中文/字母/数字/下划线";
      return;
    }
    const token = await getToken();
    if (!token) { if (err) err.textContent = "登录状态已失效，请重新登录"; return; }
    if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
    try {
      const resp = await fetch(URL + "/functions/v1/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ username, email }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 409 && st) {
          st.textContent = "该用户名已被占用，换一个试试";
          st.classList.add("err");
        } else if (err) {
          err.textContent = data.error || "保存失败，请重试";
        }
        return;
      }
      // 刷新本地用户元数据
      const { data: ud } = await supabase.auth.getUser();
      if (ud.user) user = ud.user;
      closeCompleteProfile();
      renderAuthUI();
      if (window.K5WORKSHOP && typeof window.K5WORKSHOP.loadList === "function") {
        window.K5WORKSHOP.loadList(1, "all");
      }
    } catch (e) {
      if (err) err.textContent = "保存失败：" + (e.message || "请重试");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "保存"; }
    }
  }

  // ---------- 找回密码 ----------
  function openForgotModal() {
    const modal = document.getElementById("forgotModal");
    if (!modal) return;
    // 默认显示第一步（输入邮箱）
    const step1 = document.getElementById("forgotStep1");
    const step2 = document.getElementById("forgotStep2");
    if (step1) step1.style.display = "";
    if (step2) step2.style.display = "none";
    const err1 = document.getElementById("forgotError");
    const err2 = document.getElementById("forgotError2");
    if (err1) err1.textContent = "";
    if (err2) err2.textContent = "";
    modal.classList.add("show");
    const email = document.getElementById("forgotEmail");
    if (email) email.value = "";
  }

  function closeForgotModal() {
    const modal = document.getElementById("forgotModal");
    if (modal) modal.classList.remove("show");
  }

  // 显示设置新密码步骤（recovery 回调时调用）
  function showForgotStep2() {
    const modal = document.getElementById("forgotModal");
    if (!modal) return;
    const step1 = document.getElementById("forgotStep1");
    const step2 = document.getElementById("forgotStep2");
    if (step1) step1.style.display = "none";
    if (step2) step2.style.display = "";
    const title = document.getElementById("forgotTitle");
    const sub = document.getElementById("forgotSub");
    if (title) title.textContent = "设置新密码";
    if (sub) sub.textContent = "验证通过，请设置一个新密码";
    modal.classList.add("show");
  }

  async function sendResetEmail() {
    const email = (document.getElementById("forgotEmail")?.value || "").trim();
    const err = document.getElementById("forgotError");
    if (!email) { if (err) { err.textContent = "请输入邮箱"; err.classList.add("err"); } return; }
    const btn = document.getElementById("btnForgotSend");
    if (btn) { btn.disabled = true; btn.classList.add("loading"); }
    try {
      // redirectTo 指向当前站点，恢复链接会带回 recovery token
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/",
      });
      if (error) throw error;
      if (err) { err.textContent = "✅ 重置邮件已发送，请查收邮箱"; err.classList.remove("err"); }
    } catch (e) {
      if (err) { err.textContent = "发送失败：" + (e.message || "请重试"); err.classList.add("err"); }
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
    }
  }

  async function submitNewPassword() {
    const p1 = (document.getElementById("forgotNewPassword")?.value || "");
    const p2 = (document.getElementById("forgotConfirmPassword2")?.value || "");
    const err = document.getElementById("forgotError2");
    if (p1.length < 6) { if (err) { err.textContent = "密码至少 6 位"; err.classList.add("err"); } return; }
    if (p1 !== p2) { if (err) { err.textContent = "两次输入的密码不一致"; err.classList.add("err"); } return; }
    const btn = document.getElementById("btnForgotSubmit");
    if (btn) { btn.disabled = true; btn.classList.add("loading"); }
    try {
      const { error } = await supabase.auth.updateUser({ password: p1 });
      if (error) throw error;
      if (err) { err.textContent = "✅ 密码已重置，请用新密码登录"; err.classList.remove("err"); }
      setTimeout(() => {
        closeForgotModal();
        closeModal();
        openModal();
      }, 1500);
    } catch (e) {
      if (err) { err.textContent = "重置失败：" + (e.message || "请重试"); err.classList.add("err"); }
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
    }
  }

  function getToken() {
    return supabase?.auth.getSession().then(({ data }) => data.session?.access_token || null);
  }

  // ---------- 初始化 ----------
  function init() {
    if (!URL || !KEY || !window.supabase) {
      console.warn("Supabase 未配置或 SDK 未加载，认证功能不可用");
      return;
    }
    supabase = window.supabase.createClient(URL, KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });

    // 恢复会话
    supabase.auth.getSession().then(({ data }) => {
      user = data.session?.user || null;
      emit();
      renderAuthUI();
      maybePromptCompleteProfile();
    });

    // 监听状态变化（登录/登出/token 刷新）
    supabase.auth.onAuthStateChange((event, session) => {
      user = session?.user || null;
      emit();
      renderAuthUI();
      maybePromptCompleteProfile();
      // 密码重置回调：邮件链接带回 recovery token，自动进入设置新密码
      if (event === "PASSWORD_RECOVERY") {
        showForgotStep2();
      }
    });

    // 顶部栏按钮
    const btn = document.getElementById("btnAuth");
    if (btn) {
      btn.addEventListener("click", () => {
        if (user) signOut(); else openModal();
      });
    }
    const closeBtn = document.getElementById("btnAuthClose");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    const submit = document.getElementById("btnAuthSubmit");
    if (submit) submit.addEventListener("click", submitPassword);

    document.querySelectorAll(".auth-tab").forEach((t) => {
      t.addEventListener("click", () => setAuthMode(t.dataset.mode));
    });
    const ghBtn = document.getElementById("btnAuthGithub");
    if (ghBtn) ghBtn.addEventListener("click", () => oauth("github"));

    // 头像上传：先打开裁剪编辑器
    initAvatarCrop();

    // Enter 提交
    const passInput = document.getElementById("authPassword");
    if (passInput) passInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitPassword();
    });

    // 密码可见性切换
    const eyeBtn = document.getElementById("btnAuthEye");
    if (eyeBtn) eyeBtn.addEventListener("click", () => {
      const p = document.getElementById("authPassword");
      if (!p) return;
      p.type = p.type === "password" ? "text" : "password";
      eyeBtn.textContent = p.type === "password" ? "👁️" : "🙈";
    });

    // 确认密码：可见性切换 + 实时一致性校验
    const confirmInput = document.getElementById("authConfirmPassword");
    const confirmRow = document.getElementById("authConfirmRow");
    const eyeConfirm = document.getElementById("btnAuthEyeConfirm");
    if (eyeConfirm) eyeConfirm.addEventListener("click", () => {
      if (!confirmInput) return;
      confirmInput.type = confirmInput.type === "password" ? "text" : "password";
      eyeConfirm.textContent = confirmInput.type === "password" ? "👁️" : "🙈";
    });
    if (confirmInput && confirmRow) {
      const syncConfirm = () => {
        const p = document.getElementById("authPassword");
        if (!p) return;
        if (!confirmInput.value) {
          confirmRow.classList.remove("match", "mismatch");
          return;
        }
        const ok = confirmInput.value === p.value;
        confirmRow.classList.toggle("match", ok);
        confirmRow.classList.toggle("mismatch", !ok);
      };
      confirmInput.addEventListener("input", syncConfirm);
      if (passInput) passInput.addEventListener("input", syncConfirm);
    }

    // 邮箱格式实时校验
    const emailInput = document.getElementById("authEmail");
    const emailRow = document.getElementById("authEmailRow");
    if (emailInput && emailRow) {
      const syncEmail = () => {
        const val = emailInput.value.trim();
        if (!val) { emailRow.classList.remove("valid", "invalid"); return; }
        emailRow.classList.toggle("valid", isValidEmail(val));
        emailRow.classList.toggle("invalid", !isValidEmail(val));
      };
      emailInput.addEventListener("input", syncEmail);
      emailInput.addEventListener("blur", syncEmail);
    }

    // 点遮罩关闭
    const modal = document.getElementById("authModal");
    if (modal) modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    // 个人中心弹窗
    const btnProfileClose = document.getElementById("btnProfileClose");
    if (btnProfileClose) btnProfileClose.addEventListener("click", closeProfile);
    const profileModal = document.getElementById("profileModal");
    if (profileModal) profileModal.addEventListener("click", (e) => {
      if (e.target === profileModal) closeProfile();
    });

    // 我的作品弹窗
    const btnMyWorksClose = document.getElementById("btnMyWorksClose");
    if (btnMyWorksClose) btnMyWorksClose.addEventListener("click", closeMyWorks);
    const myWorksModal = document.getElementById("myWorksModal");
    if (myWorksModal) myWorksModal.addEventListener("click", (e) => {
      if (e.target === myWorksModal) closeMyWorks();
    });

    // 完善资料弹窗
    const cpClose = document.getElementById("btnCpClose");
    if (cpClose) cpClose.addEventListener("click", closeCompleteProfile);
    const cpSubmit = document.getElementById("btnCpSubmit");
    if (cpSubmit) cpSubmit.addEventListener("click", submitCompleteProfile);
    const cpModal = document.getElementById("completeProfileModal");
    if (cpModal) cpModal.addEventListener("click", (e) => {
      if (e.target === cpModal) closeCompleteProfile();
    });
    ["cpUsername", "cpEmail"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", refreshCpSubmit);
    });

    // 找回密码
    const forgotOpen = document.getElementById("btnForgotOpen");
    if (forgotOpen) forgotOpen.addEventListener("click", openForgotModal);
    const forgotClose = document.getElementById("btnForgotClose");
    if (forgotClose) forgotClose.addEventListener("click", closeForgotModal);
    const forgotSend = document.getElementById("btnForgotSend");
    if (forgotSend) forgotSend.addEventListener("click", sendResetEmail);
    const forgotBack = document.getElementById("btnForgotBack");
    if (forgotBack) forgotBack.addEventListener("click", () => { closeForgotModal(); openModal(); });
    const forgotSubmit = document.getElementById("btnForgotSubmit");
    if (forgotSubmit) forgotSubmit.addEventListener("click", submitNewPassword);
    const forgotModal = document.getElementById("forgotModal");
    if (forgotModal) forgotModal.addEventListener("click", (e) => {
      if (e.target === forgotModal) closeForgotModal();
    });
    // 密码可见性（找回密码弹窗）
    const forgotPwEye = document.getElementById("btnForgotPwEye");
    if (forgotPwEye) forgotPwEye.addEventListener("click", () => {
      const p = document.getElementById("forgotNewPassword");
      if (!p) return;
      p.type = p.type === "password" ? "text" : "password";
      forgotPwEye.textContent = p.type === "password" ? "👁️" : "🙈";
    });
  }

  // ---------- 对外 API ----------
  window.K5AUTH = {
    init,
    getUser: () => user,
    getUserId: () => user?.id || null,
    isLoggedIn: () => !!user,
    getToken,
    onAuth: (cb) => { callbacks.push(cb); },
    openModal,
    closeModal,
    signOut,
  };
})();
