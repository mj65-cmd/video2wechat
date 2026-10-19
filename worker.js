/**
 * Cloudflare Worker —— 视频→公众号 草稿箱桥接
 * 作用：纯前端网页无法直接调微信（密钥泄露 + 滚动 IP 触发 40164），
 *      用本 Worker 保管 AppID/Secret、固定出口 IP，并加 CORS 头让静态页可直连。
 * 免费：Cloudflare Workers 免费层（每天 10 万请求）足够个人使用。
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler secret put WECHAT_APPID   # 输入你的公众号 AppID
 *   wrangler secret put WECHAT_SECRET  # 输入 AppSecret
 *   wrangler deploy
 * 前端「配置」里填：https://<你的worker>.workers.dev/api/wechat/draft
 */

let tokenCache = { token: null, expire: 0 };

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

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
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
  },
};
