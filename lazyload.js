/**
 * 按需加载外部 JS/CSS 资源
 * 用法：await lazyLoad("vendor/xlsx.full.min.js");
 * 依赖：无
 */
window.lazyLoad = (function () {
  const loaded = {};

  function loadScript(src) {
    if (loaded[src]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => { loaded[src] = true; resolve(); };
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  function loadCSS(href) {
    if (loaded[href]) return Promise.resolve();
    return new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = () => { loaded[href] = true; resolve(); };
      document.head.appendChild(link);
    });
  }

  // 预定义的资源组
  const bundles = {
    xlsx: () => loadScript("vendor/xlsx.full.min.js"),
    leaflet: () => Promise.all([
      loadCSS("vendor/leaflet.css"),
      loadScript("vendor/leaflet.js"),
    ]),
    satellite: () => loadScript("vendor/satellite.min.js"),
    qrcode: () => loadScript("vendor/qrcode.min.js"),
    gb2312: () => loadScript("gb2312_table.js?v=csv1"),
    freqdb: () => loadScript("freqdb.js"),
  };

  function lazyLoad(keyOrSrc) {
    if (bundles[keyOrSrc]) return bundles[keyOrSrc]();
    return loadScript(keyOrSrc);
  }

  return lazyLoad;
})();
