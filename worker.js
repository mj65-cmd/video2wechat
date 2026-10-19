/**
 * Cloudflare Worker —— 视频→公众号 工作台后端
 * 两个能力：
 *   1) GET  /api/parse?url=抖音链接   —— 服务端解析抖音，绕开浏览器 CORS/代理（国内代理不稳的根因）
 *   2) POST /api/wechat/draft         —— 保管微信 AppID/Secret，固定出口 IP，直推草稿箱
 * 免费：Workers 免费层（每天 10 万请求）足够个人使用。
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler secret put WECHAT_APPID   # 公众号 AppID（仅推送需要）
 *   wrangler secret put WECHAT_SECRET  # AppSecret（仅推送需要）
 *   wrangler deploy
 * 前端「配置」里填 Worker 根地址：https://<你的worker>.workers.dev
 */

let tokenCache = { token: null, expire: 0 };

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function extractUrls(text) {
  return (text || "").match(/https?:\/\/[^\s，,。""'）)【】]+/g) || [];
}

function parseJsonText(txt) {
  if (!txt) return null;
  try {
    const s = txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1);
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 从 url 解析出 aweme_id
async function resolveAwemeId(url) {
  let m = url.match(/\/video\/(\d+)/) || url.match(/modal_id=(\d+)/);
  if (m) return m[1];
  if (/v\.douyin\.com\//i.test(url)) {
    // 短链：跟随 302 拿到长链
    try {
      const r = await fetch(url, { headers: { "User-Agent": MOBILE_UA }, redirect: "follow" });
      const finalUrl = r.url || "";
      const m2 = finalUrl.match(/\/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/);
      if (m2) return m2[1];
      const html = await r.text();
      const m3 = (html.match(/"itemId"\s*:\s*"(\d+)"/) ||
                  html.match(/\/video\/(\d{15,})/) ||
                  html.match(/aweme_id=(\d+)/) ||
                  html.match(/modal_id=(\d+)/));
      if (m3) return m3[1];
    } catch { /* ignore */ }
  }
  return null;
}

// 服务端调 snssdk feed 拿标题 + 播放直链（已在沙箱验证可用）
async function parseDouyin(url) {
  const urls = extractUrls(url);
  for (const u of urls) {
    const id = await resolveAwemeId(u);
    if (!id) continue;
    try {
      const api = "https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=" + id;
      const r = await fetch(api, { headers: { "User-Agent": MOBILE_UA } });
      if (!r.ok) continue;
      const j = parseJsonText(await r.text());
      if (!j) continue;
      const item = j.aweme_list && j.aweme_list[0];
      if (!item) continue;
      const v = item.video || {};
      const pick = (a) => {
        const ls = (a && a.url_list) || [];
        return ls.find((x) => /^https:\/\//.test(x)) || ls[0] || "";
      };
      let media = pick(v.play_addr) || pick(v.play_addr_lowbr) || pick(v.download_addr);
      const uri = v.play_addr && v.play_addr.uri;
      if (!media && uri) media = "https://aweme.snssdk.com/aweme/v1/play/?video_id=" + uri + "&ratio=720p&line=0";
      if (!media) continue;
      return {
        media,
        title: item.desc || "",
        author: (item.author && item.author.nickname) || "",
      };
    } catch { /* try next */ }
  }
  return null;
}

async function getAccessToken(appid, secret) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expire > now) return tokenCache.token;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.access_token) throw new Error("获取 access_token 失败：" + (j.errmsg || JSON.stringify(j)));
  tokenCache = { token: j.access_token, expire: now + (j.expires_in - 300) * 1000 };
  return j.access_token;
}

async function uploadThumb(accessToken, cover) {
  let bytes, contentType = "image/png";
  if (cover.startsWith("http")) {
    const r = await fetch(cover);
    bytes = new Uint8Array(await r.arrayBuffer());
    contentType = r.headers.get("content-type") || "image/png";
  } else {
    const m = cover.match(/^data:(.*?);base64,(.*)$/);
    if (m) { contentType = m[1]; bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); }
    else throw new Error("cover 格式不支持");
  }
  const form = new FormData();
  form.append("media", new Blob([bytes], { type: contentType }), "cover.png");
  const r = await fetch(`https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`, {
    method: "POST", body: form,
  });
  const j = await r.json();
  if (!j.media_id) throw new Error("上传封面失败：" + (j.errmsg || JSON.stringify(j)));
  return j.media_id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    // ---- 解析端点 ----
    if (url.pathname === "/api/parse" && request.method === "GET") {
      const target = url.searchParams.get("url") || "";
      if (!target) return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 url 参数" }), { status: 400, headers: cors() });
      try {
        const res = await parseDouyin(target);
        if (!res) return new Response(JSON.stringify({ errcode: 2, errmsg: "解析失败：链接无效或抖音已限制" }), { status: 200, headers: cors() });
        return new Response(JSON.stringify({ errcode: 0, ...res }), { status: 200, headers: cors() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 500, headers: cors() });
      }
    }

    // ---- 草稿箱端点 ----
    if (url.pathname === "/api/wechat/draft") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors() });
      const appid = env.WECHAT_APPID, secret = env.WECHAT_SECRET;
      if (!appid || !secret) return new Response(JSON.stringify({ errcode: 1, errmsg: "Worker 未配置 WECHAT_APPID/WECHAT_SECRET" }), { status: 500, headers: cors() });

      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ errcode: 1, errmsg: "请求体不是合法 JSON" }), { status: 400, headers: cors() }); }

      const { title, content, digest = "", cover } = body;
      if (!title || !content) return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 title 或 content" }), { status: 400, headers: cors() });

      try {
        const token = await getAccessToken(appid, secret);
        const thumb_media_id = cover ? await uploadThumb(token, cover) : "";
        if (!thumb_media_id) return new Response(JSON.stringify({ errcode: 1, errmsg: "未提供封面，无法创建草稿（微信要求 thumb_media_id）" }), { status: 400, headers: cors() });

        const draftRes = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            articles: [{
              title, author: "AI工作台", digest,
              content, content_source_url: "",
              thumb_media_id, need_open_comment: 0, only_fans_can_comment: 0,
            }],
          }),
        });
        const j = await draftRes.json();
        if (j.errcode === 0) return new Response(JSON.stringify({ errcode: 0, media_id: j.media_id, ok: true }), { headers: cors() });
        return new Response(JSON.stringify({ errcode: j.errcode, errmsg: j.errmsg }), { status: 502, headers: cors() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 502, headers: cors() });
      }
    }

    return new Response("Not Found", { status: 404, headers: cors() });
  },
};
