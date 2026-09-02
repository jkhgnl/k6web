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
        badge.innerHTML =
          (avatar ? `<img class="user-avatar" src="${avatar}" alt="">` : `<span class="user-avatar user-avatar-txt">${escapeHtml(name.charAt(0).toUpperCase())}</span>`)
          + `<span class="user-name">${escapeHtml(name)}</span>`;
        badge.style.display = "inline-flex";
      }
      btn.textContent = "登出";
      btn.classList.add("secondary");
    } else {
      if (badge) badge.style.display = "none";
      btn.textContent = "登录";
      btn.classList.remove("secondary");
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
    if (submit) submit.textContent = isLogin ? "登录" : "注册";
    document.querySelectorAll(".auth-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.mode === mode);
    });
    if (email) email.placeholder = isLogin ? "邮箱" : "注册邮箱（将发送验证邮件）";
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

  async function submitPassword() {
    clearAuthError();
    const email = document.getElementById("authEmail").value.trim();
    const pass = document.getElementById("authPassword").value;
    if (!email || !pass) { setAuthError("请填写邮箱和密码"); return; }
    if (getMode() === "register" && pass.length < 6) {
      setAuthError("密码至少 6 位"); return;
    }
    try {
      const { error } = getMode() === "register"
        ? await supabase.auth.signUp({ email, password: pass })
        : await supabase.auth.signInWithPassword({ email, password: pass });
      if (error) { setAuthError(error.message); return; }
      if (getMode() === "register") {
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
    document.getElementById("btnAuthGithub").addEventListener("click", () => oauth("github"));
    document.getElementById("btnAuthGoogle").addEventListener("click", () => oauth("google"));

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
  }

  // ---------- 对外 API ----------
  window.K5AUTH = {
    init,
    getUser: () => user,
    isLoggedIn: () => !!user,
    getToken: () => supabase?.auth.getSession().then(({ data }) => data.session?.access_token || null),
    onAuth: (cb) => { callbacks.push(cb); },
    openModal,
    closeModal,
    signOut,
  };
})();
