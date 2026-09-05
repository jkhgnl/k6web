#!/usr/bin/env node
/**
 * SEO 主动推送脚本：IndexNow + 百度搜索资源平台
 *
 * 用法：
 *   node scripts/push-seo.mjs                  # 读根目录 sitemap.xml
 *   node scripts/push-seo.mjs <sitemap 路径>    # 指定 sitemap
 *
 * 环境变量（可选覆盖，CI 中可注入 GitHub Secrets）：
 *   INDEXNOW_KEY   默认 1cf60d4a5b62d3b547ed6adedc19bdbf（对应站点根目录同名 key 文件）
 *   BAIDU_SITE     默认 https://jkhgnl.top
 *   BAIDU_TOKEN    默认 r5zhcDkWhOdcPkWT；显式设为空则跳过百度推送
 *
 * 说明：单页应用的 #锚点 URL 爬虫不识别，推送前统一去掉 fragment 并去重，
 *       保证根 URL 与 sitemap.xml 本身在列。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const HOST = "jkhgnl.top";
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || "1cf60d4a5b62d3b547ed6adedc19bdbf";
// 百度 site 参数必须不带协议（带 https:// 会返回 site init fail）
const BAIDU_SITE = (process.env.BAIDU_SITE || "jkhgnl.top").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const BAIDU_TOKEN = (process.env.BAIDU_TOKEN || "r5zhcDkWhOdcPkWT").trim();

const SITEMAP = resolve(process.argv[2] || "sitemap.xml");

function extractUrls(xml) {
  const set = new Set();
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) {
    const bare = m[1].trim().split("#")[0]; // 去掉 fragment
    if (bare) set.add(bare);
  }
  // 保证根 URL 与 sitemap 本身在列
  set.add(`https://${HOST}/`);
  set.add(`https://${HOST}/sitemap.xml`);
  return [...set];
}

async function pushIndexNow(urls) {
  const body = {
    host: HOST,
    key: INDEXNOW_KEY,
    keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`,
    urlList: urls.slice(0, 1000), // IndexNow 单批上限 1000 条
  };
  const resp = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`[IndexNow] HTTP ${resp.status} ${resp.statusText}`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.log("[IndexNow] 响应：" + text.slice(0, 500));
    return false;
  }
  return true;
}

async function pushBaidu(urls) {
  if (!BAIDU_TOKEN) {
    console.log("[百度] 未配置 BAIDU_TOKEN，跳过");
    return true;
  }
  const api = `http://data.zz.baidu.com/urls?site=${encodeURIComponent(BAIDU_SITE)}&token=${encodeURIComponent(BAIDU_TOKEN)}`;
  const resp = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: urls.join("\n"),
  });
  const text = await resp.text().catch(() => "");
  console.log(`[百度] HTTP ${resp.status} 反馈：${text}`);
  if (!resp.ok) {
    // 当日配额用完按天重置，下次运行会补推，不判失败
    if (/"message"\s*:\s*"over quota"/.test(text)) {
      console.log("[百度] 当日配额已用完，跳过（配额每日重置，不影响本次构建）");
      return true;
    }
    return false;
  }
  try {
    const data = JSON.parse(text);
    // 重复/已在库的 URL 百度会减少 success 数，属正常；仅对接口不可用判失败
    if (typeof data.success === "number") {
      console.log(`[百度] 成功 ${data.success} 条，剩余配额 ${data.remain}，未处理：${JSON.stringify(data.not_valid || [])}`);
    }
  } catch {
    return false;
  }
  return true;
}

const main = async () => {
  const xml = await readFile(SITEMAP, "utf8");
  const urls = extractUrls(xml);
  console.log(`共推送 ${urls.length} 个 URL（来源 ${SITEMAP}）：`);
  urls.forEach((u) => console.log("  " + u));

  const okIndex = await pushIndexNow(urls);
  const okBaidu = await pushBaidu(urls);
  process.exit(okIndex && okBaidu ? 0 : 1);
};

main().catch((e) => {
  console.error("推送失败：" + e.message);
  process.exit(1);
});
