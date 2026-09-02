/**
 * F4HWN 多普勒星历写入工具 - 浏览器逻辑（普通 script，file:// 可用）
 * 依赖：window.satellite（vendor/satellite.min.js UMD）
 *       window.K5WEB.protocol（protocol.js UMD）
 *       window.K5WEB.calc（calc.js UMD）
 *
 * GitHub Pages 版本：移除 C++ 后端依赖，远程固件/更新等功能直接 fetch Gitee API。
 */
(function () {
  "use strict";

  const K5WEB_VERSION = "1.9.0";
  window.K5WEB_VERSION = K5WEB_VERSION;

  // GitHub Pages 模式：检测是否运行在无后端的静态托管环境（含自定义域名）
  const IS_GITHUB_PAGES = !window.location.port || window.location.port === "443" || window.location.port === ""
    || window.location.hostname.endsWith(".github.io")
    || window.location.hostname === "jkhgnl.top";
  // Cloudflare Worker 代理地址：用于绕过 Gitee raw 文件的 CORS 限制，实现固件一键下载
  // 部署 cloudflare-worker.js 后，把你的 Worker URL 填到这里
  const WORKER_PROXY_URL = "https://cors.jkhgnl.top";

  // GPS 扫码中转 Worker：手机扫码后通过此 Worker 上报 GPS 到网页
  const GPS_WORKER_URL = "https://gps.jkhgnl.top";

  // TLE + 频率 Redis 缓存 Worker：共享缓存，减少重复抓取
  const TLE_WORKER_URL = "https://tle.jkhgnl.top";

  const proto = window.K5WEB.protocol;
  const calc = window.K5WEB.calc;
  const gb = window.K5WEB && window.K5WEB.gb2312;
  const $ = (id) => document.getElementById(id);

  let port = null;
  let reader = null;
  let writer = null;
  let replyQueue = [];
  let passData = null; // findPass 结果
  let selectedSlot = 0; // 当前选中的槽位 (0-3)
  const slotNames = ["", "", "", ""]; // 缓存四个槽位的名称

  const log = (msg, cls) => {
    const line = (cls ? `[${cls}] ` : "") + msg;
    console.log(line);
    const el = $("log");
    if (el) { el.textContent += line + "\n"; el.scrollTop = el.scrollHeight; }
  };
  const setStatus = (msg, cls) => {
    const el = $("status");
    el.className = "top-status " + (cls || "info");
    el.textContent = msg;
  };

  // ---------- 选项卡切换（由 index.html 内联脚本统一处理） ----------

  // ---------- 自动获取 TLE ----------
  // 常见 FM 卫星频率表（上行/下行 MHz）——手工精选优先于 SatNOGS，
  // SatNOGS 频率库兜底覆盖其余卫星（选星时自动填频率）
  const KNOWN_SATS = {
    "iss": [145.99, 437.8], "international space station": [145.99, 437.8],
    "ao-91": [145.96, 435.25], "ao-92": [145.88, 435.35],
    "fo-29": [145.9, 435.3], "so-50": [145.85, 436.795],
    "po-101": [145.9, 436.5], "cas-4b": [145.925, 436.875],
    "ao-7": [145.85, 432.1], "rs-44": [145.9, 435.6],
    "to-108": [145.88, 436.62], "lilacsat-2": [145.9, 437.2],
    "io-117": [145.9, 436.5], "uvsqsat": [145.94, 436.88],
    "cas-4a": [145.925, 436.875], "ao-73": [145.95, 435.14],
    "ao-109": [145.9, 435.6],
    "sakhacube": [437.35, 437.35], "cholbon": [437.35, 437.35],
    "qmr-kwt": [145.92, 436.95],
    "ao-95": [435.3, 145.92], "fox-1cliff": [435.3, 145.92],
    "ao-27": [145.85, 436.795],
    "rs18s": [437.35, 437.35],
    "rs38s": [437.825, 437.825], "vizard-meteo": [437.825, 437.825],
    "rs40s": [437.625, 437.625], "umka-1": [437.625, 437.625],
    "rs58s": [435.29, 435.29], "monitor-3": [435.29, 435.29],
    "rs95s": [145.92, 436.95],
  };
  let satList = [];

  // ---------- 卫星收藏（localStorage） ----------
  const FAV_KEY = "k5web_favorites_v1";
  let favorites = []; // NORAD ID 数组

  function loadFavorites() {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      favorites = raw ? JSON.parse(raw) : [];
    } catch (_) { favorites = []; }
  }
  function saveFavorites() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch (_) {}
  }
  function isFav(norad) { return favorites.indexOf(norad) >= 0; }
  function toggleFav(norad) {
    const i = favorites.indexOf(norad);
    if (i >= 0) favorites.splice(i, 1); else favorites.push(norad);
    saveFavorites();
  }

  // ---------- TLE 本地缓存（localStorage，增量获取） ----------
  // 已获取的 TLE 持久化到浏览器本地，点击获取时先秒开缓存、后台增量刷新，
  // 网络失败时回退缓存。条目结构 { name, tle1, tle2, fetchedAt }，按 NORAD 编号比对。
  const TLE_CACHE_KEY = "k5web_tle_cache_v1";
  const TLE_CACHE_MAX_AGE_MS = 12 * 3600 * 1000; // 缓存视为"新鲜"的时限（补充星跳过网络）

  function loadTleCache() {
    try {
      const raw = localStorage.getItem(TLE_CACHE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (e) {
      log("TLE 缓存读取失败：" + e.message, "err");
      return [];
    }
  }

  function saveTleCache(entries) {
    try {
      localStorage.setItem(TLE_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), entries }));
    } catch (e) {
      log("TLE 缓存写入失败：" + e.message, "err"); // 隐私模式等场景仅提示，不影响使用
    }
  }

  function tleCacheSavedAt() {
    try {
      const raw = localStorage.getItem(TLE_CACHE_KEY);
      if (!raw) return null;
      const savedAt = JSON.parse(raw).savedAt;
      return typeof savedAt === "number" ? savedAt : null;
    } catch (e) {
      return null;
    }
  }

  function tleCacheAge() {
    const savedAt = tleCacheSavedAt();
    if (savedAt == null) return null;
    const mins = Math.round((Date.now() - savedAt) / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return mins + " 分钟前";
    if (mins < 1440) return Math.round(mins / 60) + " 小时前";
    return Math.round(mins / 1440) + " 天前";
  }

  // ---------- 卫星频率库（SatNOGS，localStorage 永久缓存） ----------
  // 卫星发射后频率基本不变，缓存不过期；点"获取 TLE"时顺便后台刷新
  // （新发射的星/数据修正自动进来），获取失败沿用旧缓存（反正频率不变）。
  // 缓存结构 { savedAt, map: { noradId: { up, down, mode, type, desc } } }
  const FREQ_CACHE_KEY = "k5web_freq_cache_v1";
  const FREQ_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 天
  let freqMap = {}; // NORAD -> { up, down, mode, type, desc }（Hz）

  function loadFreqCache() {
    try {
      const raw = localStorage.getItem(FREQ_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.map || typeof parsed.map !== "object") return null;
      if (parsed.savedAt && Date.now() - parsed.savedAt > FREQ_CACHE_MAX_AGE_MS) return null;
      return parsed;
    } catch (e) {
      log("频率库缓存读取失败：" + e.message, "err");
      return null;
    }
  }

  function saveFreqCache(map) {
    try {
      localStorage.setItem(FREQ_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), map }));
    } catch (e) {
      log("频率库缓存写入失败：" + e.message, "err");
    }
  }

  // 从 SatNOGS 拉取全部发射机条目并构建 NORAD -> 最优条目映射
  async function fetchFreqDB() {
    const resp = await fetch("https://db.satnogs.org/api/transmitters/?format=json&status=active");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const transmitters = await resp.json();
    const map = calc.buildFreqMap(transmitters);
    freqMap = map;
    saveFreqCache(map);
    log(`频率库已更新：${transmitters.length} 条发射机，覆盖 ${Object.keys(map).length} 颗卫星`);
    return map;
  }

  // 读取频率库数据：优先级 localStorage 缓存（动态刷新的最新）> 内置 freqdb.js（静态打包）。
  // 卫星频率基本不变，内置数据作为零网络依赖的兜底（SatNOGS 无 CORS 时也能用）。
  function loadFreqData() {
    const cached = loadFreqCache();
    if (cached) return { map: cached.map, source: "本地缓存" };
    const builtin = (window.K5WEB && window.K5WEB.freqdb) || null;
    if (builtin && Object.keys(builtin).length) return { map: builtin, source: "内置数据" };
    return null;
  }

  // 确保频率库可用：有数据就用（频率基本不变，不过期）；
  // refresh=true（点"获取 TLE"）时后台联网刷新，失败静默沿用缓存/内置
  async function ensureFreqDB(refresh = false) {
    const data = loadFreqData();
    if (data) freqMap = data.map;
    if (!refresh && data) return; // 有数据且不要求刷新：直接用
    // 优先从 Redis Worker 获取频率（全站共享）
    if (IS_GITHUB_PAGES) {
      try {
        const resp = await fetch(TLE_WORKER_URL + "/freq");
        if (resp.ok) {
          const d = await resp.json();
          if (d.ok && d.map && Object.keys(d.map).length > 0) {
            freqMap = d.map;
            saveFreqCache(d.map);
            log(`频率库从 Redis 获取：覆盖 ${Object.keys(d.map).length} 颗卫星`);
            return;
          }
        }
      } catch (_) {}
    }
    try {
      await fetchFreqDB();
    } catch (e) {
      // 有数据（缓存/内置）时失败静默；完全没有数据才提示
      if (!data) log(`频率库获取失败：${e.message}（选星将仅用内置预设）`, "err");
    }
  }

  // 缓存是否在新鲜期内（≤12h）：新鲜可直接秒开，过期必须联网强制刷新
  function tleCacheFresh() {
    const savedAt = tleCacheSavedAt();
    return savedAt != null && Date.now() - savedAt <= TLE_CACHE_MAX_AGE_MS;
  }

  // 联网全量刷新：并发拉取全部渠道（含 Celestrak active 全量），补充星（缓存新鲜则跳过），
  // 按 NORAD 合并只更新变化的。成功返回 { list, updated }，网络失败抛异常。
  async function refreshTleFromNetwork(cache) {
    const { sats: fresh, fromRedis } = await fetchTLE();
    // Redis 缓存已是全量数据，无需补星；直连源才需要逐个补
    const extra = fromRedis ? [] : await fetchExtraSats(cache);
    for (const s of fresh) s.fetchedAt = Date.now();
    const { list, updated } = calc.mergeTleList(cache, fresh.concat(extra));
    satList = list;
    saveTleCache(list);
    return { list, updated };
  }

  // amateur.tle 尚未收录的新业余卫星，按 NORAD 编号从 Celestrak 全库补充（CORS 开放）。
  // Celestrak TLE 的名称行截断到 24 字符（如 "(RS18S)" 会变成 "(RS1*"），所以用 name 覆盖成完整名。
  const EXTRA_CATNR = [
    { id: 67290, name: "SAKHACUBE-CHOLBON (RS18S)" },
    { id: 67284, name: "LOBACHEVSKY (RS83S)" },
    { id: 67287, name: "LUCA (RS90S)" },
    { id: 67291, name: "QMR-KWT-2 (RS95S)" },
    { id: 67293, name: "SCORPION (RS89S)" },
  ];

  async function fetchExtraSats(cachedList) {
    // 增量：补充星（不在 amateur.tle 里）缓存命中且未过期时跳过网络请求
    const cachedById = new Map(cachedList.map((s) => [calc.noradId(s.tle1), s]));
    const results = await Promise.all(EXTRA_CATNR.map(async ({ id, name }) => {
      const idStr = String(id).padStart(5, "0");
      const hit = cachedById.get(idStr);
      if (hit && Date.now() - (hit.fetchedAt || 0) < TLE_CACHE_MAX_AGE_MS) {
        return [hit]; // 缓存新鲜，直接用
      }
      try {
        const resp = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=tle`);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const sats = parseTLE(await resp.text());
        if (sats[0]) {
          sats[0].name = name;
          sats[0].fetchedAt = Date.now();
        }
        return sats;
      } catch (e) {
        log(`补充星历 ${name} 获取失败：${e.message}`);
        return [];
      }
    }));
    return results.flat();
  }

  function selectSat(name) {
    const sel = $("satSelect");
    const s = satList.find((x) => x.name === name);
    if (!s) return;
    sel.value = s.name;
    $("tle").value = s.tle1 + "\n" + s.tle2;
    const key = s.name.toLowerCase();
    let freqFound = false;
    let freqSource = "";
    // 1. 内置手工预设（FM 转发器精选，最准）
    for (const [k, v] of Object.entries(KNOWN_SATS)) {
      if (key.includes(k)) {
        $("fUp").value = v[0];
        $("fDown").value = v[1];
        freqFound = true;
        freqSource = "内置预设";
        break;
      }
    }
    // 2. SatNOGS 频率库（联网/缓存，覆盖全部业余星，首选 FM 转发器条目）
    if (!freqFound) {
      const f = freqMap[calc.noradId(s.tle1)];
      if (f && f.up && f.down) {
        $("fUp").value = (f.up / 1e6).toFixed(6);
        $("fDown").value = (f.down / 1e6).toFixed(6);
        freqFound = true;
        freqSource = `SatNOGS ${f.mode || f.type}${f.type === "Transmitter" ? "（纯下行，上行=下行）" : ""}`;
      }
    }
    // 3. 无数据：醒目警告（防止残留默认值算出错误频率的星历）
    if (freqFound) {
      log(`已选 ${s.name.trim()}：TLE 已填充，频率来自${freqSource}`);
      setStatus(`已选 ${s.name.trim()}，频率已自动填入（${freqSource}）`, "ok");
    } else {
      setStatus(`⚠️ ${s.name.trim()} 没有自动频率数据，请手动填写上行/下行频率后再计算！`, "err");
      log(`已选 ${s.name.trim()}：TLE 已填充，⚠️ 内置预设与 SatNOGS 均无频率数据，请手动填写`);
    }
  }

  // ---------- 卫星模糊搜索下拉（输入即过滤，支持键盘导航） ----------
  const satCombo = { items: [], active: -1 };

  function satNorad(s) {
    return s.tle1.substring(2, 7).trim();
  }

  // 评分：名称前缀最佳，子串次之（越靠前越好），NORAD 编号再次，子序列模糊兜底
  function satScore(s, q) {
    const name = s.name.trim().toLowerCase();
    if (name.startsWith(q)) return 0;
    const idx = name.indexOf(q);
    if (idx > 0) return 1 + idx / 100;
    if (satNorad(s).startsWith(q)) return 2;
    let i = 0;
    for (const ch of name) if (ch === q[i]) i++;
    return i >= q.length ? 3 : Infinity;
  }

  function renderSatItem(s, q) {
    const div = document.createElement("div");
    div.className = "sat-item";
    const name = s.name.trim();
    const idx = q ? name.toLowerCase().indexOf(q) : -1;
    const span = document.createElement("span");
    if (idx >= 0) {
      span.append(name.slice(0, idx));
      const m = document.createElement("mark");
      m.textContent = name.substr(idx, q.length);
      span.append(m, name.slice(idx + q.length));
    } else {
      span.textContent = name;
    }
    const id = document.createElement("span");
    id.className = "norad";
    id.textContent = "#" + satNorad(s);
    const fav = document.createElement("span");
    fav.className = "sat-fav" + (isFav(satNorad(s)) ? " active" : "");
    fav.textContent = isFav(satNorad(s)) ? "★" : "☆";
    fav.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      toggleFav(satNorad(s));
      renderSatDropdown();
    });
    div.append(span, id, fav);
    return div;
  }

  function setActiveSat(i) {
    satCombo.active = i;
    const els = $("satDropdown").querySelectorAll(".sat-item");
    els.forEach((el, j) => el.classList.toggle("active", j === i));
    if (els[i]) els[i].scrollIntoView({ block: "nearest" });
  }

  function renderSatDropdown() {
    const dd = $("satDropdown");
    const q = $("satSelect").value.trim().toLowerCase();
    const MAX_SHOW = 80;
    let matched;
    if (!q) {
      // 无搜索词：收藏卫星排最前，其余按原序
      const favs = satList.filter((s) => isFav(satNorad(s)));
      const rest = satList.filter((s) => !isFav(satNorad(s)));
      matched = [...favs.map((s) => ({ s })), ...rest.map((s) => ({ s }))];
    } else {
      matched = satList
        .map((s) => {
          let score = satScore(s, q);
          if (score !== Infinity && isFav(satNorad(s))) score -= 0.5;
          return { s, score };
        })
        .filter((x) => x.score !== Infinity)
        .sort((a, b) => a.score - b.score);
    }
    dd.innerHTML = "";
    if (!matched.length) {
      dd.innerHTML = '<div class="sat-empty">无匹配卫星</div>';
      satCombo.items = [];
    } else {
      satCombo.items = matched.slice(0, MAX_SHOW).map((x) => x.s);
      let lastFav = -1;
      satCombo.items.forEach((s, i) => {
        const el = renderSatItem(s, q);
        el.addEventListener("mousedown", (e) => { e.preventDefault(); pickSat(i); });
        el.addEventListener("mouseover", () => setActiveSat(i));
        dd.appendChild(el);
        // 在收藏与普通卫星之间插入分隔线
        if (!q && i === satCombo.items.length - 1) {
          lastFav = i;
        }
      });
      // 插入分隔线：找到最后一个收藏项的位置
      if (!q) {
        let lastFavIdx = -1;
        satCombo.items.forEach((s, i) => { if (isFav(satNorad(s))) lastFavIdx = i; });
        if (lastFavIdx >= 0 && lastFavIdx < satCombo.items.length - 1) {
          const sep = document.createElement("div");
          sep.className = "sat-separator";
          const els = dd.querySelectorAll(".sat-item");
          if (els[lastFavIdx + 1]) {
            dd.insertBefore(sep, els[lastFavIdx + 1]);
          }
        }
      }
      if (matched.length > MAX_SHOW) {
        const more = document.createElement("div");
        more.className = "sat-empty";
        more.textContent = `…共 ${matched.length} 颗匹配，继续输入缩小范围`;
        dd.appendChild(more);
      }
    }
    setActiveSat(satCombo.items.length ? 0 : -1);
  }

  function openSatDropdown() {
    if ($("satSelect").disabled) return;
    renderSatDropdown();
    $("satDropdown").hidden = false;
  }

  function closeSatDropdown() {
    $("satDropdown").hidden = true;
    satCombo.active = -1;
  }

  function pickSat(i) {
    const s = satCombo.items[i];
    if (!s) return;
    closeSatDropdown();
    selectSat(s.name);
  }

  {
    const input = $("satSelect");
    input.addEventListener("focus", openSatDropdown);
    input.addEventListener("input", openSatDropdown);
    input.addEventListener("blur", closeSatDropdown);
    input.addEventListener("keydown", (e) => {
      const dd = $("satDropdown");
      if (dd.hidden) {
        if (e.key === "ArrowDown") { openSatDropdown(); e.preventDefault(); }
        return;
      }
      if (e.key === "ArrowDown") { setActiveSat(Math.min(satCombo.active + 1, satCombo.items.length - 1)); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setActiveSat(Math.max(satCombo.active - 1, 0)); e.preventDefault(); }
      else if (e.key === "Enter" && satCombo.active >= 0) { pickSat(satCombo.active); e.preventDefault(); }
      else if (e.key === "Escape") closeSatDropdown();
    });
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".sat-combo")) closeSatDropdown();
    });
  }

  function parseTLE(text) {
    const lines = text.split(/\r?\n/);
    const sats = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
      // SatNOGS 3LE 的名称行以 "0 " 开头（如 "0 ISS (ZARYA)"），去掉前缀，其他源不受影响
      const name = lines[i].replace(/^0\s+/, "").trim();
      if (name && lines[i + 1].startsWith("1 ") && lines[i + 2].startsWith("2 ")) {
        sats.push({ name, tle1: lines[i + 1], tle2: lines[i + 2] });
      }
    }
    return sats;
  }

  // 多源 TLE 获取（Look4Sat 同款渠道 + 本地镜像），点"获取 TLE"时全部并发拉取。
  // 各源独立容错：CORS 不通/超时/解析失败/被节流自动跳过并记日志，不影响其他源。
  const TLE_SOURCES = [
    // 本地业余镜像（小、快）
    { name: "Celestrak amateur(镜像1)", url: "https://api.github.com/repos/satvisorcom/satvisor-data/contents/celestrak/tle/amateur.tle", headers: { Accept: "application/vnd.github.raw+json" } },
    { name: "Celestrak amateur(镜像2)", url: "https://cdn.jsdelivr.net/gh/satvisorcom/satvisor-data@master/celestrak/tle/amateur.tle", headers: {} },
    // Look4Sat 默认渠道（按 Look4Sat Sources.kt 顺序）：
    // mmccants.org/tles/classfd.zip 为 zip 压缩，浏览器无法直接解压，已跳过
    { name: "Celestrak active 全量", url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle" },
    // 镜像兜底：直连被节流（同一 IP 2h 内重复下载返回提示文本而非数据）或网络不通时使用；
    // 数据可能旧几天，合并时 epoch 保护不会降级缓存里的新数据
    { name: "Celestrak active(镜像)", url: "https://cdn.jsdelivr.net/gh/satvisorcom/satvisor-data@master/celestrak/tle/active.tle" },
    { name: "SatNOGS 数据库", url: "https://db.satnogs.org/api/tle/?format=3le" },
    { name: "AMSAT nasabare", url: "https://www.amsat.org/tle/current/nasabare.txt" },
    { name: "R4UAB satonline", url: "https://r4uab.ru/satonline.txt" },
    { name: "ARISS ISS", url: "https://live.ariss.org/iss.txt" },
  ];

  async function fetchTLE() {
    // 优先走 Redis 缓存 Worker（全站共享，减少重复抓取）
    if (IS_GITHUB_PAGES) {
      try {
        const resp = await fetch(TLE_WORKER_URL + "/tle");
        if (resp.ok) {
          const data = await resp.json();
          if (data.ok && data.sats && data.sats.length > 0) {
            log(`TLE 从 Redis 缓存获取：${data.sats.length} 颗（来源：${data.source}）`);
            return { sats: data.sats.map((s) => ({ name: s.name, tle1: s.tle1, tle2: s.tle2 })), fromRedis: true };
          }
        }
      } catch (e) {
        log("TLE Redis 缓存不可用：" + e.message + "，回退直连源", "info");
      }
    }
    // 回退：直连各 TLE 源
    const results = await Promise.all(TLE_SOURCES.map(async (src) => {
      try {
        const resp = await fetch(src.url, { headers: src.headers || {} });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const sats = parseTLE(await resp.text());
        if (sats.length === 0) throw new Error("解析为空");
        return { name: src.name, sats };
      } catch (e) {
        log(`TLE 源 ${src.name} 失败：${e.message}`);
        return null;
      }
    }));
    const ok = results.filter(Boolean);
    if (ok.length === 0) throw new Error("所有 TLE 源均不可用");
    const list = calc.mergeSatelliteSources(ok);
    log(`TLE 多源获取成功：${ok.length}/${TLE_SOURCES.length} 个源，共 ${list.length} 颗（${ok.map((r) => r.name + ":" + r.sats.length).join("，")}）`);
    return { sats: list, fromRedis: false };
  }

  $("btnFetch").addEventListener("click", async () => {
    const btn = $("btnFetch");
    const input = $("satSelect");
    const cache = loadTleCache();
    const cacheAge = tleCacheAge();
    const cacheFresh = tleCacheFresh();

    // 1. 有缓存先秒开（立即可用），同时后台并发拉取全部渠道（含 active 全量）
    if (cache.length && cacheFresh) {
      satList = cache;
      input.disabled = false;
      input.value = "";
      input.placeholder = `缓存 ${satList.length} 颗（${cacheAge}），正在获取全部渠道…`;
      renderSatDropdown();
    } else if (cache.length) {
      log(`缓存已超过 12 小时（${cacheAge}），本次强制联网获取最新 TLE`);
    }

    btn.disabled = true;
    btn.textContent = "获取中...";
    try {
      // 总是全量多源拉取（Look4Sat 全渠道），完成后合并更新
      const { list, updated } = await refreshTleFromNetwork(cache);
      // 顺带后台刷新频率库（选星自动填频率；获取失败静默沿用旧缓存，频率基本不变）
      await ensureFreqDB(true);
      input.disabled = false;
      input.value = "";
      input.placeholder = `输入关键字搜索 ${list.length} 颗卫星（名称 / NORAD 编号）`;
      setStatus(
        updated > 0
          ? `✅ TLE 已更新 ${updated} 颗（共 ${list.length} 颗）`
          : `✅ TLE 已是最新（${list.length} 颗${cacheFresh ? `，缓存 ${cacheAge}` : "，已强制刷新"}）`,
        "ok"
      );
      log(`TLE 完成：共 ${list.length} 颗${updated > 0 ? `，更新 ${updated} 颗` : "（无变化）"}`);
      input.focus();
    } catch (e) {
      if (satList.length) {
        // 网络失败：过期缓存必须明确警告结果可能不准
        if (cacheFresh) {
          setStatus(`⚠️ 网络刷新失败，使用本地缓存（${cacheAge}）：${e.message}`, "err");
          log(`TLE 网络刷新失败：${e.message}，使用本地缓存`);
        } else {
          setStatus(`⚠️ 网络获取失败，缓存已超过 12 小时（${cacheAge}），结果可能不准：${e.message}`, "err");
          log(`TLE 获取失败且缓存过期：${e.message}`);
        }
      } else {
        setStatus("获取失败：" + e.message + "（可手动粘贴 TLE）", "err");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "⬇️ 获取 TLE";
    }
  });

  // ---------- 地图选点（高德瓦片，懒加载） ----------
  const coord = window.K5WEB.coord;
  let map = null, marker = null;

  function initMap() {
    if (map) return;
    map = L.map("map").setView([parseFloat($("lat").value) || 31.23, parseFloat($("lon").value) || 121.47], 10);
    L.tileLayer("https://webrd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", {
      subdomains: ["01", "02", "03", "04"],
      maxZoom: 18,
      attribution: "© 高德地图",
    }).addTo(map);
    marker = L.circleMarker([parseFloat($("lat").value) || 31.23, parseFloat($("lon").value) || 121.47], {
      radius: 6, color: "#c62828", fillColor: "#c62828", fillOpacity: 0.9,
    }).addTo(map);
    map.on("click", onMapClick);
  }

  async function onMapClick(e) {
    // 点击坐标是 GCJ-02（高德瓦片），反算为 WGS-84 填入表单
    const wgs = coord.gcj02ToWgs84(e.latlng.lat, e.latlng.lng);
    $("lat").value = wgs[0].toFixed(5);
    $("lon").value = wgs[1].toFixed(5);
    if (marker) marker.setLatLng(e.latlng);
    log(`地图选点：${wgs[0].toFixed(5)}, ${wgs[1].toFixed(5)}（WGS-84）`);
    // 查询海拔（多源 + 超时；失败有明显提示，且不影响使用）
    setStatus("📡 查询海拔...");
    const h = await fetchElevation(wgs[0], wgs[1]);
    if (h !== null) {
      $("alt").value = h.toFixed(1); // 米
      setStatus(`✅ 已选点 ${wgs[0].toFixed(4)}, ${wgs[1].toFixed(4)}，海拔 ${h.toFixed(0)} m`, "ok");
    } else {
      setStatus("⚠️ 海拔查询失败（保留手动值，海拔对过境计算影响可忽略）", "err");
  }
  }

  $("btnMap").addEventListener("click", () => {
    $("mapWrap").style.display = "block";
    setTimeout(() => initMap(), 50); // 等容器可见后再初始化
    setTimeout(() => map && map.invalidateSize(), 200);
  });

  // 查询海拔：open-elevation API（8s 超时），失败返回 null
  async function fetchElevation(lat, lon) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(
        "https://api.open-elevation.com/api/v1/lookup?locations=" + lat.toFixed(4) + "," + lon.toFixed(4),
        { headers: { "accept": "application/json" }, signal: ctrl.signal }
      );
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const h = data.results && data.results[0] && data.results[0].elevation;
      return typeof h === "number" ? h : null;
    } catch (e) {
      log("海拔查询失败：" + e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }


  // ---------- 地址搜索（高德 Worker 代理，Key 存环境变量不公开） ----------
  const GEO_WORKER_URL = "https://geo.jkhgnl.top";

  // 地理编码：地址 → [{lat, lng, name}]（高德 GCJ-02）
  async function geocodeAddress(q) {
    try {
      const resp = await fetch(GEO_WORKER_URL + "/geocode?address=" + encodeURIComponent(q));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const d = await resp.json();
      if (d.status === "1" && d.geocodes && d.geocodes.length) {
        return d.geocodes.map(g => {
          const [lng, lat] = g.location.split(",").map(Number);
          return { lat, lng, name: g.formatted_address || g.location };
        });
      }
      log("高德地理编码无结果：" + (d.info || ""));
    } catch (e) { log("高德搜索失败：" + e.message); }
    // 回退 OSM Photon（带 3s 超时，避免拖慢）
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const url = "https://photon.komoot.io/api/?q=" + encodeURIComponent(q) + "&limit=5&lang=zh";
        const resp = await fetch(url, { signal: ctrl.signal });
        const d = await resp.json();
        if (d.features && d.features.length) {
          return d.features.map(f => {
            const [lng, lat] = f.geometry.coordinates;
            const name = [f.properties.name, f.properties.city, f.properties.country].filter(Boolean).join(", ");
            return { lat, lng, name, _wgs: true };
          });
        }
      } finally { clearTimeout(timer); }
    } catch (e) { log("OSM 搜索失败：" + e.message); }
    return [];
  }

  // 输入提示：边输入边模糊匹配（带超时 + 只接受最新一次请求的响应）
  let tipSeq = 0;
  async function getAddressTips(kw, seq) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const resp = await fetch(GEO_WORKER_URL + "/tips?keywords=" + encodeURIComponent(kw), { signal: ctrl.signal });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const d = await resp.json();
      if (seq !== tipSeq) return; // 过期响应丢弃，避免旧结果覆盖新输入
      if (d.status === "1" && d.tips && d.tips.length) {
        showTipList(d.tips
          .filter(t => t.location) // 只有带坐标的才可定位
          .map(t => {
            const [lng, lat] = t.location.split(",").map(Number);
            return { lat, lng, name: t.name || "", addr: t.district || "" };
          }));
      } else {
        showTipList([]);
      }
    } catch (e) {
      if (seq === tipSeq) showTipList([]); // 超时/失败则隐藏，不卡住
    } finally {
      clearTimeout(timer);
    }
  }

  // 下拉提示渲染
  let tipTimer = null;
  function showTipList(items) {
    const box = $("mapTipList");
    box.innerHTML = "";
    if (!items.length) { box.style.display = "none"; return; }
    items.slice(0, 8).forEach(it => {
      const div = document.createElement("div");
      div.className = "map-tip-item";
      div.innerHTML = "<b>" + it.name + "</b><span>" + it.addr + "</span>";
      div.addEventListener("click", () => {
        box.style.display = "none";
        $("mapSearch").value = it.name;
        placeSearchPoint(it);
      });
      box.appendChild(div);
    });
    box.style.display = "block";
  }

  // 把搜索结果定位到地图并填表
  async function placeSearchPoint(r) {
    // r 来自高德（GCJ-02）或 OSM 回退（WGS-84）
    const gcj = r._wgs ? coord.wgs84ToGcj02(r.lat, r.lng) : { lat: r.lat, lng: r.lng };
    const wgs = r._wgs ? { lat: r.lat, lng: r.lng } : coord.gcj02ToWgs84(r.lat, r.lng);
    initMap();
    map.setView([gcj.lat, gcj.lng], 14);
    if (marker) marker.setLatLng([gcj.lat, gcj.lng]);
    $("lat").value = wgs.lat.toFixed(5);
    $("lon").value = wgs.lng.toFixed(5);
    log(`地址搜索：${r.name} → ${wgs.lat.toFixed(5)}, ${wgs.lng.toFixed(5)}（WGS-84）`);
    setStatus("📡 查询海拔...");
    const h = await fetchElevation(wgs.lat, wgs.lng);
    if (h !== null) {
      $("alt").value = h.toFixed(1);
      setStatus(`✅ 已选点：${r.name}，海拔 ${h.toFixed(0)} m`, "ok");
    } else {
      setStatus("⚠️ 海拔查询失败", "err");
    }
  }

  async function onMapSearch() {
    const q = $("mapSearch").value.trim();
    if (!q) return;
    hideTipList();
    const results = await geocodeAddress(q);
    if (!results.length) {
      setStatus("⚠️ 未找到该地址", "err");
      return;
    }
    await placeSearchPoint(results[0]);
  }

  function hideTipList() { const b = $("mapTipList"); if (b) b.style.display = "none"; }

  $("btnMapSearch").addEventListener("click", onMapSearch);
  $("mapSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { onMapSearch(); }
    else if (e.key === "Escape") { hideTipList(); }
  });
  $("mapSearch").addEventListener("input", (e) => {
    const kw = e.target.value.trim();
    clearTimeout(tipTimer);
    if (kw.length < 2) { hideTipList(); return; }
    const seq = ++tipSeq;
    tipTimer = setTimeout(() => { getAddressTips(kw, seq); }, 120);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#mapTipWrap")) hideTipList();
  });


  $("btnLocate").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("当前浏览器不支持 GPS 定位", "err");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        $("lat").value = lat.toFixed(5);
        $("lon").value = lon.toFixed(5);
        log(`GPS 定位：${lat.toFixed(5)}, ${lon.toFixed(5)}`);
        // 优先 API 查精确地形海拔；API 失败时用设备海拔兜底
        // （注意：很多浏览器拿不到高度时 altitude 返回 0，需排除）
        let h = await fetchElevation(lat, lon);
        if (h === null) {
          const a = pos.coords.altitude;
          if (typeof a === "number" && isFinite(a) && a > 0 && a < 9000) h = a;
        }
        if (h !== null) {
          $("alt").value = h.toFixed(1); // 米
          setStatus(`✅ 已使用设备定位：${lat.toFixed(4)}, ${lon.toFixed(4)}，海拔 ${h.toFixed(0)} m`, "ok");
        } else {
          setStatus(`✅ 已使用设备定位：${lat.toFixed(4)}, ${lon.toFixed(4)}（海拔查询失败，可手动填写）`, "ok");
        }
        if (map) map.setView([lat, lon], 12);
      },
      (err) => setStatus("GPS 定位失败：" + err.message + "（可改用地图选点）", "err"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });


  // ---------- 扫码传定位（网页出二维码，手机 APP 扫描后上报 GPS） ----------
  let gpsPollTimer = null;
  let gpsQrToken = "";

  function genToken() {
    const chars = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * 16)];
    return s;
  }

  // 优先向服务器查询本机局域网 IP（服务器已枚举好，最可靠）
  // GitHub Pages 模式下直接走 WebRTC 探测
  async function fetchLocalIp() {
    if (IS_GITHUB_PAGES) return null; // 无服务器，交给 WebRTC 探测
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch("/localip", { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data && data.ok && Array.isArray(data.ips) && data.ips.length) return data.ips[0];
    } catch (e) { /* 旧版服务器无此接口时回退到 WebRTC 探测 */ }
    return null;
  }

  // 用 WebRTC 探测本机局域网 IPv4（2 秒超时；失败返回 null，让用户手填）
  function detectLanIp() {
    return new Promise((resolve) => {
      const done = (ip) => { clearTimeout(timer); resolve(ip || null); };
      const timer = setTimeout(() => done(null), 2000);
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel("d");
        pc.onicecandidate = (e) => {
          if (!e.candidate) { pc.close(); done(null); return; }
          const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate || "");
          if (m) {
            const ip = m[1];
            if (ip !== "127.0.0.1" && !ip.startsWith("169.254.")) { pc.close(); done(ip); }
          }
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done(null));
      } catch (e) { done(null); }
    });
  }

  function stopGpsPoll() {
    if (gpsPollTimer) { clearInterval(gpsPollTimer); gpsPollTimer = null; }
  }

  // 每秒轮询 /getgps，收到后自动填入经纬度/海拔
  function startGpsPoll() {
    stopGpsPoll();
    const pollUrl = IS_GITHUB_PAGES
      ? GPS_WORKER_URL + "/getgps?t=" + encodeURIComponent(gpsQrToken)
      : "/getgps?t=" + encodeURIComponent(gpsQrToken);
    log("开始GPS轮询：" + pollUrl, "GPS");
    let pollCount = 0;
    gpsPollTimer = setInterval(async () => {
      pollCount++;
      try {
        const resp = await fetch(pollUrl);
        if (!resp.ok) { log("GPS轮询HTTP错误：" + resp.status, "GPS"); return; }
        const raw = await resp.text();
        const data = JSON.parse(raw);
        if (pollCount <= 5 || pollCount % 10 === 0) {
          log("GPS轮询#" + pollCount + "：" + raw, "GPS");
        }
        if (!data || !data.ok) return;
        stopGpsPoll();
        const lat = Number(data.lat).toFixed(5);
        const lon = Number(data.lon).toFixed(5);
        const alt = Number(data.alt).toFixed(1);
        $("lat").value = lat;
        $("lon").value = lon;
        $("alt").value = alt;
        const s = $("gpsQrStatus");
        s.textContent = "✅ 已收到：纬度 " + lat + "，经度 " + lon + "，海拔 " + alt + " m";
        s.className = "gps-qr-status";
        setStatus("✅ 已扫码获取位置：" + lat + ", " + lon, "ok");
        log("扫码上报位置：" + lat + ", " + lon + ", 海拔 " + alt + " m");
        if (map) { try { map.setView([Number(data.lat), Number(data.lon)], 12); } catch (e) {} }
      } catch (e) {
        console.log("[GPS poll]", e);
        log("GPS轮询失败：" + e.message, "GPS");
      }
    }, 1000);
  }

  function buildGpsQr() {
    gpsQrToken = genToken();
    let url;

    if (IS_GITHUB_PAGES) {
      // GitHub Pages 模式：使用 GPS Worker 中转
      url = GPS_WORKER_URL + "/setgps?t=" + gpsQrToken;
    } else {
      const ip = ($("gpsQrIp").value || "").trim();
      if (!ip) {
        const s = $("gpsQrStatus");
        s.textContent = "⚠️ 请填写电脑局域网 IP（可在服务器窗口或 ipconfig 中查看）";
        s.className = "gps-qr-status err";
        return;
      }
      const port = window.location.port || "8080";
      url = "http://" + ip + ":" + port + "/setgps?t=" + gpsQrToken;
    }

    $("gpsQrUrl").textContent = url;
    $("gpsQr").innerHTML = "";
    try {
      new QRCode($("gpsQr"), { text: url, width: 210, height: 210, correctLevel: QRCode.CorrectLevel.M });
    } catch (e) {
      const s = $("gpsQrStatus");
      s.textContent = "⚠️ 二维码生成失败：" + e.message;
      s.className = "gps-qr-status err";
      return;
    }
    const s = $("gpsQrStatus");
    s.textContent = "等待手机扫码上报…";
    s.className = "gps-qr-status";
    log("生成GPS二维码：" + url, "GPS");
    startGpsPoll();
  }

  async function openGpsQr() {
    $("gpsQrModal").classList.add("show");
    const s = $("gpsQrStatus");

    // GitHub Pages 模式：直接使用 GPS Worker，无需局域网 IP
    if (IS_GITHUB_PAGES) {
      const ipRow = $("gpsQrIp").closest(".form-row") || $("gpsQrIp").parentElement;
      if (ipRow) ipRow.style.display = "none";
      buildGpsQr();
      return;
    }
    // 本地服务器模式：显示 IP 输入框
    const ipRow = $("gpsQrIp").closest(".form-row") || $("gpsQrIp").parentElement;
    if (ipRow) ipRow.style.display = "";

    s.textContent = "正在获取本机局域网 IP…";
    s.className = "gps-qr-status";
    // 优先向服务器查询；失败则回退：页面用局域网 IP 打开时直接用，否则 WebRTC 探测
    let ip = await fetchLocalIp();
    if (!ip) {
      const host = window.location.hostname;
      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
      if (host && isIp && host !== "127.0.0.1" && host !== "0.0.0.0" && !host.startsWith("169.254.")) {
        ip = host;
      } else {
        ip = await detectLanIp();
      }
    }
    if (ip) $("gpsQrIp").value = ip;
    buildGpsQr();
  }

  function closeGpsQr() {
    stopGpsPoll();
    $("gpsQrModal").classList.remove("show");
  }

  $("btnGpsQr").addEventListener("click", openGpsQr);
  $("gpsQrClose").addEventListener("click", closeGpsQr);
  $("gpsQrRegen").addEventListener("click", buildGpsQr);
  $("gpsQrModal").addEventListener("click", (e) => { if (e.target === $("gpsQrModal")) closeGpsQr(); });
  // 点击 URL 文本全选，方便手动复制
  $("gpsQrUrl").addEventListener("click", () => {
    const el = $("gpsQrUrl");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });


  // ---------- 计算过境 ----------
  $("btnCalc").addEventListener("click", () => {
    const showErr = (msg) => {
      const r = $("result");
      r.style.display = "block";
      r.innerHTML = `<span class="err"><b>⚠️ ${msg}</b></span>`;
      setStatus(msg, "err");
    };
    const tle = $("tle").value.trim().split(/\r?\n/);
    if (tle.length < 2 || !tle[0].trim()) {
      showErr("请先获取 TLE（点上方 ⬇️ 获取 TLE 按钮）或手动粘贴两行 TLE");
      return;
    }
    const lat = parseFloat($("lat").value), lon = parseFloat($("lon").value);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      showErr("观测位置经纬度无效（纬度 -90~90，经度 -180~180）");
      return;
    }
    const minEl = parseFloat($("minEl").value);
    if (isNaN(minEl) || minEl < 0 || minEl > 90) {
      showErr("最低仰角无效（0~90）");
      return;
    }
    const btn = $("btnCalc");
    btn.disabled = true;
    btn.textContent = "⏳ 计算中...";
    // 先渲染"计算中"，再同步执行 SGP4 解算
    setTimeout(() => {
    try {
      const pass = calc.findPass({
        tle1: tle[0],
        tle2: tle[1],
        latDeg: lat,
        lonDeg: lon,
        altKm: (parseFloat($("alt").value) || 0) / 1000,
        uplinkMHz: parseFloat($("fUp").value),
        downlinkMHz: parseFloat($("fDown").value),
        minElevation: parseFloat($("minEl").value) || 0,
        searchStart: new Date(),
        maxSearchHours: 24,
        maxPassSeconds: 32 * 60,
      });
      if (!pass) {
        showErr("未来 24 小时内未找到可见过境。检查：TLE 是否当天最新、经纬度是否正确");
        btn.disabled = false;
        btn.textContent = "🔭 计算最近过境";
        return;
      }
      passData = pass;
      const r = $("result");
      r.style.display = "block";
      // 固定按 Asia/Shanghai 显示，与系统时区无关（对比 Look4Sat 时不串时区）。
      // 内部 AOS/LOS 精度 0.1s（calc.js 插值），UI 显示仍按秒（round 到整秒，
      // 与 Look4Sat 的 aos 取整方式一致）。
      const fmt = (d) => {
        const bj = new Date(Math.round(d.getTime() / 1000) * 1000 + 8 * 3600 * 1000);
        const p = (n, l = 2) => String(n).padStart(l, "0");
        return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
      };
      const first = pass.entries[0], last = pass.entries[pass.entries.length - 1];
      r.innerHTML =
        `<b>过境时间（北京时间）：</b>${fmt(pass.start)} → ${fmt(pass.end)}<br>` +
        `时长 ${pass.durationS}s，频率表 ${pass.entries.length} 条（每秒）<br>` +
        `下行 ${(first.downlink / 1e5).toFixed(5)} ~ ${(last.downlink / 1e5).toFixed(5)} MHz<br>` +
        `上行 ${(first.uplink / 1e5).toFixed(5)} ~ ${(last.uplink / 1e5).toFixed(5)} MHz<br>` +
        `<span class="ok">可以写入。写入后请在过境开始前开机，长按 0 输入当前北京时间开始跟踪。</span>`;
      $("btnWrite").disabled = false;
      $("btnEphemExport").disabled = false;
      $("btnEphemExportCsv").disabled = false;
      log(`过境 ${fmt(pass.start)} → ${fmt(pass.end)}（北京时间），${pass.entries.length} 条`);
    } catch (e) {
      showErr("计算失败：" + e.message);
      log("计算异常：" + e.stack);
    }
    btn.disabled = false;
    btn.textContent = "🔭 计算最近过境";
    }, 30);
  });

  // ---------- 串口 ----------
  async function readLoop() {
    const frameDec = new proto.FrameDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          const frames = frameDec.push(value); // Uint8Array，直接喂帧解码器
          for (const f of frames) replyQueue.push(f);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") log("读取中断：" + e.message, "err");
    } finally {
      reader.releaseLock();
    }
  }

  async function sendCommand(id, payload) {
    const frame = proto.buildFrame(id, payload);
    await writer.write(frame);
    // 等待对应回复（带 5s 超时）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (replyQueue.length) {
        const reply = replyQueue.shift();
        const parsed = proto.parseReply(reply);
        if (parsed.id === id + 3) return parsed; // 回复 ID = 命令 ID + 3
        // 其他回复（如 K5Viewer 流）忽略
        continue;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("回复超时 (0x" + id.toString(16) + ")");
  }

  $("btnConnect").addEventListener("click", async () => {
    if (port) {
      try { if (writer) { writer.releaseLock(); writer = null; } } catch (e) { /* ignore */ }
      try { await port.close(); } catch (e) { /* ignore */ }
      port = null;
      $("btnConnect").textContent = "连接";
      $("btnConnect").classList.remove("secondary");
      log("串口已断开");
      // 断开时清空槽位显示
      for (let i = 0; i < 4; i++) updateSlotCard(i, "");
      return;
    }
    if (!navigator.serial) {
      setStatus("当前浏览器不支持 Web Serial，请用 Chrome/Edge（需 https 或 localhost 环境）", "err");
      return;
    }
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 38400 }); // F4HWN UART protocol is 38400 baud
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      readLoop();
      $("btnConnect").textContent = "断开";
      $("btnConnect").classList.add("secondary");
      setStatus("串口已连接 ✓", "ok");
      log("串口已连接");
      // 自动读取四个槽位名称
      readAllSlots();
    } catch (e) {
      setStatus("连接失败：" + e.message, "err");
    }
  });

  // ---------- 写入星历 ----------
  $("btnWrite").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    if (!passData) { setStatus("请先计算过境", "err"); return; }

    $("btnWrite").disabled = true;
    $("progress").style.display = "block";
    const bar = $("progressBar");
    bar.style.width = "0%";
    try {
      // 0. 目标槽位（0..3），每槽 16 KB / 最多 1020 条（约 17 分钟过境）
      const slot = selectedSlot;
      if (passData.entries.length > 1020) {
        throw new Error(`过境 ${passData.durationS} 秒超过单槽上限 1020 秒（约 17 分钟），请更换过境窗口`);
      }

      // 1. 擦除目标槽位
      log(`擦除槽位 ${slot + 1}...`);
      const e = await sendCommand(proto.CMD.DOPPLER_ERASE, new Uint8Array([slot, 0]));
      if (e.status !== 0) throw new Error("擦除失败 status=" + e.status);
      log("擦除完成");

      // 2. 卫星信息块（startUnix 用 floor：与表起点整秒对齐，固件按整秒索引）
      const start = new Date(passData.start.getTime());
      const end = new Date(passData.end.getTime());
      const sat = proto.buildSatelliteBlock({
        name: ($("satSelect").value || "SAT").trim().slice(0, 9),
        startTime: calc.dateToFwTime(start),
        endTime: calc.dateToFwTime(end),
        sumTime: passData.durationS,
        sendCtcss: parseInt($("ctcss").value, 10),
        startUnix: calc.unixToFw(Math.floor(start.getTime() / 1000)),
      });
      log(`写入卫星信息块（槽位 ${slot + 1}）... sumTime=${passData.durationS} entries=${passData.entries.length}`);
      // payload layout must match CMD_DOPPLER_WRITE_SAT_t: satellite block
      // first (4-byte aligned), then slot + padding at the end
      const satPayload = new Uint8Array(sat.length + 2);
      satPayload.set(sat, 0);
      satPayload[sat.length] = slot;
      satPayload[sat.length + 1] = 0;
      const s = await sendCommand(proto.CMD.DOPPLER_WRITE_SAT, satPayload);
      if (s.status !== 0) throw new Error("卫星块写入失败 status=" + s.status);
      log("卫星块完成");

      // 3. 频率表条目（分批）
      const total = passData.entries.length;
      const batch = 64;
      for (let i = 0; i < total; i += batch) {
        const n = Math.min(batch, total - i);
        for (let j = 0; j < n; j++) {
          const en = passData.entries[i + j];
          const payload = new Uint8Array(20);
          const dv = new DataView(payload.buffer);
          dv.setUint16(0, i + j, true); // index
          dv.setUint16(2, slot, true);  // slot (0..3)
          payload.set(proto.buildEntry(en.uplink, en.downlink, en.altitudeKm, en.distanceKm, en.azimuthDeg, en.elevationDeg), 4);
          const r = await sendCommand(proto.CMD.DOPPLER_WRITE_ENTRY, payload);
          if (r.status !== 0) throw new Error(`条目 ${i + j} 写入失败`);
        }
        bar.style.width = ((i + n) / total * 100).toFixed(1) + "%";
        log(`条目 ${i + n}/${total}`);
      }
      bar.style.width = "100%";

      // 4. 同步写入北京时间到 RTC（优先用已同步时钟，未同步才现场取网）
      const net = await getWriteTime();
      const display = formatBeijingDateTime(net.date);
      log(`写入 RTC：${display}（${net.source}）`);
      const rtcPayload = proto.buildRtcTimePayload(calc.unixToFw(Math.round(net.date.getTime() / 1000)));
      const rtc = await sendCommand(proto.CMD.SET_RTC, rtcPayload);
      if (rtc.status !== 0) throw new Error("星历已写入，但 RTC 写入被拒 status=" + rtc.status);

      setStatus(`✅ 星历已写入槽 ${slot + 1}，北京时间已同步！机内长按 0 进入多普勒模式，F+1~4 切换槽位`, "ok");
      log("全部完成");
      // 刷新写入的槽位卡片
      await readSlot(slot);
    } catch (err) {
      setStatus("写入失败：" + err.message, "err");
      log("写入异常：" + err.message, "err");
    } finally {
      $("btnWrite").disabled = false;
    }
  });

  // ---------- 删除全部星历（1-4 槽） ----------
  $("btnEraseAll").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    if (!confirm("将删除 1-4 槽位的全部星历数据，此操作不可恢复。确定继续？")) return;
    const btn = $("btnEraseAll");
    btn.disabled = true;
    try {
      for (let slot = 0; slot < 4; slot++) {
        log(`删除槽位 ${slot + 1}...`);
        const e = await sendCommand(proto.CMD.DOPPLER_ERASE, new Uint8Array([slot, 0]));
        if (e.status !== 0) throw new Error(`槽位 ${slot + 1} 删除失败 status=${e.status}`);
        log(`槽位 ${slot + 1} 删除完成`);
      }
      setStatus("✅ 1-4 槽位星历已全部删除", "ok");
      // 刷新所有槽位卡片
      for (let i = 0; i < 4; i++) updateSlotCard(i, "");
      selectSlot(selectedSlot);
    } catch (err) {
      setStatus("删除失败：" + err.message, "err");
      log("删除异常：" + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 槽位卡片 UI ----------
  let slotEditBlock = null; // 当前选中槽位的 32 字节卫星块缓存

  // 更新单个槽位卡片显示
  function updateSlotCard(idx, name) {
    slotNames[idx] = name || "";
    const nameEl = $("slotName" + idx);
    const card = $("slotCard" + idx);
    if (nameEl) {
      nameEl.textContent = name || "空";
      nameEl.classList.toggle("empty", !name);
    }
    if (card) card.classList.toggle("has-data", !!name);
  }

  // 选中槽位卡片
  function selectSlot(idx) {
    selectedSlot = idx;
    document.querySelectorAll(".ephem-slot").forEach((el, i) => {
      el.classList.toggle("selected", i === idx);
    });
    // 同步名称输入框
    $("slotNameInput").value = slotNames[idx] || "";
    $("btnSlotRename").disabled = !port || !slotNames[idx];
  }

  // 读取单个槽位
  async function readSlot(idx) {
    if (!port) return;
    try {
      const reply = await sendAndWaitRaw(proto.CMD.DOPPLER_READ_SAT, new Uint8Array([idx, 0]));
      const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      if (dv.getUint16(0, true) !== proto.CMD.REPLY_READ_SAT) return;
      // payload: header(4) + status(1) + slot(1) + pad(2) + satellite(32)
      if (reply[4] !== 0) { updateSlotCard(idx, ""); return; }
      const block = reply.slice(8, 40);
      let name = "";
      for (const b of block.subarray(4, 14)) {
        if (b === 0) break;
        name += String.fromCharCode(b);
      }
      updateSlotCard(idx, name);
      // 如果是当前选中槽位，缓存块数据
      if (idx === selectedSlot) slotEditBlock = block;
    } catch (e) {
      updateSlotCard(idx, "");
    }
  }

  // 连接后自动读取全部 4 个槽位
  async function readAllSlots() {
    if (!port) return;
    log("正在读取全部槽位...");
    for (let i = 0; i < 4; i++) {
      await readSlot(i);
    }
    // 重新选中当前槽位以刷新缓存
    selectSlot(selectedSlot);
    log("槽位读取完成：" + slotNames.map((n, i) => `${i + 1}:${n || "空"}`).join("，"));
  }

  // 点击槽位卡片
  document.querySelectorAll(".ephem-slot").forEach((el) => {
    el.addEventListener("click", async () => {
      const idx = parseInt(el.dataset.slot, 10);
      selectSlot(idx);
      // 如果已连接，读取该槽位详情
      if (port) {
        await readSlot(idx);
        $("btnSlotRename").disabled = !slotNames[idx];
      }
    });
  });

  // 初始化选中第一个槽位
  selectSlot(0);

  // 名称输入框变化时启用保存按钮
  $("slotNameInput").addEventListener("input", () => {
    $("btnSlotRename").disabled = !port || !$("slotNameInput").value.trim();
  });

  // 保存槽位名称
  $("btnSlotRename").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    // 先读取当前选中槽位确保有最新数据
    await readSlot(selectedSlot);
    if (!slotEditBlock) { setStatus("请先点击槽位卡片读取数据", "err"); return; }
    const name = $("slotNameInput").value.trim();
    if (!name) { setStatus("名称不能为空", "err"); return; }
    const btn = $("btnSlotRename");
    btn.disabled = true;
    try {
      const block = new Uint8Array(slotEditBlock);
      block.fill(0, 4, 14);
      const nb = new TextEncoder().encode(name.slice(0, 9));
      block.set(nb, 4);
      block[30] = proto.crc8(block.subarray(0, 30));
      block[31] = 0;
      const payload = new Uint8Array(34);
      payload.set(block, 0);
      payload[32] = selectedSlot;
      const r = await sendCommand(proto.CMD.DOPPLER_WRITE_SAT, payload);
      if (r.status !== 0) throw new Error("写回失败 status=" + r.status);
      slotEditBlock = block;
      updateSlotCard(selectedSlot, name.slice(0, 9));
      setStatus(`✅ 槽位 ${selectedSlot + 1} 名称已改为"${name.slice(0, 9)}"，机内 F+${selectedSlot + 1} 重新选中即可看到`, "ok");
      log(`槽位 ${selectedSlot + 1} 名称已更新为"${name.slice(0, 9)}"`);
    } catch (err) {
      setStatus("保存失败：" + err.message, "err");
      log("保存名称异常：" + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
  // ---------- 导出星历到电脑（调试诊断，纯网页端，无需串口） ----------
  // 把"计算最近过境"的结果（TLE、观测位置、过境窗口、每秒频率表）导出为
  // JSON / CSV 文件，便于核对计算、与其他软件对比、存档分析。
  const fmtExportBeijing = (date) => {
    const bj = new Date(Math.round(date.getTime() / 1000) * 1000 + 8 * 3600 * 1000); // 北京时间（UTC+8），显示按秒
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
  };
  const exportStamp = () => {
    const ts = new Date();
    return `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}_${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}`;
  };
  const downloadText = (filename, text, mime) => {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // 汇总当前页面的计算参数与结果（供 JSON / CSV 导出复用）
  function buildEphemExport() {
    if (!passData) throw new Error("请先计算过境");
    const tleLines = $("tle").value.trim().split(/\r?\n/).filter((l) => l.trim());
    if (tleLines.length < 2) throw new Error("缺少 TLE 两行数据");
    const tle1 = tleLines[tleLines.length - 2].trim();
    const tle2 = tleLines[tleLines.length - 1].trim();
    if (!/^1 [0-9]{5}/.test(tle1) || !/^2 [0-9]{5}/.test(tle2)) {
      throw new Error("TLE 格式不正确（应为 1/2 开头的两行数据）");
    }
    const pass = passData;
    const entries = pass.entries.map((en, i) => {
      const bj = new Date((en.unix + 8 * 3600) * 1000);
      return {
        t: i,                                   // 过境开始后第几秒
        unix: en.unix,                          // 1970 基准秒
        beijing: bj.toISOString().replace("T", " ").slice(0, 19),
        uplink10Hz: en.uplink,                  // 固件存储单位（10 Hz）
        downlink10Hz: en.downlink,
        uplinkMHz: +(en.uplink / 1e5).toFixed(5),
        downlinkMHz: +(en.downlink / 1e5).toFixed(5),
        altitudeKm: en.altitudeKm,
        distanceKm: en.distanceKm,
        azimuthDeg: +en.azimuthDeg.toFixed(1),
        elevationDeg: +en.elevationDeg.toFixed(1),
      };
    });
    const satName = ($("satSelect").value || "SAT").trim();
    return {
      tool: "k5web 多普勒星历导出（调试诊断）",
      exportedAt: new Date().toISOString(),
      satellite: {
        name: satName,
        tle1, tle2,
        uplinkMHz: parseFloat($("fUp").value),
        downlinkMHz: parseFloat($("fDown").value),
        ctcssHz: (parseInt($("ctcss").value, 10) || 0) / 10, // 0 = 无亚音
      },
      observer: {
        latDeg: parseFloat($("lat").value),
        lonDeg: parseFloat($("lon").value),
        altM: parseFloat($("alt").value),
        minElevationDeg: parseFloat($("minEl").value),
      },
      pass: {
        startBeijing: fmtExportBeijing(pass.start),
        endBeijing: fmtExportBeijing(pass.end),
        durationS: pass.durationS,
        entryCount: entries.length,
        // 固件 RTC 基准：2000-01-01 00:00:00 北京时间起的秒数（与写入星历一致，floor 整秒）
        startUnix2000: calc.unixToFw(Math.floor(pass.start.getTime() / 1000)),
      },
      entries,
    };
  }

  // 频率表 CSV（Excel 可直接打开；BOM 保证 UTF-8 中文不乱码）
  function buildEphemCsv(data) {
    const head = ["t_sec", "unix", "beijing", "uplinkMHz", "downlinkMHz",
                  "altitudeKm", "distanceKm", "azimuthDeg", "elevationDeg"];
    const lines = [head.join(",")];
    for (const e of data.entries) {
      lines.push([e.t, e.unix, e.beijing, e.uplinkMHz, e.downlinkMHz,
                  e.altitudeKm, e.distanceKm, e.azimuthDeg, e.elevationDeg].join(","));
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  $("btnEphemExport").addEventListener("click", () => {
    try {
      const d = buildEphemExport();
      const name = d.satellite.name.replace(/[\/:*?"<>|]/g, "_");
      const filename = `星历_${name}_${exportStamp()}.json`;
      downloadText(filename, JSON.stringify(d, null, 2), "application/json;charset=utf-8");
      setStatus(`✅ 星历已导出：${filename}（${d.pass.entryCount} 条 / 过境 ${d.pass.durationS} 秒）`, "ok");
      log(`导出完成：${filename}，${d.pass.entryCount} 条频率数据`);
    } catch (err) {
      setStatus("导出失败：" + err.message, "err");
      log("导出异常：" + err.message, "err");
    }
  });

  $("btnEphemExportCsv").addEventListener("click", () => {
    try {
      const d = buildEphemExport();
      const name = d.satellite.name.replace(/[\/:*?"<>|]/g, "_");
      const filename = `星历_${name}_${exportStamp()}.csv`;
      downloadText(filename, buildEphemCsv(d), "text/csv;charset=utf-8");
      setStatus(`✅ 频率表已导出：${filename}（${d.pass.entryCount} 行）`, "ok");
      log(`导出完成：${filename}，${d.pass.entryCount} 行`);
    } catch (err) {
      setStatus("导出失败：" + err.message, "err");
      log("导出异常：" + err.message, "err");
    }
  });

  // ---------- 获取当前时间（直接使用本机时钟） ----------
  // 本地电脑 OS 已通过 NTP 自动同步，误差 <1 秒，卫星追踪精度足够。

  function formatBeijingDateTime(d) {
    return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
  }

  // 获取"当前时间"用于写入 RTC
  async function getWriteTime() {
    return { date: new Date(), source: "本机时钟" };
  }

  // ---------- 中文字库刷入 ----------
  let fontData = null;
  const FONT_REMOTE_URL = "gb2312_16x16.bin";

  async function loadFontBuffer(buf, sourceName) {
    if (buf.length > proto.CN_FONT.FLASH_SIZE) {
      setStatus(`字库文件过大：${buf.length} 字节，应为 ${proto.CN_FONT.FLASH_SIZE}`, "err");
      log(`字库文件过大：${buf.length} 字节`);
      return false;
    }
    fontData = buf;
    $("btnFont").disabled = false;
    $("fontStatus").textContent = `已加载：${sourceName}（${buf.length} 字节）`;
    log(`字库已加载：${sourceName}（${buf.length} 字节）`);
    if (buf.length !== proto.CN_FONT.FLASH_SIZE)
      log("提示：文件小于标准尺寸，未覆盖区域将保持空白", "info");
    return true;
  }

  $("fontFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    fontData = null;
    $("btnFont").disabled = true;
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    await loadFontBuffer(buf, f.name);
  });

  $("btnFontFile").addEventListener("click", () => {
    $("fontFile").click();
  });

  $("btnFontRemote").addEventListener("click", async () => {
    $("btnFontRemote").disabled = true;
    $("fontStatus").textContent = "正在下载远程字库...";
    try {
      const resp = await fetch(FONT_REMOTE_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      await loadFontBuffer(buf, FONT_REMOTE_URL);
    } catch (err) {
      setStatus("远程字库下载失败：" + err.message, "err");
      log("远程字库下载失败：" + err.message, "err");
      $("fontStatus").textContent = `下载失败：${err.message}`;
    } finally {
      $("btnFontRemote").disabled = false;
    }
  });

  $("btnFont").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    if (!fontData) { setStatus("请先选择字库文件", "err"); return; }

    $("btnFont").disabled = true;
    $("fontProgress").style.display = "block";
    const bar = $("fontProgressBar");
    bar.style.width = "0%";
    try {
      // 1. 逐扇区擦除（扇区数由 proto.CN_FONT.SECTOR_COUNT 决定，进度 0~30%）
      const sectors = proto.CN_FONT.SECTOR_COUNT;
      log(`擦除字库区（${sectors} 个扇区）...`);
      for (let s = 0; s < sectors; s++) {
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint16(0, s, true);
        const r = await sendCommand(proto.CMD.CN_FONT_ERASE, payload);
        if (r.status !== 0) throw new Error(`扇区 ${s} 擦除失败 status=${r.status}`);
        bar.style.width = ((s + 1) / sectors * 30).toFixed(1) + "%";
        if (s % 10 === 9 || s === sectors - 1) log(`擦除 ${s + 1}/${sectors}`);
      }

      // 2. 分块写入（200 字节/帧，进度 30~100%）
      const total = fontData.length, chunk = proto.CN_FONT.CHUNK;
      log("写入字库数据...");
      await new Promise((r) => setTimeout(r, 100)); // 擦除后短暂延时，等待固件就绪
      for (let off = 0; off < total; off += chunk) {
        const n = Math.min(chunk, total - off);
        const payload = new Uint8Array(4 + n);
        new DataView(payload.buffer).setUint32(0, off, true);
        payload.set(fontData.subarray(off, off + n), 4);
        const r = await sendCommand(proto.CMD.CN_FONT_WRITE, payload);
        if (r.status !== 0) throw new Error(`偏移 0x${off.toString(16)} 写入失败 status=${r.status}`);
        bar.style.width = (30 + (off + n) / total * 70).toFixed(1) + "%";
        if ((off / chunk) % 100 === 99 || off + n === total) log(`写入 ${off + n}/${total}`);
      }
      bar.style.width = "100%";
      setStatus("✅ 字库刷入完成！机内菜单 SetLng 选择 Chinese 即可（渲染支持随固件更新提供）", "ok");
      log("字库刷入完成");
    } catch (err) {
      setStatus("字库刷入失败：" + err.message, "err");
      log("字库刷入异常：" + err.message, "err");
    } finally {
      $("btnFont").disabled = false;
    }
  });
  // ---------- 字库读取 / 查看器 ----------
  async function sendAndWaitRaw(id, payload, timeoutMs = 5000) {
    const frame = proto.buildFrame(id, payload);
    await writer.write(frame);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (replyQueue.length) {
        const reply = replyQueue.shift();
        const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
        if (dv.getUint16(0, true) === id + 3) return reply;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("回复超时");
  }

  async function readFontBytes(offset, len) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, offset, true);
    const reply = await sendAndWaitRaw(proto.CMD.CN_FONT_READ, payload, 5000);
    const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    if (dv.getUint16(0, true) !== proto.CMD.REPLY_CN_FONT_READ) throw new Error("回复 ID 不符");
    const echo = dv.getUint32(4, true);
    if (echo !== offset) throw new Error(`偏移回显不一致 0x${echo.toString(16)}`);
    return reply.slice(8, 8 + Math.min(len, 128));
  }

  function gb2312Index(ch) {
    if (!gb) throw new Error("GB2312 编码表未加载");
    const r = gb.encode(ch);
    if (!r.ok) throw new Error(`无法编码 '${r.char}' 为 GB2312`);
    const b = r.bytes;
    return (b[0] - 0xA1) * 94 + (b[1] - 0xA1);
  }

  function renderGlyphGrid(glyph32) {
    const lines = [];
    for (let y = 0; y < 16; y++) {
      let row = "";
      const half = y < 8 ? 0 : 16;
      const bit = y & 7;
      for (let x = 0; x < 16; x++) {
        const byte = glyph32[half + x];
        row += (byte & (1 << bit)) ? "██" : "··";
      }
      lines.push(row);
    }
    return lines.join("\n");
  }

  $("btnFontView").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    const ch = $("fontViewChar").value.trim();
    if (!ch) { setStatus("请输入一个汉字", "err"); return; }
    $("btnFontView").disabled = true;
    try {
      const idx = gb2312Index(ch);
      if (idx >= proto.CN_FONT.GLYPH_COUNT) throw new Error("该字符超出共享字库 8192 字形范围");
      const offset = idx * proto.CN_FONT.GLYPH_SIZE;
      const glyph = await readFontBytes(offset, proto.CN_FONT.GLYPH_SIZE);
      $("fontViewGrid").textContent =
        `${ch}  index=${idx}  offset=0x${offset.toString(16)}\n` + renderGlyphGrid(glyph);
      setStatus(`字形读取成功：${ch} (0x${offset.toString(16)})`, "ok");
    } catch (err) {
      setStatus("字形读取失败：" + err.message, "err");
      log("字形读取异常：" + err.message, "err");
      $("fontViewGrid").textContent = "";
    } finally {
      $("btnFontView").disabled = false;
    }
  });

  $("btnFontCheck").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    $("btnFontCheck").disabled = true;
    try {
      const bytes = await readFontBytes(0, proto.CN_FONT.GLYPH_SIZE);
      const blank = bytes.every((b) => b === 0xFF);
      if (blank) {
        setStatus("字库区为空（0xFF），尚未烧录字库", "warn");
        log("字库校验：未检测到字库");
      } else {
        setStatus("✅ 字库区已有数据（0xA0000 起）", "ok");
        log("字库校验：检测到字库");
      }
    } catch (err) {
      setStatus("字库校验失败：" + err.message, "err");
      log("字库校验异常：" + err.message, "err");
    } finally {
      $("btnFontCheck").disabled = false;
    }
  });

  // ---------- 开机图片转换（任意图片 → ST7565 128x64 1bpp 页优先位图） ----------
  function imageToLogoBitmap(img, threshold) {
    if (threshold == null) threshold = parseInt($("logoThreshold").value) || 128;
    // 1. 创建 128x64 Canvas，白色背景
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 128, 64);

    // 2. 保持比例绘制图片（居中）
    const scale = Math.min(128 / img.width, 64 / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const x = Math.round((128 - w) / 2);
    const y = Math.round((64 - h) / 2);
    ctx.drawImage(img, x, y, w, h);

    // 3. 获取像素数据并二值化
    const imageData = ctx.getImageData(0, 0, 128, 64);
    const pixels = imageData.data; // RGBA
    const bw = new Uint8Array(128 * 64); // 1=黑, 0=白
    for (let i = 0; i < 128 * 64; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const gray = (r * 77 + g * 150 + b * 29) >> 8; // 灰度公式
      bw[i] = gray < threshold ? 1 : 0;
    }

    // 4. 转换为 ST7565 页优先格式（8 页 × 128 列，每页 8 行）
    //    页优先 LSB 在上：字节 [page * 128 + col]，bit0 是行 page*8
    const bitmap = new Uint8Array(1024);
    for (let page = 0; page < 8; page++) {
      for (let col = 0; col < 128; col++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const row = page * 8 + bit;
          if (row < 64 && bw[row * 128 + col]) {
            byte |= (1 << bit);
          }
        }
        bitmap[page * 128 + col] = byte;
      }
    }

    return bitmap;
  }

  // 预览图片转换结果（bitmap 为页优先格式）
  function renderLogoPreview(bitmap, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(128, 64);

    for (let page = 0; page < 8; page++) {
      for (let col = 0; col < 128; col++) {
        const byte = bitmap[page * 128 + col];
        for (let bit = 0; bit < 8; bit++) {
          const row = page * 8 + bit;
          if (row >= 64) continue;
          const idx = (row * 128 + col) * 4;
          const black = (byte & (1 << bit)) !== 0;
          imageData.data[idx] = black ? 0 : 255;
          imageData.data[idx + 1] = black ? 0 : 255;
          imageData.data[idx + 2] = black ? 0 : 255;
          imageData.data[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  // 根据反色复选框返回用于显示的位图副本（不修改 logoData）
  function getLogoDataForDisplay() {
    if (!logoData) return null;
    if (!$("logoInvert").checked) return logoData;
    const inverted = new Uint8Array(logoData);
    for (let i = 0; i < inverted.length; i++) inverted[i] = ~inverted[i] & 0xFF;
    return inverted;
  }

  // ---------- 开机图片（EEPROM 0xC000，1032 字节） ----------
  let logoData = null; // 转换后的位图数据
  let logoImg = null;  // 原始图片对象（用于阈值调节）

  async function handleLogoFile(f) {
    logoData = null;
    logoImg = null;
    $("btnLogoWrite").disabled = true;
    if (!f) return;

    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("无法加载图片"));
        img.src = url;
      });
      URL.revokeObjectURL(url);

      logoImg = img;
      const threshold = parseInt($("logoThreshold").value) || 128;
      logoData = imageToLogoBitmap(img, threshold);
      renderLogoPreview(getLogoDataForDisplay(), "logoPreview");
      $("btnLogoWrite").disabled = false;
      updateLogoDropZone(f.name);
      log(`图片已加载：${f.name}（${img.width}×${img.height} → 128×64 单色）`);
    } catch (err) {
      setStatus("图片加载失败：" + err.message, "err");
      log("图片加载异常：" + err.message, "err");
    }
  }

  function updateLogoDropZone(filename) {
    const zone = $("logoDropZone");
    if (!zone) return;
    if (!filename) {
      zone.innerHTML = `<div style="font-size:36px;margin-bottom:8px">🖼️</div>
        <div style="font-size:14px;font-weight:500;color:#555">点击选择或拖拽图片到这里</div>
        <div style="font-size:12px;color:#999;margin-top:4px">支持 PNG / JPG / BMP / GIF / WebP</div>
        <input id="logoFile" type="file" accept="image/*" style="display:none">`;
    } else {
      zone.innerHTML = `<div style="font-size:36px;margin-bottom:8px">🖼️</div>
        <div style="font-size:14px;font-weight:500;color:#222;word-break:break-all;padding:0 8px">${filename}</div>
        <div style="font-size:14px;color:#999;margin-top:4px">已加载，可继续拖拽替换</div>
        <input id="logoFile" type="file" accept="image/*" style="display:none">`;
    }
    const fileInput = zone.querySelector("#logoFile");
    if (fileInput) {
      fileInput.addEventListener("change", async (e) => {
        const f2 = e.target.files[0];
        if (f2) await handleLogoFile(f2);
      });
    }
  }

  $("logoFile").addEventListener("change", async (e) => {
    await handleLogoFile(e.target.files[0]);
  });

  // ---------- 拖拽上传 ----------
  {
    const zone = $("logoDropZone");
    let fileInput = $("logoFile");
    if (zone && fileInput) {
      zone.addEventListener("click", () => fileInput.click());
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.style.borderColor = "#2f6fdc"; zone.style.background = "#f0f6ff"; });
      zone.addEventListener("dragleave", () => { zone.style.borderColor = "#ccc"; zone.style.background = ""; });
      zone.addEventListener("drop", async (e) => {
        e.preventDefault();
        zone.style.borderColor = "#ccc";
        zone.style.background = "";
        const f = e.dataTransfer.files[0];
        fileInput = $("logoFile");
        if (f && fileInput) fileInput.files = e.dataTransfer.files;
        await handleLogoFile(f);
      });
    }
  }

  // 反色切换时重新渲染预览
  $("logoInvert").addEventListener("change", () => {
    if (!logoImg) return;
    renderLogoPreview(getLogoDataForDisplay(), "logoPreview");
  });

  // 色彩阈值滑块
  $("logoThreshold").addEventListener("input", () => {
    $("logoThresholdVal").textContent = $("logoThreshold").value;
    if (!logoImg) return;
    const threshold = parseInt($("logoThreshold").value) || 128;
    logoData = imageToLogoBitmap(logoImg, threshold);
    renderLogoPreview(getLogoDataForDisplay(), "logoPreview");
  });

  $("btnLogoWrite").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    if (!logoData) { setStatus("请先选择图片文件", "err"); return; }

    $("btnLogoWrite").disabled = true;
    $("logoProgress").style.display = "block";
    const bar = $("logoProgressBar");
    bar.style.width = "0%";
    try {
      const ver = await ensureSession();
      log(`固件版本：${ver}`);

      const L = proto.LOGO;
      let dataToWrite = logoData;

      // 处理反色
      if ($("logoInvert").checked) {
        dataToWrite = new Uint8Array(logoData.length);
        for (let i = 0; i < logoData.length; i++) {
          dataToWrite[i] = ~logoData[i] & 0xFF;
        }
      }

      // 构建完整数据：魔数 + 位图 + 填充
      const fullData = new Uint8Array(L.PADDED_SIZE);
      fullData.set(L.MAGIC, 0);
      fullData.set(dataToWrite, L.MAGIC_SIZE);
      // 填充区保持 0xFF（擦除态）

      // 分块写入（16 字节/块）
      for (let off = 0; off < L.TOTAL_SIZE; off += L.WRITE_CHUNK) {
        const payload = new Uint8Array(8 + L.WRITE_CHUNK);
        const dv = new DataView(payload.buffer);
        dv.setUint16(0, L.OFFSET + off, true);
        dv.setUint8(2, L.WRITE_CHUNK);
        dv.setUint8(3, 1); // bAllowPassword 标志位
        dv.setUint32(4, L.TS, true);
        payload.set(fullData.subarray(off, off + L.WRITE_CHUNK), 8);
        await writer.write(proto.buildFrame(proto.CMD.WRITE_EEPROM, payload));
        const resp = await waitForMsg(proto.CMD.WRITE_EEPROM_RESP, 1500);
        if (!resp) throw new Error(`写入 0x${(L.OFFSET + off).toString(16)} 超时`);
        if (resp.length < 6) throw new Error("写入回复过短");
        const wdv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
        if (wdv.getUint16(4, true) !== L.OFFSET + off) throw new Error("写入偏移回显不一致");
        bar.style.width = ((off + L.WRITE_CHUNK) / L.TOTAL_SIZE * 100).toFixed(1) + "%";
        if (off % 128 === 112) log(`写入 ${off + L.WRITE_CHUNK}/${L.TOTAL_SIZE}`);
      }

      bar.style.width = "100%";
      log("开机图片写入完成，发送重启命令...");
      await writer.write(proto.buildFrame(proto.CMD.REBOOT, new Uint8Array(0)));
      setStatus("✅ 开机图片已写入，对讲机正在重启生效", "ok");
      log("已重启");
    } catch (err) {
      setStatus("写入失败：" + err.message, "err");
      log("写入异常：" + err.message, "err");
    } finally {
      $("btnLogoWrite").disabled = false;
    }
  });

  $("btnLogoRead").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    $("btnLogoRead").disabled = true;
    try {
      const ver = await ensureSession();
      log(`固件版本：${ver}`);

      const L = proto.LOGO;
      const out = new Uint8Array(L.TOTAL_SIZE);

      // 分块读取（128 字节/块，与 CALIB.READ_CHUNK 一致）
      const READ_CHUNK = 128;
      for (let off = 0; off < L.TOTAL_SIZE; off += READ_CHUNK) {
        const n = Math.min(READ_CHUNK, L.TOTAL_SIZE - off);
        const payload = new Uint8Array(8);
        const dv = new DataView(payload.buffer);
        dv.setUint16(0, L.OFFSET + off, true);
        dv.setUint8(2, n);
        dv.setUint32(4, L.TS, true);
        await writer.write(proto.buildFrame(proto.CMD.READ_EEPROM, payload));
        const resp = await waitForMsg(proto.CMD.READ_EEPROM_RESP, 1500);
        if (!resp) throw new Error(`读取 0x${(L.OFFSET + off).toString(16)} 超时`);
        const rdv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
        if (rdv.getUint16(4, true) !== L.OFFSET + off) throw new Error("读取偏移回显不一致");
        out.set(resp.subarray(8, 8 + n), off);
        log(`读取 0x${(L.OFFSET + off).toString(16)} ~ 0x${(L.OFFSET + off + n).toString(16)}`);
      }

      // 验证魔数
      let magicValid = true;
      for (let i = 0; i < L.MAGIC_SIZE; i++) {
        if (out[i] !== L.MAGIC[i]) { magicValid = false; break; }
      }

      if (!magicValid) {
        setStatus("开机图片区无有效数据（魔数不匹配）", "warn");
        log("开机图片读取：魔数不匹配，可能为空");
        return;
      }

      // 提取位图并预览
      const bitmap = out.slice(L.MAGIC_SIZE, L.MAGIC_SIZE + L.BITMAP_SIZE);
      logoData = new Uint8Array(bitmap);
      logoImg = null; // 读取的是设备数据，无原图
      renderLogoPreview(getLogoDataForDisplay(), "logoPreview");
      $("btnLogoWrite").disabled = false;
      setStatus("✅ 已读取当前开机图片", "ok");
      log("开机图片读取完成");
    } catch (err) {
      setStatus("读取失败：" + err.message, "err");
      log("读取异常：" + err.message, "err");
    } finally {
      $("btnLogoRead").disabled = false;
    }
  });

  // ---------- 开机音效刷写（外部 SPI Flash 0x1F8000，12 KB） ----------
  // VOICE_SAMPLES 与固件 App/driver/startup_voice.c s_VoiceSamples[256] 完全一致
  const VOICE_SAMPLES = [
    0x06a8, 0x06b8, 0x0688, 0x0698, 0x06e8, 0x06f8, 0x06c8, 0x06d8,
    0x0628, 0x0638, 0x0608, 0x0618, 0x0668, 0x0678, 0x0648, 0x0658,
    0x0754, 0x075c, 0x0744, 0x074c, 0x0774, 0x077c, 0x0764, 0x076c,
    0x0714, 0x071c, 0x0704, 0x070c, 0x0734, 0x073c, 0x0724, 0x072c,
    0x02a0, 0x02e0, 0x0220, 0x0260, 0x03a0, 0x03e0, 0x0320, 0x0360,
    0x00a0, 0x00e0, 0x0020, 0x0060, 0x01a0, 0x01e0, 0x0120, 0x0160,
    0x0550, 0x0570, 0x0510, 0x0530, 0x05d0, 0x05f0, 0x0590, 0x05b0,
    0x0450, 0x0470, 0x0410, 0x0430, 0x04d0, 0x04f0, 0x0490, 0x04b0,
    0x07ea, 0x07eb, 0x07e8, 0x07e9, 0x07ee, 0x07ef, 0x07ec, 0x07ed,
    0x07e2, 0x07e3, 0x07e0, 0x07e1, 0x07e6, 0x07e7, 0x07e4, 0x07e5,
    0x07fa, 0x07fb, 0x07f8, 0x07f9, 0x07fe, 0x07ff, 0x07fc, 0x07fd,
    0x07f2, 0x07f3, 0x07f0, 0x07f1, 0x07f6, 0x07f7, 0x07f4, 0x07f5,
    0x07aa, 0x07ae, 0x07a2, 0x07a6, 0x07ba, 0x07be, 0x07b2, 0x07b6,
    0x078a, 0x078e, 0x0782, 0x0786, 0x079a, 0x079e, 0x0792, 0x0796,
    0x07d5, 0x07d7, 0x07d1, 0x07d3, 0x07dd, 0x07df, 0x07d9, 0x07db,
    0x07c5, 0x07c7, 0x07c1, 0x07c3, 0x07cd, 0x07cf, 0x07c9, 0x07cb,
    0x0958, 0x0948, 0x0978, 0x0968, 0x0918, 0x0908, 0x0938, 0x0928,
    0x09d8, 0x09c8, 0x09f8, 0x09e8, 0x0998, 0x0988, 0x09b8, 0x09a8,
    0x08ac, 0x08a4, 0x08bc, 0x08b4, 0x088c, 0x0884, 0x089c, 0x0894,
    0x08ec, 0x08e4, 0x08fc, 0x08f4, 0x08cc, 0x08c4, 0x08dc, 0x08d4,
    0x0d60, 0x0d20, 0x0de0, 0x0da0, 0x0c60, 0x0c20, 0x0ce0, 0x0ca0,
    0x0f60, 0x0f20, 0x0fe0, 0x0fa0, 0x0e60, 0x0e20, 0x0ee0, 0x0ea0,
    0x0ab0, 0x0a90, 0x0af0, 0x0ad0, 0x0a30, 0x0a10, 0x0a70, 0x0a50,
    0x0bb0, 0x0b90, 0x0bf0, 0x0bd0, 0x0b30, 0x0b10, 0x0b70, 0x0b50,
    0x0815, 0x0814, 0x0817, 0x0816, 0x0811, 0x0810, 0x0813, 0x0812,
    0x081d, 0x081c, 0x081f, 0x081e, 0x0819, 0x0818, 0x081b, 0x081a,
    0x0805, 0x0804, 0x0807, 0x0806, 0x0801, 0x0800, 0x0803, 0x0802,
    0x080d, 0x080c, 0x080f, 0x080e, 0x0809, 0x0808, 0x080b, 0x080a,
    0x0856, 0x0852, 0x085e, 0x085a, 0x0846, 0x0842, 0x084e, 0x084a,
    0x0876, 0x0872, 0x087e, 0x087a, 0x0866, 0x0862, 0x086e, 0x086a,
    0x082b, 0x0829, 0x082f, 0x082d, 0x0823, 0x0821, 0x0827, 0x0825,
    0x083b, 0x0839, 0x083f, 0x083d, 0x0833, 0x0831, 0x0837, 0x0835,
  ];

  function nearestVoiceIndex(v) {
    let best = 0, bestDiff = 0xFFFF;
    for (let i = 0; i < 256; i++) {
      const diff = Math.abs(VOICE_SAMPLES[i] - v);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  function encodePcm16ToVoice(pcm16) {
    const out = new Uint8Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      let v = ((pcm16[i] + 32768) >> 4);
      if (v < 0) v = 0;
      if (v > 4095) v = 4095;
      out[i] = nearestVoiceIndex(v);
    }
    return out;
  }

  function buildBootAudioBin(encodedData) {
    const dataLen = encodedData.length;
    const rawLen = 4 + dataLen;
    const paddedLen = Math.ceil(rawLen / 4096) * 4096;
    const bin = new Uint8Array(paddedLen);
    bin.fill(0xFF);
    new DataView(bin.buffer).setUint32(0, dataLen >>> 0, true);
    bin.set(encodedData, 4);
    return bin;
  }

  let bootAudioBin = null;
  let bootAudioRawFileBuf = null;
  let bootAudioPreviewUrl = null;

  const audioDropZone = () => $("audioDropZone");
  const audioFileInput = () => $("audioFileInput");
  const audioInfo = () => $("audioInfo");
  const bootAudioStatus = () => $("bootAudioStatus");

  function updateAudioInfo(text, cls) {
    const el = audioInfo();
    if (el) el.textContent = text;
  }
  function updateBootAudioStatus(text, cls) {
    const el = bootAudioStatus();
    if (el) el.textContent = text;
  }

  function bootAudioResetState() {
    bootAudioBin = null;
    bootAudioRawFileBuf = null;
    if (bootAudioPreviewUrl) { try { URL.revokeObjectURL(bootAudioPreviewUrl); } catch (_) {} bootAudioPreviewUrl = null; }
    const preview = $("audioPreview");
    if (preview) { preview.removeAttribute("src"); preview.style.display = "none"; }
    const wBtn = $("btnBootAudioWrite");
    const eBtn = $("btnBootAudioExport");
    if (wBtn) wBtn.disabled = true;
    if (eBtn) eBtn.disabled = true;
  }

  async function processAudioFile(file) {
    bootAudioResetState();
    if (!file) return;
    updateAudioInfo("正在解码音频...");
    updateBootAudioStatus("");
    try {
      const arrayBuffer = await file.arrayBuffer();
      bootAudioRawFileBuf = new Uint8Array(arrayBuffer);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("当前浏览器不支持 AudioContext，无法解码音频");
      const audioCtx = new AudioCtx();
      let audioBuffer;
      try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        try { await audioCtx.close(); } catch (_) {}
      }
      const duration = audioBuffer.duration;
      const targetSamples = Math.ceil(duration * 8000);
      if (targetSamples === 0) throw new Error("音频时长为 0");
      const offline = new OfflineAudioContext(1, targetSamples, 8000);
      const src = offline.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(offline.destination);
      src.start(0);
      const resampled = await offline.startRendering();
      let floatData = resampled.getChannelData(0);
      let floatLen = floatData.length;
      let pcm16 = new Int16Array(floatLen);
      for (let i = 0; i < floatLen; i++) {
        let v = floatData[i];
        if (v > 1) v = 1; if (v < -1) v = -1;
        pcm16[i] = Math.round(v * 32767);
      }
      if ($("audioNormalize") && $("audioNormalize").checked) {
        let peak = 0;
        for (let i = 0; i < pcm16.length; i++) { const a = Math.abs(pcm16[i]); if (a > peak) peak = a; }
        if (peak > 0 && peak < 32767) {
          const gain = (32767 * 0.95) / peak;
          for (let i = 0; i < pcm16.length; i++) {
            let v = Math.round(pcm16[i] * gain);
            if (v > 32767) v = 32767; if (v < -32768) v = -32768;
            pcm16[i] = v;
          }
        }
      }
      const encoded = encodePcm16ToVoice(pcm16);
      const bin = buildBootAudioBin(encoded);
      const BA = proto.BOOT_AUDIO;
      if (bin.length > BA.FLASH_SIZE) {
        throw new Error("音频过长：bin " + bin.length + " 字节超过 " + BA.FLASH_SIZE + " 字节（12 KB），请缩短到 1.5 秒以内");
      }
      if (encoded.length > BA.RECOMMENDED_MAX_SIZE) {
        log("提示：音频数据 " + encoded.length + " 字节超过建议 8 KB（约 1 秒），可能接近上限", "info");
      }
      bootAudioBin = bin;
      const durStr = duration.toFixed(2) + "s（转码后 " + (encoded.length / 8000).toFixed(2) + "s @" + "8kHz）";
      updateAudioInfo("已加载：" + file.name + "  原时长 " + durStr + "  编码 " + encoded.length + " 字节  bin " + bin.length + " 字节（" + (bin.length / 1024).toFixed(1) + " KB）");
      updateBootAudioStatus("已就绪，点“写入开机音效”刷入（需先连接串口）");
      const wBtn = $("btnBootAudioWrite");
      const eBtn = $("btnBootAudioExport");
      if (wBtn) wBtn.disabled = false;
      if (eBtn) eBtn.disabled = false;
      const blob = new Blob([bootAudioRawFileBuf], { type: file.type || "audio/*" });
      bootAudioPreviewUrl = URL.createObjectURL(blob);
      const preview = $("audioPreview");
      if (preview) { preview.src = bootAudioPreviewUrl; preview.style.display = "block"; }
      log("开机音效已处理：" + file.name + "（" + encoded.length + " 字节，bin " + bin.length + " 字节）");
    } catch (err) {
      bootAudioBin = null;
      updateAudioInfo("处理失败：" + err.message);
      updateBootAudioStatus("");
      log("开机音效处理失败：" + err.message, "err");
    }
  }

  // 开机音效：文件选择
  const _afInput = $("audioFileInput");
  if (_afInput) {
    _afInput.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await processAudioFile(f);
    });
  }
  const _adZone = $("audioDropZone");
  if (_adZone) {
    _adZone.addEventListener("click", () => { const inp = $("audioFileInput"); if (inp) inp.click(); });
    _adZone.addEventListener("dragover", (e) => { e.preventDefault(); _adZone.style.borderColor = "#2f6fdc"; _adZone.style.background = "#f0f6ff"; });
    _adZone.addEventListener("dragleave", () => { _adZone.style.borderColor = ""; _adZone.style.background = ""; });
    _adZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      _adZone.style.borderColor = ""; _adZone.style.background = "";
      const f = e.dataTransfer.files[0];
      if (!f) return;
      await processAudioFile(f);
    });
  }

  // 开机音效：导出 bin
  const _btnExport = $("btnBootAudioExport");
  if (_btnExport) {
    _btnExport.addEventListener("click", () => {
      if (!bootAudioBin) { setStatus("请先选择并处理音频文件", "err"); return; }
      const blob = new Blob([bootAudioBin], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "startup_voice.bin"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      log("开机音效 bin 已导出：startup_voice.bin（" + bootAudioBin.length + " 字节）");
    });
  }

  // 开机音效：写入
  const _btnWrite = $("btnBootAudioWrite");
  if (_btnWrite) {
    _btnWrite.addEventListener("click", async () => {
      if (!port) { setStatus("请先连接串口", "err"); return; }
      if (!bootAudioBin) { setStatus("请先选择音频文件", "err"); return; }
      const BA = proto.BOOT_AUDIO;
      if (bootAudioBin.length > BA.FLASH_SIZE) { setStatus("bin 过大（" + bootAudioBin.length + " 字节），超过 12 KB 上限", "err"); return; }
      if (bootAudioBin.length % BA.SECTOR_SIZE !== 0) { setStatus("bin 未按 4 KB 对齐（" + bootAudioBin.length + " 字节）", "err"); return; }
      _btnWrite.disabled = true;
      const progress = $("bootAudioProgress");
      const bar = $("bootAudioProgressBar");
      if (progress) progress.style.display = "block";
      if (bar) bar.style.width = "0%";
      try {
        const needSectors = bootAudioBin.length / BA.SECTOR_SIZE;
        log("擦除开机音效区（" + needSectors + " 个扇区）...");
        updateBootAudioStatus("正在擦除...");
        for (let s = 0; s < needSectors; s++) {
          const payload = new Uint8Array(4);
          new DataView(payload.buffer).setUint16(0, s, true);
          const r = await sendCommand(proto.CMD.BOOT_AUDIO_ERASE, payload);
          if (r.status !== 0) throw new Error("扇区 " + s + " 擦除失败 status=" + r.status);
          if (bar) bar.style.width = ((s + 1) / needSectors * 30).toFixed(1) + "%";
          log("擦除 " + (s + 1) + "/" + needSectors);
        }
        const total = bootAudioBin.length, chunk = BA.CHUNK;
        log("写入开机音效数据（" + total + " 字节，chunk " + chunk + "）...");
        updateBootAudioStatus("正在写入...");
        await new Promise((r) => setTimeout(r, 100));
        for (let off = 0; off < total; off += chunk) {
          const n = Math.min(chunk, total - off);
          const payload = new Uint8Array(4 + n);
          new DataView(payload.buffer).setUint32(0, off, true);
          payload.set(bootAudioBin.subarray(off, off + n), 4);
          const r = await sendCommand(proto.CMD.BOOT_AUDIO_WRITE, payload);
          if (r.status !== 0) throw new Error("偏移 0x" + off.toString(16) + " 写入失败 status=" + r.status);
          if (bar) bar.style.width = (30 + (off + n) / total * 70).toFixed(1) + "%";
          if ((off / chunk) % 50 === 49 || off + n === total) log("写入 " + (off + n) + "/" + total);
        }
        if (bar) bar.style.width = "100%";
        log("开机音效写入完成，发送重启命令...");
        await writer.write(proto.buildFrame(proto.CMD.REBOOT, new Uint8Array(0)));
        setStatus("✅ 开机音效刷入完成，对讲机正在重启生效", "ok");
        updateBootAudioStatus("✅ 刷入完成，重启生效");
        log("开机音效刷入完成");
      } catch (err) {
        setStatus("开机音效刷入失败：" + err.message, "err");
        updateBootAudioStatus("失败：" + err.message);
        log("开机音效刷入异常：" + err.message, "err");
      } finally {
        _btnWrite.disabled = false;
      }
    });
  }

  // 开机音效：关闭（擦除长度头所在扇区）
  const _btnDisable = $("btnBootAudioDisable");
  if (_btnDisable) {
    _btnDisable.addEventListener("click", async () => {
      if (!port) { setStatus("请先连接串口", "err"); return; }
      if (!confirm("确定要关闭开机音效吗？这会擦除 0x1F8000 扇区，长度头变为 0xFF（禁用播放）。")) return;
      _btnDisable.disabled = true;
      try {
        log("关闭开机音效：擦除 sector 0（0x1F8000）...");
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint16(0, 0, true);
        const r = await sendCommand(proto.CMD.BOOT_AUDIO_ERASE, payload);
        if (r.status !== 0) throw new Error("擦除失败 status=" + r.status);
        setStatus("✅ 已关闭开机音效（长度头已擦为 0xFF），重启后生效", "ok");
        updateBootAudioStatus("已关闭，需重启生效");
        log("开机音效已关闭");
      } catch (err) {
        setStatus("关闭失败：" + err.message, "err");
        log("关闭开机音效异常：" + err.message, "err");
      } finally {
        _btnDisable.disabled = false;
      }
    });
  }

  // 开机音效：读取校验
  const _btnCheck = $("btnBootAudioCheck");
  if (_btnCheck) {
    _btnCheck.addEventListener("click", async () => {
      if (!port) { setStatus("请先连接串口", "err"); return; }
      _btnCheck.disabled = true;
      try {
        log("读取开机音效区校验（0x1F8000 起 128 字节）...");
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, 0, true);
        const reply = await sendAndWaitRaw(proto.CMD.BOOT_AUDIO_READ, payload, 5000);
        const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
        if (dv.getUint16(0, true) !== proto.CMD.REPLY_BOOT_AUDIO_READ) throw new Error("回复 ID 不符");
        const echo = dv.getUint32(4, true);
        if (echo !== 0) throw new Error("偏移回显不一致 0x" + echo.toString(16));
        const data = reply.slice(8, 8 + 128);
        const len = data.length >= 4 ? (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0 : 0xFFFFFFFF;
        const allFF = data.every((b) => b === 0xFF);
        if (allFF || len === 0xFFFFFFFF || len === 0) {
          setStatus("开机音效区为空（长度头 0xFF/0），未设置开机音效", "warn");
          updateBootAudioStatus("校验：为空，未设置音效");
          log("开机音效校验：为空");
        } else {
          const binSize = Math.ceil((4 + len) / 4096) * 4096;
          const dur = (len / 8000).toFixed(2) + "s";
          setStatus("✅ 开机音效已存在：数据 " + len + " 字节（约 " + dur + "），bin " + binSize + " 字节", "ok");
          updateBootAudioStatus("校验：存在，" + len + " 字节 / " + dur);
          log("开机音效校验：长度 " + len + " 字节，约 " + dur);
        }
      } catch (err) {
        setStatus("读取校验失败：" + err.message, "err");
        log("开机音效校验异常：" + err.message, "err");
      } finally {
        _btnCheck.disabled = false;
      }
    });
  }

  // 开机音效：备份到电脑（完整读出 0x1F8000 全部 12KB → 本地 .bin）
  const _btnBootAudioBackup = $("btnBootAudioBackup");
  if (_btnBootAudioBackup) {
    _btnBootAudioBackup.addEventListener("click", async () => {
      if (!port) { setStatus("请先连接串口", "err"); return; }
      _btnBootAudioBackup.disabled = true;
      try {
        const BA = proto.BOOT_AUDIO;
        const READ_CHUNK = 128;
        const out = new Uint8Array(BA.FLASH_SIZE);
        log("备份开机音效区（" + BA.FLASH_SIZE + " 字节，约 " + (BA.FLASH_SIZE / READ_CHUNK) + " 帧）...");
        updateBootAudioStatus("正在备份到电脑...");
        for (let off = 0; off < BA.FLASH_SIZE; off += READ_CHUNK) {
          const payload = new Uint8Array(4);
          new DataView(payload.buffer).setUint32(0, off, true);
          const reply = await sendAndWaitRaw(proto.CMD.BOOT_AUDIO_READ, payload, 5000);
          const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
          if (dv.getUint16(0, true) !== proto.CMD.REPLY_BOOT_AUDIO_READ) throw new Error("回复 ID 不符");
          const echo = dv.getUint32(4, true);
          if (echo !== off) throw new Error("偏移回显不一致 0x" + echo.toString(16));
          out.set(reply.slice(8, 8 + Math.min(128, BA.FLASH_SIZE - off)), off);
        }
        // 非严格校验，仅提示；为空时也允许备份（内容为全 FF）
        const allFF = out.every((b) => b === 0xFF);
        const blob = new Blob([out], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = allFF ? "startup_voice_backup_empty.bin" : "startup_voice_backup.bin";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        if (allFF) {
          setStatus("备份完成：当前区为空（全 0xFF），已导出空备份文件", "warn");
          updateBootAudioStatus("备份完成：为空");
          log("开机音效备份完成：为空（全 FF）");
        } else {
          const dataLen = out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24);
          setStatus("✅ 已备份到电脑：startup_voice_backup.bin（12 KB，数据 " + dataLen + " 字节）", "ok");
          updateBootAudioStatus("✅ 已备份 12 KB");
          log("开机音效备份完成：12 KB（数据 " + dataLen + " 字节）");
        }
      } catch (err) {
        setStatus("备份失败：" + err.message, "err");
        updateBootAudioStatus("备份失败：" + err.message);
        log("开机音效备份异常：" + err.message, "err");
      } finally {
        _btnBootAudioBackup.disabled = false;
      }
    });
  }

  // ---------- 校准数据导出 / 导入（EEPROM 仿真区 0xB000..0xB200，512 字节） ----------

  // 会话握手：发 0x0514 建立时间戳，等 0x0515 版本回复
  async function ensureSession() {
    const ts = new Uint8Array(4);
    new DataView(ts.buffer).setUint32(0, proto.CALIB.TS, true);
    await writer.write(proto.buildFrame(proto.CMD.DEV_INFO_REQ, ts));
    const resp = await waitForMsg(proto.CMD.DEV_INFO_RESP, 1500);
    if (!resp) throw new Error("握手超时（请确认对讲机处于正常开机状态，不是刷机模式）");
    let ver = "";
    for (let i = 4; i < Math.min(resp.length, 20) && resp[i] !== 0; i++) ver += String.fromCharCode(resp[i]);
    return ver;
  }

  $("btnCalExp").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    $("btnCalExp").disabled = true;
    try {
      const ver = await ensureSession();
      log(`固件版本：${ver}`);
      const C = proto.CALIB;
      const out = new Uint8Array(C.SIZE);
      for (let off = 0; off < C.SIZE; off += C.READ_CHUNK) {
        const payload = new Uint8Array(8);
        const dv = new DataView(payload.buffer);
        dv.setUint16(0, C.OFFSET + off, true);
        dv.setUint8(2, C.READ_CHUNK);
        dv.setUint32(4, C.TS, true);
        await writer.write(proto.buildFrame(proto.CMD.READ_EEPROM, payload));
        const resp = await waitForMsg(proto.CMD.READ_EEPROM_RESP, 1500);
        if (!resp) throw new Error(`读取 0x${(C.OFFSET + off).toString(16)} 超时`);
        const rdv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
        if (rdv.getUint16(4, true) !== C.OFFSET + off) throw new Error("读取偏移回显不一致");
        out.set(resp.subarray(8, 8 + C.READ_CHUNK), off);
        log(`读取 0x${(C.OFFSET + off).toString(16)} ~ 0x${(C.OFFSET + off + C.READ_CHUNK).toString(16)}`);
      }
      const blob = new Blob([out], { type: "application/octet-stream" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "calibration.dat";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus("✅ 校准数据已导出为 calibration.dat", "ok");
      log("校准数据导出完成");
    } catch (err) {
      setStatus("导出失败：" + err.message, "err");
      log("导出异常：" + err.message, "err");
    } finally {
      $("btnCalExp").disabled = false;
    }
  });

  let calData = null;

  $("calFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    calData = null;
    $("btnCalImp").disabled = true;
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length !== proto.CALIB.SIZE) {
      setStatus(`校准文件大小无效：${buf.length} 字节，应为 ${proto.CALIB.SIZE}`, "err");
      return;
    }
    calData = buf;
    $("btnCalImp").disabled = false;
    log(`校准文件已加载：${f.name}（${buf.length} 字节）`);
  });

  $("btnCalImp").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    if (!calData) { setStatus("请先选择校准文件", "err"); return; }
    if (!confirm("确认导入？写错校准数据会导致频率/功率/电量异常，请确认文件来自本机。")) return;

    $("btnCalImp").disabled = true;
    $("calProgress").style.display = "block";
    const bar = $("calProgressBar");
    bar.style.width = "0%";
    try {
      const ver = await ensureSession();
      log(`固件版本：${ver}`);
      const C = proto.CALIB;
      for (let off = 0; off < C.SIZE; off += C.WRITE_CHUNK) {
        const payload = new Uint8Array(8 + C.WRITE_CHUNK);
        const dv = new DataView(payload.buffer);
        dv.setUint16(0, C.OFFSET + off, true);
        dv.setUint8(2, C.WRITE_CHUNK);
        dv.setUint8(3, 1); // bAllowPassword 标志位（uvtools 约定）
        dv.setUint32(4, C.TS, true);
        payload.set(calData.subarray(off, off + C.WRITE_CHUNK), 8);
        await writer.write(proto.buildFrame(proto.CMD.WRITE_EEPROM, payload));
        const resp = await waitForMsg(proto.CMD.WRITE_EEPROM_RESP, 1500);
        if (!resp) throw new Error(`写入 0x${(C.OFFSET + off).toString(16)} 超时`);
        const wdv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
        if (resp.length < 6 || wdv.getUint16(4, true) !== C.OFFSET + off)
          throw new Error(`写入 0x${(C.OFFSET + off).toString(16)} 回显不一致`);
        bar.style.width = ((off + C.WRITE_CHUNK) / C.SIZE * 100).toFixed(1) + "%";
        if (off % 64 === 48) log(`写入 ${off + C.WRITE_CHUNK}/${C.SIZE}`);
      }
      bar.style.width = "100%";
      log("校准数据写入完成，发送重启命令...");
      await writer.write(proto.buildFrame(proto.CMD.REBOOT, new Uint8Array(0)));
      setStatus("✅ 校准数据已导入，对讲机正在重启生效", "ok");
      log("已重启");
    } catch (err) {
      setStatus("导入失败：" + err.message, "err");
      log("导入异常：" + err.message, "err");
    } finally {
      $("btnCalImp").disabled = false;
    }
  });

  // ---------- 写频（写信道） ----------
  async function readEepromBlock(offset, size) {
    const payload = new Uint8Array(8);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, offset, true);
    dv.setUint8(2, size);
    dv.setUint32(4, proto.CALIB.TS, true);
    await writer.write(proto.buildFrame(proto.CMD.READ_EEPROM, payload));
    const resp = await waitForMsg(proto.CMD.READ_EEPROM_RESP, 1500);
    if (!resp) throw new Error(`读取 0x${offset.toString(16)} 超时`);
    const rdv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    if (rdv.getUint16(4, true) !== offset) throw new Error("读取偏移回显不一致");
    return resp.subarray(8, 8 + size);
  }

  async function writeEepromBlock(offset, data, flag = 1) {
    if (data.length % 8 !== 0) throw new Error("EEPROM 写入长度必须是 8 的倍数");
    for (let i = 0; i < data.length; i += 8) {
      const payload = new Uint8Array(8 + 8);
      const dv = new DataView(payload.buffer);
      dv.setUint16(0, offset + i, true);
      dv.setUint8(2, 8);
      dv.setUint8(3, flag);
      dv.setUint32(4, proto.CALIB.TS, true);
      payload.set(data.subarray(i, i + 8), 8);
      await writer.write(proto.buildFrame(proto.CMD.WRITE_EEPROM, payload));
      const resp = await waitForMsg(proto.CMD.WRITE_EEPROM_RESP, 1500);
      if (!resp) throw new Error(`写入 0x${(offset + i).toString(16)} 超时`);
      if (resp.length < 6) throw new Error("写入回复过短");
      const wdv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
      if (wdv.getUint16(4, true) !== offset + i) throw new Error("写入偏移回显不一致");
    }
  }

  async function writeChannel(channel, params) {
    const C = proto.CHAN;
    if (channel < 0 || channel >= C.MAX_COUNT) throw new Error(`信道号 ${channel + 1} 超出范围 1~${C.MAX_COUNT}`);

    // 1. 写频率/参数区
    const freqBlock = proto.buildChannelBlock(params);
    await writeEepromBlock(channel * C.SIZE, freqBlock);

    // 2. 写名称区（GB2312 编码，最多 10 字节）
    let nameBytes;
    const gb = window.K5WEB && window.K5WEB.gb2312;
    if (gb) {
      const nameEnc = gb.encode(params.name || "");
      if (!nameEnc.ok) throw new Error(`信道名包含无法编码的字符："${nameEnc.char}"，请使用中文字库已覆盖的汉字或 ASCII`);
      if (nameEnc.bytes.length > 10) throw new Error(`信道名编码后 ${nameEnc.bytes.length} 字节，超过 10 字节限制（中文每个字 2 字节）`);
      nameBytes = nameEnc.bytes;
    } else {
      // fallback：仅 ASCII
      const ascii = new TextEncoder().encode((params.name || "").replace(/[^\x20-\x7E]/g, ""));
      if (ascii.length > 10) throw new Error("信道名超过 10 字节（GB2312 编码表未加载，仅支持 ASCII）");
      nameBytes = ascii;
    }
    const nameBuf = new Uint8Array(C.NAME_SIZE);
    nameBuf.set(nameBytes, 0);
    await writeEepromBlock(C.NAME_BASE + channel * C.NAME_SIZE, nameBuf);

    // 3. 属性区：8 字节对齐读写，避免跨属性覆盖
    const attrOffset = C.ATTR_BASE + channel * C.ATTR_SIZE;
    const alignBase = attrOffset - (attrOffset % C.ATTR_ALIGN); // 8 字节对齐基址
    const attrInBlock = attrOffset - alignBase; // 在 8 字节块内的偏移（0 或 2）
    const attrBlock = new Uint8Array(await readEepromBlock(alignBase, C.ATTR_ALIGN));
    const attr = proto.buildChannelAttributes({
      band: proto.bandFromFrequency(params.rxFreq10Hz),
      compander: 0,
      exclude: 0,
      scanlist: params.scanlist || 0,
    });
    attrBlock.set(attr, attrInBlock);
    await writeEepromBlock(alignBase, attrBlock);
  }

  function parseToneInput(value, type) {
    const s = (value || "").trim();
    if (!s || type === proto.CODE_TYPE.OFF) return { code: 0, codeType: proto.CODE_TYPE.OFF };
    if (type === proto.CODE_TYPE.CTCSS) {
      const hz = Math.round(parseFloat(s) * 10);
      return { code: proto.ctcssIndex(hz), codeType: proto.CODE_TYPE.CTCSS };
    }
    // DCS：支持 "023" / "D023" / "023N" / "I023" / "023I"（DCS 码为八进制）
    const m = s.match(/^[DI]?(\d{3})$/i);
    if (!m) return { code: 0, codeType: proto.CODE_TYPE.OFF };
    const code = parseInt(m[1], 8);
    const idx = proto.dcsIndex(code);
    const codeType = (type === proto.CODE_TYPE.DCS_REV || /^I/i.test(s)) ? proto.CODE_TYPE.DCS_REV : proto.CODE_TYPE.DCS;
    return { code: idx, codeType };
  }

  function collectChannelParams() {
    const rxMHz = parseFloat($("chRxFreq").value);
    let txMHz = parseFloat($("chTxFreq").value);
    const dirSel = parseInt($("chTxDir").value, 10);
    const offsetMHz = parseFloat($("chTxOffset").value) || 0;
    if (isNaN(rxMHz) || rxMHz <= 0) throw new Error("接收频率无效");
    if (isNaN(txMHz) || txMHz <= 0) {
      if (dirSel === proto.TX_DIR.OFF) txMHz = rxMHz;
      else txMHz = rxMHz + (dirSel === proto.TX_DIR.ADD ? offsetMHz : -offsetMHz);
      if (txMHz <= 0) throw new Error("按差频计算的发射频率无效");
    }
    // 固件 offset 4 存的是频差值（不是绝对发射频率），方向存 byte11 低半字节；
    // 由 RX/TX 反推，保证两者始终一致
    const rxFreq10Hz = Math.round(rxMHz * 100000);
    const diff10Hz = Math.round(txMHz * 100000) - rxFreq10Hz;
    const txDir = diff10Hz > 0 ? proto.TX_DIR.ADD : diff10Hz < 0 ? proto.TX_DIR.SUB : proto.TX_DIR.OFF;
    const rxTone = parseToneInput($("chRxTone").value, parseInt($("chRxToneType").value, 10));
    const txTone = parseToneInput($("chTxTone").value, parseInt($("chTxToneType").value, 10));

    return {
      name: $("chName").value,
      rxFreq10Hz: rxFreq10Hz,
      txOffsetFreq10Hz: Math.abs(diff10Hz),
      rxCodeType: rxTone.codeType,
      rxCode: rxTone.code,
      txCodeType: txTone.codeType,
      txCode: txTone.code,
      modulation: parseInt($("chModulation").value, 10),
      txDir: txDir,
      bandwidth: parseInt($("chBandwidth").value, 10),
      power: parseInt($("chPower").value, 10),
      txLock: 0, // 默认允许发射；如需禁用可后续扩展
      bcl: 0,
      freqReverse: 0,
      pttId: 0,
      step: parseInt($("chStep").value, 10),
      scanlist: 0,
    };
  }

  // 发射频率 ↔ 差频方向+差频 联动：改一边自动算另一边。
  // chFreqLink 记录最后编辑的字段组，接收频率变化时以该组为准重算另一边。
  let chFreqLink = "tx"; // "tx"=发射频率为准, "offset"=差频方向+差频为准
  function updateOffsetFieldState() {
    // 方向为"无"时差频值无意义，禁止编辑
    $("chTxOffset").disabled = parseInt($("chTxDir").value, 10) === proto.TX_DIR.OFF;
  }
  function syncOffsetFromTx() {
    const rx = parseFloat($("chRxFreq").value);
    const tx = parseFloat($("chTxFreq").value);
    if (isNaN(rx) || rx <= 0 || isNaN(tx) || tx <= 0) return;
    const diff = tx - rx;
    $("chTxDir").value = diff > 0 ? "1" : diff < 0 ? "2" : "0";
    $("chTxOffset").value = Math.abs(diff).toFixed(4);
    updateOffsetFieldState();
  }
  function syncTxFromOffset() {
    const rx = parseFloat($("chRxFreq").value);
    if (isNaN(rx) || rx <= 0) return;
    const dir = parseInt($("chTxDir").value, 10);
    const off = parseFloat($("chTxOffset").value) || 0;
    const tx = dir === proto.TX_DIR.OFF ? rx : rx + (dir === proto.TX_DIR.ADD ? off : -off);
    if (tx > 0) $("chTxFreq").value = tx.toFixed(5);
  }
  $("chRxFreq").addEventListener("input", () => { chFreqLink === "offset" ? syncTxFromOffset() : syncOffsetFromTx(); });
  $("chTxFreq").addEventListener("input", () => { chFreqLink = "tx"; syncOffsetFromTx(); });
  $("chTxDir").addEventListener("change", () => { chFreqLink = "offset"; updateOffsetFieldState(); syncTxFromOffset(); });
  $("chTxOffset").addEventListener("input", () => { chFreqLink = "offset"; syncTxFromOffset(); });
  syncOffsetFromTx(); // 初始化：按默认 RX/TX 推出方向+差频，并设置差频框可编辑状态

  $("btnChProg").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    const channel = parseInt($("chNum").value, 10) - 1;
    if (isNaN(channel) || channel < 0 || channel >= proto.CHAN.MAX_COUNT) {
      setStatus(`信道号无效，应为 1~${proto.CHAN.MAX_COUNT}`, "err"); return;
    }
    $("btnChProg").disabled = true;
    $("chProgProgress").style.display = "block";
    $("chProgProgressBar").style.width = "0%";
    $("chReadResult").style.display = "none";
    try {
      await ensureSession();
      const params = collectChannelParams();
      await writeChannel(channel, params);
      $("chProgProgressBar").style.width = "100%";
      setStatus(`✅ 信道 ${channel + 1} 写入完成！建议重启对讲机或切换信道使其生效`, "ok");
      log(`写频完成：CH${channel + 1} ${(params.rxFreq10Hz / 100000).toFixed(5)} MHz，名称字节：${Array.from((window.K5WEB.gb2312 || { encode: () => ({ ok: true, bytes: new Uint8Array() }) }).encode(params.name || "").bytes).map(b => b.toString(16).padStart(2, "0")).join(" ") || "(空)"}`);
    } catch (err) {
      setStatus("写频失败：" + err.message, "err");
      log("写频异常：" + err.message, "err");
    } finally {
      $("btnChProg").disabled = false;
    }
  });

  $("btnChRead").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    const channel = parseInt($("chNum").value, 10) - 1;
    if (isNaN(channel) || channel < 0 || channel >= proto.CHAN.MAX_COUNT) {
      setStatus(`信道号无效，应为 1~${proto.CHAN.MAX_COUNT}`, "err"); return;
    }
    $("btnChRead").disabled = true;
    $("chReadResult").style.display = "none";
    try {
      await ensureSession();
      const C = proto.CHAN;
      const nameBytes = await readEepromBlock(C.NAME_BASE + channel * C.NAME_SIZE, C.NAME_SIZE);
      const freqBytes = await readEepromBlock(channel * C.SIZE, C.SIZE);
      const rx10 = new DataView(freqBytes.buffer, freqBytes.byteOffset).getUint32(0, true);
      // offset 4 是频差值（10Hz），方向在 byte11 低半字节；发射频率 = 接收 ± 频差
      let off10 = new DataView(freqBytes.buffer, freqBytes.byteOffset).getUint32(4, true);
      const txDir = freqBytes[11] & 0x0F;
      if (off10 === 0xFFFFFFFF) off10 = 0;
      if (off10 >= 100000000) off10 = 1000000; // 与固件 radio.c 的上限一致
      const tx10 = txDir === proto.TX_DIR.ADD ? rx10 + off10 : txDir === proto.TX_DIR.SUB ? rx10 - off10 : rx10;
      const dirText = txDir === proto.TX_DIR.ADD ? "上差频（+）" : txDir === proto.TX_DIR.SUB ? "下差频（−）" : "无";
      const hex = Array.from(nameBytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
      // 优先用 GB2312 解码库直接显示中文；库缺失时回退十六进制占位解析
      let decoded = "";
      if (gb) {
        decoded = gb.decode(nameBytes);
      }
      if (!decoded) {
        for (let i = 0; i < nameBytes.length; i++) {
          const b = nameBytes[i];
          if (b === 0) break;
          if (b >= 0xA1 && i + 1 < nameBytes.length && nameBytes[i + 1] >= 0xA1) {
            decoded += `[${b.toString(16)}${nameBytes[i + 1].toString(16)}]`;
            i++;
          } else if (b >= 0x20 && b < 0x7F) {
            decoded += String.fromCharCode(b);
          } else {
            decoded += `?0x${b.toString(16)}`;
          }
        }
      }
      const r = $("chReadResult");
      r.style.display = "block";
      r.innerHTML = `
        <b>CH${channel + 1} 读取校验</b><br>
        接收频率：${(rx10 / 100000).toFixed(5)} MHz<br>
        差频方向：${dirText}　差频：${(off10 / 100000).toFixed(4)} MHz<br>
        发射频率：${(tx10 / 100000).toFixed(5)} MHz<br>
        名称区十六进制：${hex}<br>
        名称解码（GB2312）：${decoded || "(空白)"}
      `;
      log(`读取 CH${channel + 1}：RX=${(rx10 / 100000).toFixed(5)} 频差=${dirText} ${(off10 / 100000).toFixed(4)} TX=${(tx10 / 100000).toFixed(5)} 名称="${decoded}" [${hex}]`);
    } catch (err) {
      setStatus("读取失败：" + err.message, "err");
      log("读取异常：" + err.message, "err");
    } finally {
      $("btnChRead").disabled = false;
    }
  });

  // ---------- 批量导入（叮咚鸡 xlsx / 叮咚鸡 CSV / 旧版 CSV） ----------
  // 读取文件为行数组：xlsx 用 SheetJS 取第一个 sheet，CSV/TXT 先按 UTF-8 解码，
  // 失败（Excel 另存的 GBK 编码）再回退 GBK，避免中文信道名乱码。
  async function parseChannelFile(f) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
      if (typeof XLSX === "undefined")
        throw new Error("xlsx 解析库未加载（vendor/xlsx.full.min.js 缺失）");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("xlsx 中没有工作表");
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
      return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
    }
    const buf = await f.arrayBuffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      text = new TextDecoder("gbk").decode(buf);
    }
    return text.split(/\r?\n/).map((l) => l.split(",").map((s) => s.trim()))
      .filter((r) => r.some((c) => c !== ""));
  }

  let chCsvData = null;
  let chTablePage = 1;
  const CH_PAGE_SIZE = 10;

  const BANDWIDTH_OPTIONS = [{ label: "宽带", value: 0 }, { label: "窄带", value: 1 }];
  const POWER_OPTIONS = ["USER","LOW1","LOW2","LOW3","LOW4","LOW5","MID","HIGH"].map((l, i) => ({ label: l, value: i }));
  const MOD_OPTIONS = ["FM","AM","USB"].map((l, i) => ({ label: l, value: i }));
  const DIR_OPTIONS = ["关闭","+","−"].map((l, i) => ({ label: l, value: i }));
  const TONE_OPTIONS = (function() {
    const opts = [{ label: "OFF", codeType: 0, code: 0 }];
    for (let i = 0; i < proto.CTCSS_OPTIONS.length; i++) {
      opts.push({ label: (proto.CTCSS_OPTIONS[i] / 10).toFixed(1) + "Hz", codeType: 1, code: i });
    }
    for (let i = 0; i < proto.DCS_OPTIONS.length; i++) {
      const dcs = proto.DCS_OPTIONS[i];
      opts.push({ label: "D" + dcs.toString(8).padStart(3, "0"), codeType: 2, code: i });
      opts.push({ label: "I" + dcs.toString(8).padStart(3, "0"), codeType: 3, code: i });
    }
    return opts;
  })();

  function fmtMhz(freq10Hz) {
    return (freq10Hz / 100000).toFixed(5) + " MHz";
  }

  function renderChannelTable(parsedRows) {
    const tb = $("chPreviewTbody");
    const totalPages = Math.max(1, Math.ceil((parsedRows.length || 0) / CH_PAGE_SIZE));
    if (chTablePage > totalPages) chTablePage = totalPages;
    const start = (chTablePage - 1) * CH_PAGE_SIZE;
    const pageRows = parsedRows.slice(start, start + CH_PAGE_SIZE);
    const rowCount = Math.max(pageRows.length, CH_PAGE_SIZE);
    tb.innerHTML = "";
    for (let ri = 0; ri < rowCount; ri++) {
      const tr = document.createElement("tr");
      const hasData = ri < pageRows.length;
      const r = hasData ? pageRows[ri] : null;
      const globalIdx = start + ri;
      for (let ci = 0; ci < 11; ci++) {
        const td = document.createElement("td");
        td.style.cssText = "border:1px solid #ddd;padding:5px 6px";
        if (ci === 0) {
          td.textContent = hasData ? (r.ch + 1).toString() : (globalIdx + 1).toString();
        } else if ([1, 2, 3, 10].includes(ci)) {
          td.setAttribute("contenteditable", "true");
          td.dataset.col = ci;
          if (hasData) {
            if (ci === 1) td.textContent = r.name || "";
            else if (ci === 2) td.textContent = fmtMhz(r.rx10);
            else if (ci === 3) td.textContent = fmtMhz(r.rx10 + r.diff10);
            else if (ci === 10) td.textContent = Math.abs(r.diff10 / 100000).toFixed(4);
          }
          td.addEventListener("blur", syncTableData);
          td.addEventListener("keydown", restrictChannelInput);
          td.addEventListener("paste", (e) => {
            e.preventDefault();
            let text = (e.clipboardData || window.clipboardData).getData("text").replace(/\s/g, "");
            const col = parseInt(td.dataset.col);
            if (col !== 1) {
              text = text.replace(/[^0-9\.\-]/g, "");
              const parts = text.split(".");
              if (parts.length > 2) text = parts[0] + "." + parts.slice(1).join("");
              if (text.indexOf("-") > 0) text = text.replace("-", "");
              if (col === 10) text = text.replace("-", "");
            } else {
              text = text.slice(0, 10);
            }
            document.execCommand("insertText", false, text);
          });
        } else {
          const select = document.createElement("select");
          select.style.cssText = "width:100%;padding:2px;font-size:12px;border:1px solid #ccc;border-radius:3px";
          let options;
          if (ci === 4 || ci === 5) options = TONE_OPTIONS;
          else if (ci === 6) options = BANDWIDTH_OPTIONS;
          else if (ci === 7) options = POWER_OPTIONS;
          else if (ci === 8) options = MOD_OPTIONS;
          else if (ci === 9) options = DIR_OPTIONS;
          if (options) {
            options.forEach(opt => {
              const op = document.createElement("option");
              op.textContent = opt.label;
              if (ci !== 4 && ci !== 5) op.value = opt.value;
              select.appendChild(op);
            });
            if (hasData) {
              let selIdx = 0;
              if (ci === 4) selIdx = options.findIndex(o => o.codeType === r.rxCodeType && o.code === r.rxCode);
              else if (ci === 5) selIdx = options.findIndex(o => o.codeType === r.txCodeType && o.code === r.txCode);
              else if (ci === 6) selIdx = options.findIndex(o => o.value === r.bandwidth);
              else if (ci === 7) selIdx = options.findIndex(o => o.value === r.power);
              else if (ci === 8) selIdx = options.findIndex(o => o.value === r.modulation);
              else if (ci === 9) {
                const dirVal = r.diff10 > 0 ? 1 : (r.diff10 < 0 ? 2 : 0);
                selIdx = options.findIndex(o => o.value === dirVal);
              }
              if (selIdx >= 0) select.selectedIndex = selIdx;
            }
            select.dataset.row = globalIdx;
            const fieldMap = { 4: "rxTone", 5: "txTone", 6: "bandwidth", 7: "power", 8: "modulation", 9: "dir" };
            select.dataset.field = fieldMap[ci];
            select.dataset.options = JSON.stringify(options);
            select.addEventListener("change", function() {
              const idx = parseInt(this.dataset.row);
              if (isNaN(idx) || !chCsvData || idx >= chCsvData.length) return;
              const field = this.dataset.field;
              const selectedOpt = JSON.parse(this.dataset.options)[this.selectedIndex];
              const row = chCsvData[idx];
              if (field === "rxTone") { row.rxCodeType = selectedOpt.codeType; row.rxCode = selectedOpt.code; }
              else if (field === "txTone") { row.txCodeType = selectedOpt.codeType; row.txCode = selectedOpt.code; }
              else if (field === "bandwidth") row.bandwidth = selectedOpt.value;
              else if (field === "power") row.power = selectedOpt.value;
              else if (field === "modulation") row.modulation = selectedOpt.value;
              else if (field === "dir") {
                const absDiff = Math.abs(row.diff10);
                if (selectedOpt.value === 0) row.diff10 = 0;
                else if (selectedOpt.value === 1) row.diff10 = absDiff;
                else row.diff10 = -absDiff;
              }
              renderChannelTable(chCsvData);
            });
          }
          td.appendChild(select);
        }
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    renderPagination(totalPages, parsedRows.length);
  }

  function renderPagination(totalPages, totalItems) {
    const el = $("chPagination");
    if (!el) return;
    el.innerHTML = "";
    if (totalPages <= 1) {
      if (totalItems > 0) el.textContent = `共 ${totalItems} 条信道`;
      return;
    }
    const btnPrev = document.createElement("button");
    btnPrev.textContent = "◀ 上一页";
    btnPrev.disabled = chTablePage <= 1;
    btnPrev.addEventListener("click", () => { chTablePage--; renderChannelTable(chCsvData); });
    const info = document.createElement("span");
    info.textContent = ` 第 ${chTablePage} / ${totalPages} 页（共 ${totalItems} 条） `;
    info.style.cssText = "margin:0 12px;font-size:13px";
    const btnNext = document.createElement("button");
    btnNext.textContent = "下一页 ▶";
    btnNext.disabled = chTablePage >= totalPages;
    btnNext.addEventListener("click", () => { chTablePage++; renderChannelTable(chCsvData); });
    el.appendChild(btnPrev);
    el.appendChild(info);
    el.appendChild(btnNext);
  }

  function restrictChannelInput(e) {
    const col = parseInt(e.target.dataset.col);
    const key = e.key;
    // 允许控制键
    if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab", "Enter", "Escape", "Home", "End"].includes(key)) return;

    // 名称列：限制 10 个字符（近似 10 字节限制）
    if (col === 1) {
      const text = e.target.textContent;
      const sel = window.getSelection();
      const start = sel && sel.rangeCount ? sel.getRangeAt(0).startOffset : text.length;
      const end = sel && sel.rangeCount ? sel.getRangeAt(0).endOffset : text.length;
      if (start !== end) return; // 选中了文本，允许替换
      if (text.length >= 10) { e.preventDefault(); return; }
      return;
    }

    // 频率列允许减号；差频列（10）只表示绝对值，不允许负号
    if (col === 10) {
      if (!/[0-9\.]/.test(key)) { e.preventDefault(); return; }
    } else if (!/[0-9\.\-]/.test(key)) {
      e.preventDefault();
      return;
    }
    const text = e.target.textContent;
    const sel = window.getSelection();
    const start = sel && sel.rangeCount ? sel.getRangeAt(0).startOffset : text.length;
    const end = sel && sel.rangeCount ? sel.getRangeAt(0).endOffset : text.length;
    const hasSelection = start !== end;

    // 小数点只能有一个
    if (key === ".") {
      if (text.includes(".") && !hasSelection) { e.preventDefault(); return; }
      // 小数点后最多 5 位
      if (!hasSelection) {
        const dotIdx = text.indexOf(".");
        if (dotIdx >= 0 && start > dotIdx && text.length - dotIdx > 5) { e.preventDefault(); return; }
      }
    }
    // 减号只允许在最前面
    if (key === "-") {
      if (!hasSelection && (text.includes("-") || start !== 0)) { e.preventDefault(); return; }
    }
    // 整数部分最多 3 位（MHz 通常 3 位整数）
    if (/[0-9]/.test(key)) {
      if (!hasSelection) {
        const dotIdx = text.indexOf(".");
        const intLen = dotIdx >= 0 ? dotIdx : text.length;
        if (start <= intLen && intLen >= 3) { e.preventDefault(); return; }
        // 小数点后最多 5 位
        if (dotIdx >= 0 && start > dotIdx && text.length - dotIdx - 1 >= 5) { e.preventDefault(); return; }
      }
    }
  }

  function syncTableData() {
    try {
      const tb = $("chPreviewTbody");
      if (!tb) return;
      const trs = Array.from(tb.querySelectorAll("tr"));
      const outRows = [];
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll("td"));
        const rowData = cells.map((td, colIdx) => {
          const select = td.querySelector("select");
          if (select) {
            if (colIdx === 4 || colIdx === 5) return select.options[select.selectedIndex]?.textContent || "";
            return select.value;
          }
          let v = td.textContent.trim();
          if ([2, 3].includes(colIdx)) v = v.replace(/\s*mhz$/i, "").trim();
          return v;
        });
        if (rowData.every(s => s === "")) continue;
        outRows.push(rowData);
      }
      if (outRows.length === 0) { chCsvData = null; $("btnChProgCsv").disabled = true; return; }
      const { rows: parsed, warnings } = proto.parseChannelRows(outRows);
      for (const w of warnings) log(w, "warn");
      chCsvData = parsed;
      $("btnChProgCsv").disabled = false;
      renderChannelTable(chCsvData);
    } catch (err) {
      log(`[表格同步失败] ${err.message}`, "err");
    }
  }

  setTimeout(() => { if ($("chPreviewTbody")) renderChannelTable([]); }, 100);

  $("btnClearTable")?.addEventListener("click", () => {
    chCsvData = null;
    chTablePage = 1;
    renderChannelTable([]);
    $("btnChProgCsv").disabled = true;
    log("预览表格已清空");
  });

  $("chCsvFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    chCsvData = null;
    $("btnChProgCsv").disabled = true;
    if (!f) return;
    try {
      const rows = await parseChannelFile(f);
      const { rows: parsed, format, warnings } = proto.parseChannelRows(rows);
      for (const w of warnings) log(w, "warn");
      if (parsed.length === 0) { setStatus("文件中没有可识别的信道行", "err"); return; }
      chCsvData = parsed;
      chTablePage = 1;
      renderChannelTable(parsed);
      $("btnChProgCsv").disabled = false;
      const fmt = f.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "CSV";
      log(`${fmt} 已加载：${f.name}，${parsed.length} 条信道（识别为${format}格式）`);
    } catch (err) {
      setStatus("文件解析失败：" + err.message, "err");
      log("文件解析异常：" + err.message, "err");
    }
  });

  $("btnChProgCsv").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    syncTableData();
    if (!chCsvData || !chCsvData.length) { setStatus("请先选择信道文件", "err"); return; }
    $("btnChProgCsv").disabled = true;
    $("chCsvProgress").style.display = "block";
    const bar = $("chCsvProgressBar");
    bar.style.width = "0%";
    try {
      await ensureSession();
      const C = proto.CHAN;
      for (let i = 0; i < chCsvData.length; i++) {
        const row = chCsvData[i];
        if (row.ch < 0 || row.ch >= C.MAX_COUNT) {
          log(`跳过越界信道 ${row.ch + 1}`, "info"); continue;
        }
        const params = {
          name: row.name,
          rxFreq10Hz: row.rx10,
          txOffsetFreq10Hz: Math.abs(row.diff10),
          rxCodeType: row.rxCodeType, rxCode: row.rxCode,
          txCodeType: row.txCodeType, txCode: row.txCode,
          modulation: row.modulation,
          txDir: row.diff10 > 0 ? proto.TX_DIR.ADD : row.diff10 < 0 ? proto.TX_DIR.SUB : proto.TX_DIR.OFF,
          bandwidth: row.bandwidth,
          power: row.power,
          txLock: 0, bcl: 0, freqReverse: 0, pttId: 0,
          step: row.step,
          scanlist: row.scanlist,
        };
        await writeChannel(row.ch, params);
        bar.style.width = ((i + 1) / chCsvData.length * 100).toFixed(1) + "%";
        if ((i + 1) % 10 === 0 || i === chCsvData.length - 1) log(`已写入 ${i + 1}/${chCsvData.length}`);
      }
      bar.style.width = "100%";
      setStatus(`✅ 批量写入完成，共 ${chCsvData.length} 条信道`, "ok");
      log("批量写频完成");
    } catch (err) {
      setStatus("批量写频失败：" + err.message, "err");
      log("批量写频异常：" + err.message, "err");
    } finally {
      $("btnChProgCsv").disabled = false;
    }
  });

  // ---------- 导出信道（CSV） ----------
  // 连续区间分块读 EEPROM（单次命令数据上限 128 字节，见 CALIB.READ_CHUNK）
  async function readRange(offset, out, onProgress) {
    const CHUNK = 128;
    for (let off = 0; off < out.length; off += CHUNK) {
      const n = Math.min(CHUNK, out.length - off);
      out.set(await readEepromBlock(offset + off, n), off);
      if (onProgress) onProgress(Math.min(off + n, out.length) / out.length);
    }
  }

  // 频率 10Hz 值 → 叮咚鸡频率文本（最多 4 位小数、去尾零、至少 3 位，如 438.710 / 412.5875）
  function fmtMhz(v10) {
    const mhz = v10 / 100000;
    let s = mhz.toFixed(4).replace(/0+$/, "");
    if (s.endsWith(".")) s += "0";
    const frac = s.indexOf(".") < 0 ? 0 : s.length - s.indexOf(".") - 1;
    return frac < 3 ? mhz.toFixed(3) : s;
  }

  function csvEscape(s) {
    s = String(s);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  $("btnChExpCsv").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    const C = proto.CHAN;
    const start = parseInt($("chExpStart").value, 10) - 1;
    const end = parseInt($("chExpEnd").value, 10) - 1;
    if (isNaN(start) || isNaN(end) || start < 0 || end >= C.MAX_COUNT || start > end) {
      setStatus(`信道范围无效，应为 1~${C.MAX_COUNT}`, "err"); return;
    }
    $("btnChExpCsv").disabled = true;
    $("chExpProgress").style.display = "block";
    const bar = $("chExpProgressBar");
    bar.style.width = "0%";
    try {
      await ensureSession();
      const count = end - start + 1;
      const freqAll = new Uint8Array(count * C.SIZE);
      const nameAll = new Uint8Array(count * C.NAME_SIZE);

      await readRange(start * C.SIZE, freqAll,
        (p) => { bar.style.width = (p * 45).toFixed(1) + "%"; });
      await readRange(C.NAME_BASE + start * C.NAME_SIZE, nameAll,
        (p) => { bar.style.width = (45 + p * 45).toFixed(1) + "%"; });

      const gb = window.K5WEB && window.K5WEB.gb2312;
      const lines = [proto.DD_HEADERS.join(",")]; // 叮咚鸡格式表头
      let exported = 0;
      for (let i = 0; i < count; i++) {
        const fdv = new DataView(freqAll.buffer, i * C.SIZE, C.SIZE);
        const rx10 = fdv.getUint32(0, true);
        if (rx10 === 0 || rx10 === 0xFFFFFFFF) continue;   // 空信道（未写入/擦除态）
        // offset 4 是频差值（10Hz），方向在 byte11 低半字节
        let off10 = fdv.getUint32(4, true);
        if (off10 === 0xFFFFFFFF) off10 = 0;
        if (off10 >= 100000000) off10 = 1000000;           // 与固件 radio.c 的上限一致
        const txDir = fdv.getUint8(11) & 0x0F;
        const nameBytes = nameAll.subarray(i * C.NAME_SIZE, (i + 1) * C.NAME_SIZE);
        let ascii = "";
        for (const b of nameBytes) { if (!b) break; if (b >= 0x20 && b < 0x7F) ascii += String.fromCharCode(b); }
        const name = gb ? gb.decode(nameBytes) : ascii;
        const rxTone = proto.toneToDdColumns(fdv.getUint8(8), fdv.getUint8(10) & 0x0F);
        const txTone = proto.toneToDdColumns(fdv.getUint8(9), (fdv.getUint8(10) >> 4) & 0x0F);
        lines.push([
          start + i + 1,
          fmtMhz(rx10),
          proto.POWER_NAMES[(fdv.getUint8(12) >> 2) & 7] || "HIGH",
          rxTone.digital, rxTone.analog,
          txTone.digital, txTone.analog,
          proto.DD_DIR_NAMES[txDir <= proto.TX_DIR.SUB ? txDir : 0],
          (off10 / 100000).toFixed(4),
          proto.MODULATION_NAMES[(fdv.getUint8(11) >> 4) & 0x0F] || "FM",
          proto.ddStepName(fdv.getUint8(14)),
          "不参与",
          csvEscape(gb ? name : ascii),
        ].join(","));
        exported++;
        bar.style.width = (90 + exported / count * 10).toFixed(1) + "%";
      }
      if (exported === 0) { setStatus("该范围内没有已写入的信道", "err"); return; }

      // 带 BOM 下载，Excel 直接打开中文不乱码
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `k5_channels_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      bar.style.width = "100%";
      setStatus(`✅ 已导出 ${exported} 条信道（范围 ${start + 1}~${end + 1}），文件 k5_channels_*.csv`, "ok");
      log(`信道导出完成：${exported}/${count} 条有效`);
    } catch (err) {
      setStatus("导出失败：" + err.message, "err");
      log("导出异常：" + err.message, "err");
    } finally {
      $("btnChExpCsv").disabled = false;
    }
  });

  // ---------- 清空信道（恢复出厂擦除态 0xFF） ----------
  $("btnChClear").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    const C = proto.CHAN;
    const start = parseInt($("chClrStart").value, 10) - 1;
    const end = parseInt($("chClrEnd").value, 10) - 1;
    if (isNaN(start) || isNaN(end) || start < 0 || end >= C.MAX_COUNT || start > end) {
      setStatus(`信道范围无效，应为 1~${C.MAX_COUNT}`, "err"); return;
    }
    const count = end - start + 1;
    if (!confirm(`确定清空信道 ${start + 1}~${end + 1}（共 ${count} 个）吗？\n\n频率、名称、属性将全部恢复为出厂擦除态，此操作不可恢复！\n建议先导出 CSV 备份。\n\n清空完成后对讲机将自动重启以立即生效。`)) return;

    $("btnChClear").disabled = true;
    $("chClrProgress").style.display = "block";
    const bar = $("chClrProgressBar");
    bar.style.width = "0%";
    try {
      await ensureSession();
      const emptyFreq = new Uint8Array(C.SIZE).fill(0xFF);
      const emptyName = new Uint8Array(C.NAME_SIZE).fill(0xFF);
      // 属性区按 8 字节对齐读改写：缓存对齐块，每 4 个信道才重读一次
      let cacheBase = -1;
      let cacheBlock = null;
      for (let ch = start; ch <= end; ch++) {
        await writeEepromBlock(ch * C.SIZE, emptyFreq);
        await writeEepromBlock(C.NAME_BASE + ch * C.NAME_SIZE, emptyName);

        const attrOffset = C.ATTR_BASE + ch * C.ATTR_SIZE;
        const alignBase = attrOffset - (attrOffset % C.ATTR_ALIGN);
        const inOff = attrOffset - alignBase;
        if (alignBase !== cacheBase) {
          cacheBlock = new Uint8Array(await readEepromBlock(alignBase, C.ATTR_ALIGN));
          cacheBase = alignBase;
        }
        cacheBlock[inOff] = 0xFF;
        cacheBlock[inOff + 1] = 0xFF;
        await writeEepromBlock(alignBase, cacheBlock);

        bar.style.width = ((ch - start + 1) / count * 100).toFixed(1) + "%";
        if ((ch - start + 1) % 20 === 0 || ch === end) log(`已清空 ${ch - start + 1}/${count}`);
      }
      bar.style.width = "100%";
      // 固件开机时把属性区一次性读进 RAM（settings.c SETTINGS_InitEEPROM），
      // 不重启的话切换信道仍按旧属性表工作，必须重启才重新加载
      log("清空完成，发送重启命令...");
      await writer.write(proto.buildFrame(proto.CMD.REBOOT, new Uint8Array(0)));
      setStatus(`✅ 已清空信道 ${start + 1}~${end + 1}（共 ${count} 个），对讲机正在重启生效`, "ok");
      log("已重启");
    } catch (err) {
      setStatus("清空失败：" + err.message, "err");
      log("清空异常：" + err.message, "err");
    } finally {
      $("btnChClear").disabled = false;
    }
  });

  // ---------- 固件刷写（bootloader 协议，参考 Apache-2.0 的 uvtools2/js/flash.js） ----------
  let fwData = null;

  // 从回复队列等一条指定 id 的消息，其余（广播/K5Viewer 流等）丢弃
  async function waitForMsg(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (replyQueue.length) {
        const f = replyQueue.shift();
        if (f.length >= 2 && (f[0] | (f[1] << 8)) === id) return f;
        continue;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }

  // 阶段 1：等设备广播（连续 5 条有效 0x0518，相邻间隔 5~1000ms）
  async function waitDeviceInfo(maxMs) {
    const deadline = Date.now() + maxMs;
    let lastTime = 0, valid = 0;
    while (Date.now() < deadline) {
      const f = await waitForMsg(proto.FLASH_MSG.NOTIFY_DEV_INFO, 1200);
      if (!f) return null; // 1.2s 无广播 → 不在刷机模式
      const now = Date.now();
      const dt = now - lastTime;
      valid = !lastTime || (dt >= 5 && dt <= 1000) ? valid + 1 : 1;
      lastTime = now;
      if (valid >= 5) return f;
    }
    return null;
  }

  // 阶段 2：握手（收 0x0518 → 回 0x0530 版本前 4 字符，共 3 次）
  async function flashHandshake(version) {
    const v4 = new TextEncoder().encode(version.slice(0, 4).padEnd(4, "0"));
    for (let i = 0; i < 3; i++) {
      const f = await waitForMsg(proto.FLASH_MSG.NOTIFY_DEV_INFO, 1500);
      if (!f) throw new Error("握手超时（未收到设备广播）");
      await writer.write(proto.buildFlashFrame(proto.FLASH_MSG.NOTIFY_BL_VER, v4));
    }
    await new Promise((r) => setTimeout(r, 200));
    replyQueue.length = 0; // 排空残余广播
  }

  $("fwFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    fwData = null;
    $("btnFlash").disabled = true;
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    if (!buf.length || buf.length > proto.FLASH_MSG.APP_MAX_SIZE) {
      setStatus(`固件大小无效：${buf.length} 字节（应 1~${proto.FLASH_MSG.APP_MAX_SIZE}）`, "err");
      return;
    }
    fwData = buf;
    $("btnFlash").disabled = false;
    log(`固件已加载：${f.name}（${buf.length} 字节，${Math.ceil(buf.length / 256)} 页）`);
  });

  // ---------- 获取远程固件（读取仓库 update.json） ----------

  // 远程固件列表（每个固件自动通过 CORS 代理下载到内存，用户直接点选即可刷写）
  const remoteFwCache = []; // [{ name, version, note, buf }]

  $("btnFwList").addEventListener("click", async () => {
    const btn = $("btnFwList");
    const status = $("fwRemoteStatus");
    const listBox = $("fwReleaseList");
    btn.disabled = true;
    btn.textContent = "获取中...";
    status.textContent = "正在获取固件列表...";
    status.className = "hint";
    listBox.innerHTML = "";
    remoteFwCache.length = 0;

    try {
      // GitHub Pages 模式：从 GitHub 仓库读取固件列表（raw.githubusercontent.com 支持 CORS）
      const fwListUrl = IS_GITHUB_PAGES
        ? "https://raw.githubusercontent.com/jkhgnl/k6web/gh-pages/update.json"
        : "/fw/list";
      const resp = await fetchWithTimeout(fwListUrl, {}, 15000);
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error("服务器返回数据格式异常"); }

      // 兼容两种格式：数组或单个对象
      const list = Array.isArray(data) ? data : (data.firmware_url ? [data] : []);
      if (list.length === 0) throw new Error("固件仓库暂无固件");

      // 先渲染占位卡片（带 loading 状态），同时后台并发下载所有固件
      let html = "";
      for (let i = 0; i < list.length; i++) {
        const fw = list[i];
        const name = fw.name || "f4hwn.fusion.bin";
        const version = fw.version || "";
        const note = (fw.note || fw.description || fw.body || "").trim();
        html += `<div class="fw-release" id="fwItem${i}">`;
        html += `<div class="fw-release-header">`;
        html += `<span class="fw-release-tag">${name}${version ? " v" + version : ""}</span>`;
        html += `</div>`;
        if (note) html += `<div class="fw-release-body">${note}</div>`;
        html += `<div class="fw-asset">`;
        html += `<span class="fw-asset-name">${name}</span>`;
        html += `<span class="fw-asset-size" id="fwSize${i}" style="color:#888">⏳ 下载中...</span>`;
        html += `</div>`;
        html += `</div>`;
      }
      listBox.innerHTML = html;

      // 并发下载所有固件到内存
      const total = list.length;
      let done = 0;
      status.textContent = `正在下载 ${total} 个固件...`;
      status.className = "hint";

      const downloadTasks = list.map(async (fw, i) => {
        const name = fw.name || "f4hwn.fusion.bin";
        const version = fw.version || "";
        const url = fw.url || fw.firmware_url || "";
        const sizeEl = $(`fwSize${i}`);
        const itemEl = $(`fwItem${i}`);

        if (!url) {
          if (sizeEl) { sizeEl.textContent = "⚠️ 无下载地址"; sizeEl.style.color = "#c62828"; }
          return;
        }

        try {
          let buf;
          if (IS_GITHUB_PAGES) {
            const proxyUrl = WORKER_PROXY_URL + "?url=" + encodeURIComponent(url);
            const r = await fetchWithTimeout(proxyUrl, {}, 60000);
            if (!r.ok) throw new Error("HTTP " + r.status);
            buf = new Uint8Array(await r.arrayBuffer());
          } else {
            const r = await fetchWithTimeout(url, {}, 60000);
            if (!r.ok) throw new Error("HTTP " + r.status);
            buf = new Uint8Array(await r.arrayBuffer());
          }

          if (!buf.length || buf.length > proto.FLASH_MSG.APP_MAX_SIZE) {
            throw new Error(`大小无效：${buf.length} 字节`);
          }

          remoteFwCache.push({ name, version, note: (fw.note || fw.description || fw.body || "").trim(), buf });

          // 更新 UI：显示大小，加点击事件
          if (sizeEl) {
            const kb = (buf.length / 1024).toFixed(1);
            sizeEl.textContent = `✅ ${kb} KB · 点击选择`;
            sizeEl.style.color = "#1a7f37";
          }
          if (itemEl) {
            itemEl.style.cursor = "pointer";
            itemEl.addEventListener("click", () => selectRemoteFirmware(i));
          }
        } catch (err) {
          if (sizeEl) { sizeEl.textContent = "❌ 下载失败：" + err.message; sizeEl.style.color = "#c62828"; }
          log(`固件 ${name} 下载失败：${err.message}`, "err");
        } finally {
          done++;
          status.textContent = `正在下载固件... ${done}/${total}`;
        }
      });

      await Promise.all(downloadTasks);

      if (remoteFwCache.length > 0) {
        status.textContent = `✅ ${remoteFwCache.length}/${total} 个固件已就绪，请点击选择`;
        status.className = "hint ok";
        log(`远程固件全部就绪：${remoteFwCache.length}/${total}`);
      } else {
        status.textContent = "❌ 所有固件下载失败";
        status.className = "hint err";
      }
    } catch (err) {
      status.textContent = "获取失败：" + err.message;
      status.className = "hint err";
      log("远程固件获取失败：" + err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 获取远程固件";
    }
  });

  function selectRemoteFirmware(index) {
    const fw = remoteFwCache[index];
    if (!fw) return;
    fwData = fw.buf;
    $("btnFlash").disabled = false;
    // 高亮选中的卡片
    document.querySelectorAll("#fwReleaseList .fw-release").forEach((el, i) => {
      el.style.borderColor = i === index ? "#2f6fdc" : "";
      el.style.background = i === index ? "#f0f6ff" : "";
    });
    // 更新按钮文字
    document.querySelectorAll("#fwReleaseList .fw-asset-size").forEach((el, i) => {
      if (i === index) {
        const kb = (fw.buf.length / 1024).toFixed(1);
        el.textContent = `✅ 已选择 · ${kb} KB`;
        el.style.color = "#2f6fdc";
      } else {
        const cacheItem = remoteFwCache[i];
        if (cacheItem) {
          const kb = (cacheItem.buf.length / 1024).toFixed(1);
          el.textContent = `✅ ${kb} KB · 点击选择`;
          el.style.color = "#1a7f37";
        }
      }
    });
    const status = $("fwRemoteStatus");
    status.textContent = `已选择：${fw.name}${fw.version ? " v" + fw.version : ""}（${fw.buf.length} 字节，${Math.ceil(fw.buf.length / 256)} 页），可直接刷写`;
    status.className = "hint ok";
    log(`已选择远程固件：${fw.name}${fw.version ? " v" + fw.version : ""}（${fw.buf.length} 字节）`);
  }

  $("btnFlash").addEventListener("click", async () => {
    if (!port) { setStatus("请先连接串口", "err"); return; }
    if (!fwData) { setStatus("请先选择固件文件", "err"); return; }

    $("btnFlash").disabled = true;
    $("flashProgress").style.display = "block";
    const bar = $("flashProgressBar");
    bar.style.width = "0%";
    try {
      // ① 等设备（用户需已按住 PTT 开机进入刷机模式）
      log("等待刷机模式设备...（按住 PTT 开机）");
      setStatus("等待刷机模式设备...（按住 PTT 开机）", "info");
      const devMsg = await waitDeviceInfo(20000);
      if (!devMsg) throw new Error("未检测到刷机模式设备。请断开串口，按住 PTT 键开机后重新点击开始刷写");
      const dev = proto.parseDevInfo(devMsg);
      if (!dev) throw new Error("设备信息解析失败");
      log(`设备 UID：${dev.uid}`);
      log(`Bootloader 版本：${dev.version}`);
      if (!proto.blVersionOK(dev.version))
        throw new Error(`Bootloader 版本过低（${dev.version}，要求 ≥ 7.00.07），请先更新 bootloader`);

      // ② 握手
      log("握手中...");
      await flashHandshake(dev.version);
      log("握手完成，开始分页编程");

      // ③ 分页编程（256B/页，逐页 ACK，重试 3 次）
      const PS = proto.FLASH_MSG.PAGE_SIZE;
      const pageCount = Math.ceil(fwData.length / PS);
      const timestamp = Date.now() >>> 0;
      for (let i = 0; i < pageCount; i++) {
        const page = fwData.subarray(i * PS, Math.min((i + 1) * PS, fwData.length));
        const data = proto.buildFwPage(timestamp, i, pageCount, page);
        let done = false, lastErr = "";
        for (let attempt = 1; attempt <= 3 && !done; attempt++) {
          await writer.write(proto.buildFlashFrame(proto.FLASH_MSG.PROG_FW, data));
          const resp = await waitForMsg(proto.FLASH_MSG.PROG_FW_RESP, 3000);
          if (!resp) { lastErr = "ACK 超时"; continue; }
          if (resp.length < 12) { lastErr = "ACK 长度异常"; continue; }
          const dv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
          const echoIdx = dv.getUint16(8, true);
          const errCode = dv.getUint16(10, true);
          if (echoIdx === i && errCode === 0) done = true;
          else lastErr = `页号回显 ${echoIdx} 错误码 ${errCode}`;
        }
        if (!done) throw new Error(`第 ${i}/${pageCount} 页写入失败：${lastErr}`);
        bar.style.width = ((i + 1) / pageCount * 100).toFixed(1) + "%";
        if (i % 50 === 49 || i === pageCount - 1) log(`页 ${i + 1}/${pageCount}`);
      }
      bar.style.width = "100%";
      setStatus("✅ 固件刷写完成！请断开串口并重新开机", "ok");
      log("固件刷写完成，请重新开机");
    } catch (err) {
      setStatus("固件刷写失败：" + err.message, "err");
      log("固件刷写异常：" + err.message, "err");
    } finally {
      $("btnFlash").disabled = false;
    }
  });

  // ===================== 工具函数 =====================

  async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp;
    } finally {
      clearTimeout(t);
    }
  }

  // 加载收藏列表
  loadFavorites();

  // 页面加载后从本地缓存恢复 TLE（秒开选星；缓存超过 12h 时下拉框锁定并强制刷新）
  {
    const cache = loadTleCache();
    if (cache.length) {
      satList = cache;
      const input = $("satSelect");
      const fresh = tleCacheFresh();
      if (fresh) {
        input.disabled = false;
        input.placeholder = `输入关键字搜索 ${cache.length} 颗卫星（本地缓存 ${tleCacheAge()}）`;
      } else {
        input.disabled = true; // 过期：下拉框锁定，强制先获取最新 TLE
        input.placeholder = `缓存已过期（${tleCacheAge()}），请先点"⬇️ 获取 TLE"`;
        log(`TLE 缓存已过期（${tleCacheAge()}），下拉框已锁定，等待获取最新 TLE`);
      }
      // 缓存过期：自动后台刷新，成功即解锁下拉框
      if (!fresh) {
        refreshTleFromNetwork(cache)
          .then(({ list, updated }) => {
            input.disabled = false;
            input.placeholder = `输入关键字搜索 ${list.length} 颗卫星（名称 / NORAD 编号）`;
            log(`过期缓存已自动刷新：共 ${list.length} 颗${updated > 0 ? `，更新 ${updated} 颗` : "（无变化）"}，下拉框已解锁`);
          })
          .catch((e) => {
            input.placeholder = `刷新失败，请点"⬇️ 获取 TLE"重试（${e.message}）`;
            log(`过期缓存自动刷新失败：${e.message}，下拉框保持锁定，请手动获取`, "err");
          });
      }
    }
  }

  // ---------- 收藏列表渲染 ----------
  function renderFavTab() {
    const box = $("favList");
    // 每次渲染时从 localStorage 读取，确保数据最新
    loadFavorites();
    if (!favorites.length) {
      box.innerHTML = '<div class="sat-empty" style="padding:24px">还没有收藏卫星。在星历写入的下拉列表中点击 ⭐ 即可收藏。</div>';
      return;
    }
    let html = '<table class="fav-table"><thead><tr><th>NORAD</th><th>卫星名称</th><th>下行频率</th><th>操作</th></tr></thead><tbody>';
    favorites.forEach((norad) => {
      const s = satList.find((x) => satNorad(x) === norad);
      const name = s ? s.name.trim() : "(未知)";
      const freq = freqMap[norad];
      const freqStr = freq && freq.down ? (freq.down / 1e6).toFixed(4) + " MHz" : "-";
      html += `<tr>
        <td class="norad-cell">#${norad}</td>
        <td>${name}</td>
        <td>${freqStr}</td>
        <td>
          <button class="fav-goto" data-name="${s ? s.name.trim() : ""}">📄 写入星历</button>
          <button class="fav-btn" data-norad="${norad}">✕ 取消收藏</button>
        </td>
      </tr>`;
    });
    html += '</tbody></table>';
    box.innerHTML = html;

    box.querySelectorAll(".fav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleFav(btn.dataset.norad);
        renderFavTab();
      });
    });
    box.querySelectorAll(".fav-goto").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!btn.dataset.name) return;
        switchTab("tabEphem");
        selectSat(btn.dataset.name);
      });
    });
  }

  // ---------- 收藏页搜索框 ----------
  {
    const input = $("favSearch");
    const dd = $("favDropdown");
    if (input && dd) {
      let activeIdx = -1;
      function renderFavDropdown() {
        const q = input.value.trim().toLowerCase();
        if (!q || !favorites.length) { dd.hidden = true; return; }
        const matched = favorites.filter((norad) => {
          const s = satList.find((x) => satNorad(x) === norad);
          if (!s) return false;
          const name = s.name.trim().toLowerCase();
          return name.includes(q) || norad.includes(q);
        }).slice(0, 60);
        if (!matched.length) { dd.hidden = true; return; }
        activeIdx = -1;
        let html = "";
        matched.forEach((norad, i) => {
          const s = satList.find((x) => satNorad(x) === norad);
          const name = s ? s.name.trim() : "(未知)";
          html += `<div class="sat-item" data-i="${i}" data-norad="${norad}" data-name="${name}">
            <span>${name}</span><span class="norad">#${norad}</span>
            <span class="sat-fav active" data-norad="${norad}">★</span>
          </div>`;
        });
        dd.innerHTML = html;
        dd.hidden = false;
        dd.querySelectorAll(".sat-fav").forEach((el) => {
          el.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            toggleFav(el.dataset.norad);
            renderFavDropdown();
            renderFavTab();
          });
        });
        dd.querySelectorAll(".sat-item").forEach((el) => {
          el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            input.value = el.dataset.name;
            dd.hidden = true;
          });
        });
      }
      input.addEventListener("input", renderFavDropdown);
      input.addEventListener("focus", renderFavDropdown);
      document.addEventListener("mousedown", (e) => {
        if (!dd.contains(e.target) && e.target !== input) dd.hidden = true;
      });
    }
  }

  // 收藏 tab 激活时自动渲染（MutationObserver 兜底，不依赖 switchTab 时序）
  {
    const favPanel = document.getElementById("tabFav");
    if (favPanel) {
      new MutationObserver(() => {
        if (favPanel.classList.contains("active")) renderFavTab();
      }).observe(favPanel, { attributes: true, attributeFilter: ["class"] });
      // 如果页面加载时 tabFav 已激活，直接渲染
      if (favPanel.classList.contains("active")) renderFavTab();
    }
  }

  // 页面加载后恢复频率库（localStorage 缓存优先，其次内置 freqdb.js 静态数据）；
  // 频率基本不变、缓存不过期，仅在完全无数据时后台静默拉取
  {
    const data = loadFreqData();
    if (data) {
      freqMap = data.map;
      log(`已加载频率库（${Object.keys(freqMap).length} 颗卫星，来源：${data.source}）`);
    } else {
      ensureFreqDB().catch(() => {});
    }
  }

  // 首页访问人次统计（数字滚动动画）
  fetch("https://visits.jkhgnl.top/").then(r => r.json()).then(d => {
    const el = $("homeVisitCount");
    if (!el) return;
    const target = d.count;
    if (target <= 0) { el.textContent = "0"; return; }
    const duration = Math.min(1200, target * 30);
    const start = performance.now();
    function tick(now) {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(ease * target);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }).catch(() => {});

  // 动态获取 APP 最新版本下载链接
  fetch("https://gitee.com/api/v5/repos/jkhgnl/uvk6-tools-android/releases/latest").then(r => r.json()).then(d => {
    const apk = (d.assets || []).find(a => a.name && a.name.endsWith(".apk"));
    const btn = $("appDownloadBtn");
    if (apk && btn) {
      btn.href = apk.browser_download_url;
    } else if (d.tag_name && btn) {
      // fallback: 即使 assets 为空，也能根据 tag_name 构造出下载链接
      btn.href = `https://gitee.com/jkhgnl/uvk6-tools-android/releases/download/${d.tag_name}/uvk6tools-${d.tag_name}.apk`;
    }
  }).catch(() => {
    // 网络请求失败时保留 HTML 中硬编码的直接下载链接（手机浏览器兼容）
  });
})();
