/**
 * K6Web 评论功能 - 前端模块
 * 依赖：window.K5AUTH（auth.js）
 *       window.SUPABASE_URL（index.html 配置）
 * 暴露：window.K5COMMENTS
 */
(function () {
  "use strict";

  const FUNC_BASE = (window.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1";

  const $ = (id) => document.getElementById(id);

  // ---------- 工具函数 ----------
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function safeAvatarUrl(u) {
    return /^https?:\/\//i.test(u || "") ? u : "";
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    // 1分钟内
    if (diff < 60000) return "刚刚";
    // 1小时内
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    // 24小时内
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    // 30天内
    if (diff < 2592000000) return Math.floor(diff / 86400000) + " 天前";
    // 超过30天显示日期
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function anonHeaders() {
    const h = { Authorization: "Bearer " + (window.SUPABASE_PUBLISHABLE_KEY || "") };
    if (window.SUPABASE_PUBLISHABLE_KEY) h.apikey = window.SUPABASE_PUBLISHABLE_KEY;
    return h;
  }

  function authHeaders(token) {
    const h = {
      Authorization: "Bearer " + token,
      apikey: window.SUPABASE_PUBLISHABLE_KEY || "",
      "Content-Type": "application/json",
    };
    return h;
  }

  // ---------- 渲染单条评论 ----------
  function renderComment(comment, itemType, isReply = false) {
    const profiles = comment.profiles || {};
    const name = escapeHtml(profiles.username || "匿名");
    const avatar = safeAvatarUrl(profiles.avatar_url);
    const content = escapeHtml(comment.content);
    const time = fmtTime(comment.created_at);
    const likesCount = comment.likes_count || 0;
    const userHasLiked = comment.user_has_liked || false;
    const isLoggedIn = window.K5AUTH.isLoggedIn();
    const currentUserId = window.K5AUTH.getUserId ? window.K5AUTH.getUserId() : null;
    const isOwner = currentUserId === comment.user_id;
    const isAdmin = window.K5AUTH.isAdmin && window.K5AUTH.isAdmin();

    let avatarHtml;
    const profileLink = comment.user_id ? `href="public-profile.html?id=${encodeURIComponent(comment.user_id)}"` : "";
    if (avatar) {
      avatarHtml = `<img class="comment-avatar" src="${avatar}" alt="" loading="lazy">`;
    } else {
      avatarHtml = `<span class="comment-avatar-txt">${escapeHtml((profiles.username || "匿").charAt(0).toUpperCase())}</span>`;
    }

    // 删除按钮（作者或管理员可见）
    const deleteBtn = (isOwner || isAdmin)
      ? `<button class="comment-action" data-action="delete" data-comment-id="${comment.id}" title="删除">🗑️ 删除</button>`
      : "";

    // 点赞按钮
    const likeClass = userHasLiked ? "comment-action liked" : "comment-action";
    const likeBtn = `<button class="${likeClass}" data-action="like" data-comment-id="${comment.id}" title="点赞">👍 ${likesCount > 0 ? likesCount : ""}</button>`;

    // 回复按钮（非回复评论才显示）
    const replyBtn = !isReply
      ? `<button class="comment-action" data-action="reply" data-comment-id="${comment.id}" data-author="${name}">💬 回复</button>`
      : "";

    const html = `
      <div class="comment-item" data-id="${comment.id}">
        <div class="comment-header">
          <a class="comment-author-link" ${profileLink}>${avatarHtml}<span class="comment-author">${name}</span></a>
          <span class="comment-time">${time}</span>
        </div>
        <div class="comment-content">${content}</div>
        <div class="comment-actions">
          ${likeBtn}
          ${replyBtn}
          ${deleteBtn}
        </div>
      </div>
    `;
    return html;
  }

  // ---------- 渲染评论列表 ----------
  function renderCommentList(container, comments, itemType) {
    if (!container) return;

    if (!comments || comments.length === 0) {
      container.innerHTML = `<div class="comment-empty">暂无评论，快来发表第一条评论吧 💬</div>`;
      return;
    }

    let html = "";
    comments.forEach((comment) => {
      html += renderComment(comment, itemType, false);
      // 渲染回复
      if (comment.replies && comment.replies.length > 0) {
        html += `<div class="comment-replies">`;
        comment.replies.forEach((reply) => {
          html += renderComment(reply, itemType, true);
        });
        html += `</div>`;
      }
    });

    container.innerHTML = html;
  }

  // ---------- 渲染评论分页 ----------
  function renderPagination(container, total, page, pageSize, itemId, itemType, listContainerId) {
    const pages = Math.ceil(total / pageSize);
    if (pages <= 1) return;
    const pagHtml = `
      <div class="comment-pagination">
        <button class="ws-page-btn" data-cpage="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹ 上一页</button>
        <span class="ws-page-info">${page} / ${pages}</span>
        <button class="ws-page-btn" data-cpage="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页 ›</button>
      </div>`;
    container.insertAdjacentHTML("beforeend", pagHtml);
    container.querySelectorAll(".comment-pagination .ws-page-btn:not([disabled])").forEach((b) => {
      b.addEventListener("click", () => {
        loadComments(itemId, itemType, listContainerId, parseInt(b.dataset.cpage, 10));
      });
    });
  }

  // ---------- 加载评论 ----------
  async function loadComments(itemId, itemType, listContainerId, page = 1) {
    const container = $(listContainerId);
    if (!container) return;

    container.innerHTML = `<div class="comment-loading">加载中...</div>`;

    try {
      const params = new URLSearchParams({ item_id: itemId, item_type: itemType, page: String(page), page_size: "5" });
      // 如果已登录，带上用户 token 以便后端判断点赞状态和删除权限
      const headers = anonHeaders();
      if (window.K5AUTH && window.K5AUTH.isLoggedIn()) {
        const token = await window.K5AUTH.getToken();
        if (token) {
          headers.Authorization = "Bearer " + token;
        }
      }
      const resp = await fetch(`${FUNC_BASE}/list-comments?${params}`, { headers });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      renderCommentList(container, data.comments || [], itemType);
      renderPagination(container, data.total || 0, data.page || 1, data.page_size || 5, itemId, itemType, listContainerId);
    } catch (e) {
      container.innerHTML = `<div class="comment-empty">评论加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- 发表评论 ----------
  async function postComment(itemId, itemType, content, parentId = null, successCallback) {
    const token = await window.K5AUTH.getToken();
    if (!token) {
      window.K5AUTH.openModal();
      return;
    }

    const trimmedContent = (content || "").trim();
    if (!trimmedContent) {
      alert("请输入评论内容");
      return false;
    }
    if (trimmedContent.length > 1000) {
      alert("评论内容不能超过 1000 字");
      return false;
    }

    try {
      const resp = await fetch(`${FUNC_BASE}/post-comment`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          item_id: itemId,
          item_type: itemType,
          content: trimmedContent,
          parent_id: parentId,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "发表失败");

      if (successCallback) successCallback(data.comment);
      return true;
    } catch (e) {
      alert("发表失败：" + e.message);
      return false;
    }
  }

  // ---------- 删除评论 ----------
  async function deleteComment(commentId, successCallback) {
    if (!confirm("确定要删除这条评论吗？")) return;

    const token = await window.K5AUTH.getToken();
    if (!token) {
      window.K5AUTH.openModal();
      return;
    }

    try {
      const resp = await fetch(`${FUNC_BASE}/delete-comment`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ comment_id: commentId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "删除失败");

      if (successCallback) successCallback(commentId);
      return true;
    } catch (e) {
      alert("删除失败：" + e.message);
      return false;
    }
  }

  // ---------- 点赞/取消点赞 ----------
  async function toggleLike(commentId, likeBtn) {
    const token = await window.K5AUTH.getToken();
    if (!token) {
      window.K5AUTH.openModal();
      return;
    }

    try {
      const resp = await fetch(`${FUNC_BASE}/toggle-like`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ comment_id: commentId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "操作失败");

      // 更新按钮状态
      if (likeBtn) {
        likeBtn.classList.toggle("liked", data.liked);
        likeBtn.innerHTML = `👍 ${data.likes_count > 0 ? data.likes_count : ""}`;
      }
    } catch (e) {
      alert("操作失败：" + e.message);
    }
  }

  // ---------- 初始化评论区事件 ----------
  function initCommentsSection(config) {
    const {
      inputId,
      submitBtnId,
      listContainerId,
      itemType,
    } = config;

    const input = $(inputId);
    const submitBtn = $(submitBtnId);
    const listContainer = $(listContainerId);

    if (!input || !submitBtn) return { setItemId() {} };

    // 当前评论区的 itemId（动态设置）
    let currentItemId = config.itemId || null;
    // 当前回复的父评论 ID（null = 顶级评论）
    let replyingToId = null;
    let replyingToAuthor = "";

    // 输入框事件
    function refreshSubmitBtn() {
      const isLoggedIn = window.K5AUTH.isLoggedIn();
      const hasContent = input.value.trim().length > 0;
      submitBtn.disabled = !(isLoggedIn && hasContent);
      if (!isLoggedIn) {
        submitBtn.textContent = "🔒 登录后评论";
      } else if (replyingToId) {
        submitBtn.textContent = "回复 " + replyingToAuthor;
      } else {
        submitBtn.textContent = "发表";
      }
    }

    // 取消回复状态
    function cancelReply() {
      replyingToId = null;
      replyingToAuthor = "";
      input.placeholder = "发表评论...";
      refreshSubmitBtn();
    }

    input.addEventListener("input", refreshSubmitBtn);
    input.addEventListener("blur", () => {
      // 如果输入框为空，自动取消回复状态
      if (!input.value.trim()) cancelReply();
    });
    window.K5AUTH.onAuth(() => refreshSubmitBtn());
    refreshSubmitBtn();

    // 提交评论
    submitBtn.addEventListener("click", async () => {
      if (!window.K5AUTH.isLoggedIn()) {
        window.K5AUTH.openModal();
        return;
      }
      if (!currentItemId) return;

      submitBtn.disabled = true;
      submitBtn.textContent = "发表中...";

      const success = await postComment(
        currentItemId,
        itemType,
        input.value,
        replyingToId,
        () => {
          input.value = "";
          cancelReply();
          loadComments(currentItemId, itemType, listContainerId);
        }
      );

      refreshSubmitBtn();
    });

    // 评论列表事件委托（点赞、删除、回复）
    if (listContainer) {
      listContainer.addEventListener("click", async (e) => {
        const actionBtn = e.target.closest("[data-action]");
        if (!actionBtn) return;

        const action = actionBtn.dataset.action;
        const commentId = actionBtn.dataset.commentId;

        if (action === "like") {
          await toggleLike(commentId, actionBtn);
        } else if (action === "delete") {
          await deleteComment(commentId, () => {
            loadComments(currentItemId, itemType, listContainerId);
          });
        } else if (action === "reply") {
          // 设置回复状态
          replyingToId = commentId;
          replyingToAuthor = actionBtn.dataset.author || "";
          input.focus();
          input.value = "";
          input.placeholder = "回复 " + replyingToAuthor + "...";
          input.scrollIntoView({ behavior: "smooth", block: "center" });
          refreshSubmitBtn();
        }
      });
    }

    // 返回控制接口
    return {
      setItemId(id) {
        currentItemId = id;
      },
    };
  }

  // ---------- 公开接口 ----------
  window.K5COMMENTS = {
    init: initCommentsSection,
    load: loadComments,
    post: postComment,
    delete: deleteComment,
    toggleLike: toggleLike,
    renderList: renderCommentList,
  };
})();
