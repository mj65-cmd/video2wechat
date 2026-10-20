var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var tokenCache = { token: null, expire: 0 };
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(cors, "cors");
var MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
function extractUrls(text) {
  return (text || "").match(/https?:\/\/[^\s，,。""'）)【】]+/g) || [];
}
__name(extractUrls, "extractUrls");
function parseJsonText(txt) {
  if (!txt) return null;
  try {
    const s = txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1);
    return JSON.parse(s);
  } catch {
    return null;
  }
}
__name(parseJsonText, "parseJsonText");
async function resolveAwemeId(url) {
  let m = url.match(/\/video\/(\d+)/) || url.match(/modal_id=(\d+)/);
  if (m) return m[1];
  if (/v\.douyin\.com\//i.test(url)) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": MOBILE_UA }, redirect: "follow" });
      const finalUrl = r.url || "";
      const m2 = finalUrl.match(/\/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/);
      if (m2) return m2[1];
      const html = await r.text();
      const m3 = html.match(/"itemId"\s*:\s*"(\d+)"/) || html.match(/\/video\/(\d{15,})/) || html.match(/aweme_id=(\d+)/) || html.match(/modal_id=(\d+)/);
      if (m3) return m3[1];
    } catch {
    }
  }
  return null;
}
__name(resolveAwemeId, "resolveAwemeId");
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
      const pick = /* @__PURE__ */ __name((a) => {
        const ls = a && a.url_list || [];
        return ls.find((x) => /^https:\/\//.test(x)) || ls[0] || "";
      }, "pick");
      let media = pick(v.play_addr) || pick(v.play_addr_lowbr) || pick(v.download_addr);
      const uri = v.play_addr && v.play_addr.uri;
      if (!media && uri) media = "https://aweme.snssdk.com/aweme/v1/play/?video_id=" + uri + "&ratio=720p&line=0";
      if (!media) continue;
      return {
        media,
        title: item.desc || "",
        author: item.author && item.author.nickname || ""
      };
    } catch {
    }
  }
  return null;
}
__name(parseDouyin, "parseDouyin");
async function getAccessToken(appid, secret) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expire > now) return tokenCache.token;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.access_token) throw new Error("\u83B7\u53D6 access_token \u5931\u8D25\uFF1A" + (j.errmsg || JSON.stringify(j)));
  tokenCache = { token: j.access_token, expire: now + (j.expires_in - 300) * 1e3 };
  return j.access_token;
}
__name(getAccessToken, "getAccessToken");
async function uploadThumb(accessToken, cover) {
  let bytes, contentType = "image/png";
  if (cover.startsWith("http")) {
    const r2 = await fetch(cover);
    bytes = new Uint8Array(await r2.arrayBuffer());
    contentType = r2.headers.get("content-type") || "image/png";
  } else {
    const m = cover.match(/^data:(.*?);base64,(.*)$/);
    if (m) {
      contentType = m[1];
      bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    } else throw new Error("cover \u683C\u5F0F\u4E0D\u652F\u6301");
  }
  const form = new FormData();
  form.append("media", new Blob([bytes], { type: contentType }), "cover.png");
  const r = await fetch(`https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`, {
    method: "POST",
    body: form
  });
  const j = await r.json();
  if (!j.media_id) throw new Error("\u4E0A\u4F20\u5C01\u9762\u5931\u8D25\uFF1A" + (j.errmsg || JSON.stringify(j)));
  return j.media_id;
}
__name(uploadThumb, "uploadThumb");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === "/api/parse" && request.method === "GET") {
      const target = url.searchParams.get("url") || "";
      if (!target) return new Response(JSON.stringify({ errcode: 1, errmsg: "\u7F3A\u5C11 url \u53C2\u6570" }), { status: 400, headers: cors() });
      try {
        const res = await parseDouyin(target);
        if (!res) return new Response(JSON.stringify({ errcode: 2, errmsg: "\u89E3\u6790\u5931\u8D25\uFF1A\u94FE\u63A5\u65E0\u6548\u6216\u6296\u97F3\u5DF2\u9650\u5236" }), { status: 200, headers: cors() });
        return new Response(JSON.stringify({ errcode: 0, ...res }), { status: 200, headers: cors() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 500, headers: cors() });
      }
    }
    if (url.pathname === "/api/wechat/draft") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors() });
      const appid = env.WECHAT_APPID, secret = env.WECHAT_SECRET;
      if (!appid || !secret) return new Response(JSON.stringify({ errcode: 1, errmsg: "Worker \u672A\u914D\u7F6E WECHAT_APPID/WECHAT_SECRET" }), { status: 500, headers: cors() });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ errcode: 1, errmsg: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" }), { status: 400, headers: cors() });
      }
      const { title, content, digest = "", cover } = body;
      if (!title || !content) return new Response(JSON.stringify({ errcode: 1, errmsg: "\u7F3A\u5C11 title \u6216 content" }), { status: 400, headers: cors() });
      try {
        const token = await getAccessToken(appid, secret);
        const thumb_media_id = cover ? await uploadThumb(token, cover) : "";
        if (!thumb_media_id) return new Response(JSON.stringify({ errcode: 1, errmsg: "\u672A\u63D0\u4F9B\u5C01\u9762\uFF0C\u65E0\u6CD5\u521B\u5EFA\u8349\u7A3F\uFF08\u5FAE\u4FE1\u8981\u6C42 thumb_media_id\uFF09" }), { status: 400, headers: cors() });
        const draftRes = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            articles: [{
              title,
              author: "AI\u5DE5\u4F5C\u53F0",
              digest,
              content,
              content_source_url: "",
              thumb_media_id,
              need_open_comment: 0,
              only_fans_can_comment: 0
            }]
          })
        });
        const j = await draftRes.json();
        if (j.errcode === 0) return new Response(JSON.stringify({ errcode: 0, media_id: j.media_id, ok: true }), { headers: cors() });
        return new Response(JSON.stringify({ errcode: j.errcode, errmsg: j.errmsg }), { status: 502, headers: cors() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 502, headers: cors() });
      }
    }
    return new Response("Not Found", { status: 404, headers: cors() });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
