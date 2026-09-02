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
          ? `<img class="user-avatar user-avatar-btn" src="${avatar}" alt="头像" title="点击更换头像">`
          : `<span class="user-avatar user-avatar-txt user-avatar-btn" title="点击更换头像">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
        const dropdownAvatar = avatar
          ? `<img class="user-dropdown-avatar" src="${avatar}" alt="">`
          : `<span class="user-dropdown-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
        badge.innerHTML = avatarHtml + `<span class="user-name">${escapeHtml(name)}</span>`
          + `<div class="user-dropdown">
               <div class="user-dropdown-head">
                 ${dropdownAvatar}
                 <div><div class="user-dropdown-name">${escapeHtml(name)}</div><div class="user-dropdown-email">${escapeHtml(user.email || "")}</div></div>
               </div>
               <div class="user-dropdown-item" id="menuProfile">👤 个人中心</div>
             </div>`;
        badge.style.display = "inline-flex";
        bindAvatarClick();
        document.getElementById("menuProfile")?.addEventListener("click", openProfile);
      }
      btn.textContent = "登出";
      btn.classList.add("secondary");
    } else {
      if (badge) { badge.style.display = "none"; badge.innerHTML = ""; }
      btn.textContent = "登录";
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
      ? `<img class="user-dropdown-avatar" src="${avatar}" alt="">`
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

  async function uploadAvatar(file) {
    const ALLOWED = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!file || !ALLOWED.includes(file.type)) {
      setAuthError("仅支持 JPG/PNG/GIF/WebP 格式"); openModal(); return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAuthError("头像图片不能超过 2MB"); openModal(); return;
    }
    const token = await getToken();
    if (!token) { setAuthError("登录状态已失效，请重新登录"); openModal(); return; }

    const fd = new FormData();
    fd.append("file", file);

    try {
      const resp = await fetch(URL + "/functions/v1/upload-avatar", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: fd,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);

      // 同步到 auth user_metadata，触发 onAuthStateChange 自动刷新 UI
      const { error: upErr } = await supabase.auth.updateUser({
        data: { avatar_url: data.avatar_url },
      });
      if (upErr) throw upErr;
    } catch (e) {
      setAuthError("头像上传失败：" + (e.message || "请重试"));
      openModal();
    }
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
    if (submit) submit.textContent = isLogin ? "登录" : "注册";
    document.querySelectorAll(".auth-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.mode === mode);
    });
    if (email) email.placeholder = isLogin ? "邮箱" : "注册邮箱（将发送验证邮件）";
    if (usernameRow) usernameRow.style.display = isLogin ? "none" : "";
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
    return /^[a-zA-Z0-9_]{2,20}$/.test(s);
  }

  async function submitPassword() {
    clearAuthError();
    const email = document.getElementById("authEmail").value.trim();
    const pass = document.getElementById("authPassword").value;
    const username = (document.getElementById("authUsername")?.value || "").trim();
    if (!email || !pass) { setAuthError("请填写邮箱和密码"); return; }
    const mode = getMode();
    if (mode === "register") {
      if (!isValidUsername(username)) { setAuthError("用户名需 2-20 字符，仅字母/数字/下划线"); return; }
      if (pass.length < 6) { setAuthError("密码至少 6 位"); return; }
    }
    try {
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
    });

    // 监听状态变化（登录/登出/token 刷新）
    supabase.auth.onAuthStateChange((_event, session) => {
      user = session?.user || null;
      emit();
      renderAuthUI();
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

    // 头像上传：隐藏的 file input
    const avatarInput = document.getElementById("avatarInput");
    if (avatarInput) avatarInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) uploadAvatar(f);
      e.target.value = "";
    });

    // Enter 提交
    const passInput = document.getElementById("authPassword");
    if (passInput) passInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitPassword();
    });

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
  }

  // ---------- 对外 API ----------
  window.K5AUTH = {
    init,
    getUser: () => user,
    isLoggedIn: () => !!user,
    getToken,
    onAuth: (cb) => { callbacks.push(cb); },
    openModal,
    closeModal,
    signOut,
  };
})();
