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
      const CAT_ICON = { theme: "🎨", channel: "📋", extension: "⚙️", other: "📦" };
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
    return /^[a-zA-Z0-9_]{2,20}$/.test(s);
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
      if (!isValidUsername(username)) { setAuthError("用户名需 2-20 字符，仅字母/数字/下划线"); return; }
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
      if (err) err.textContent = "用户名需 2-20 字符，仅字母/数字/下划线";
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
    supabase.auth.onAuthStateChange((_event, session) => {
      user = session?.user || null;
      emit();
      renderAuthUI();
      maybePromptCompleteProfile();
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
