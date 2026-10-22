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

function corsHeaders() {
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

// ---------- 改写中转（OpenRouter 密钥放服务端，前端无需粘贴；限流自动换免费模型） ----------
const REWRITE_STYLE = {
  pro: "文风「专业干货」：结构清晰、逻辑严密，使用小标题分段；补充必要的行业背景，给出适用场景、优缺点与对比；语言准确克制，少用口语化表达。",
  casual: "文风「轻松口语」：像和朋友聊技术一样自然，短句为主，适当使用 emoji 与反问；把专业概念讲得通俗好懂，保持亲切感。",
  story: "文风「故事种草」：用一个具体的使用场景或痛点开场，带情绪与画面感，逐步引出工具/模型的价值，结尾给出行动建议；可读性强、有代入感。",
};
const REWRITE_SYSTEM =
  "你是一名资深 AI 科普作者，擅长把 AI 模型与工具类知识写得通俗易懂又有深度。" +
  "请基于用户提供的转写文字（可能口语化、有口误）进行深度改写，要求：" +
  "1）忠实原意，不编造事实；2）为 AI 新手补充必要背景；3）给出具体例子或对比；4）给读者明确的「下一步」建议；" +
  "5）输出可直接用于微信公众号的 HTML（仅用 h2/p/strong/em/ul-li/blockquote 等基础标签，不要外链样式、不要 script）；" +
  "6）只返回一个 JSON 对象，格式：{\"title\":\"文章标题\",\"html\":\"<文章HTML>\"},不要任何额外说明。";
const REWRITE_PREFERRED = [
  "google/gemma-4-31b-it:free",
  "minimax/minimax-m3.1-flash:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

async function handleRewrite(request, env, corsHeaders) {
  if (!env.OPENROUTER_KEY)
    return new Response(JSON.stringify({ errcode: 1, errmsg: "Worker 未配置 OPENROUTER_KEY" }), { status: 500, headers: corsHeaders() });

  // 轻量来源校验：仅允许来自本项目 Pages 域名的调用，避免公开端点被他人盗刷额度
  const ref = request.headers.get("referer") || request.headers.get("origin") || "";
  const host = new URL(request.url).host;
  const allowed = ref.includes("mj65-cmd.github.io") || host.startsWith("localhost") || host.startsWith("127.0.0.1");
  if (!allowed)
    return new Response(JSON.stringify({ errcode: 1, errmsg: "来源不被允许（仅 mj65-cmd.github.io 可调用）" }), { status: 403, headers: corsHeaders() });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ errcode: 1, errmsg: "请求体不是合法 JSON" }), { status: 400, headers: corsHeaders() }); }

  const transcript = (body.transcript || "").trim();
  const style = body.style || "pro";
  if (!transcript) return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 transcript" }), { status: 400, headers: corsHeaders() });

  // 拉取实时免费模型列表（prompt 价格为 0），失败则用内置兜底
  let freeList = [];
  try {
    const mr = await fetch("https://openrouter.ai/api/v1/models");
    const mj = await mr.json();
    freeList = (mj.data || []).filter((m) => m.pricing && (parseFloat(m.pricing.prompt) || 0) === 0).map((m) => m.id);
  } catch (e) { /* 用兜底 */ }
  if (!freeList.length) freeList = REWRITE_PREFERRED.slice();
  const ordered = [...REWRITE_PREFERRED.filter((m) => freeList.includes(m)), ...freeList.filter((m) => !REWRITE_PREFERRED.includes(m))].slice(0, 6);

  const userPrompt = "目标文风：" + (REWRITE_STYLE[style] || REWRITE_STYLE.pro) + "\n\n以下是原始转写文字：\n" + transcript + "\n";

  let lastErr = null;
  for (const model of ordered) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.OPENROUTER_KEY,
          "HTTP-Referer": "https://mj65-cmd.github.io/video2wechat/",
          "X-Title": "video2wechat",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: REWRITE_SYSTEM },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
        }),
      });
      if (r.status === 429) { lastErr = model + " 限流"; continue; }
      if (!r.ok) { const tx = await r.text(); lastErr = "HTTP " + r.status + " " + tx.slice(0, 120); continue; }
      const j = await r.json();
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) { lastErr = "空内容返回"; continue; }
      // 原样返回 OpenRouter 响应，前端 parseModelOutput 可直接解析
      return new Response(JSON.stringify(j), { headers: corsHeaders() });
    } catch (e) {
      lastErr = e.message;
    }
  }
  return new Response(JSON.stringify({ errcode: 1, errmsg: "所有免费模型均失败：" + (lastErr || "未知") }), { status: 502, headers: corsHeaders() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // ---- 运行时下发 OpenRouter Key（密钥存服务端，前端运行时获取，不进公开代码）----
    if (url.pathname === "/api/or-key" && request.method === "GET") {
      if (!env.OPENROUTER_KEY)
        return new Response(JSON.stringify({ errcode: 1, errmsg: "Worker 未配置 OPENROUTER_KEY" }), { status: 500, headers: corsHeaders() });
      const ref = request.headers.get("referer") || request.headers.get("origin") || "";
      const host = new URL(request.url).host;
      const allowed = ref.includes("mj65-cmd.github.io") || host.startsWith("localhost") || host.startsWith("127.0.0.1");
      if (!allowed)
        return new Response(JSON.stringify({ errcode: 1, errmsg: "来源不被允许" }), { status: 403, headers: corsHeaders() });
      return new Response(JSON.stringify({ key: env.OPENROUTER_KEY }), { headers: corsHeaders() });
    }

    // ---- 解析端点 ----
    if (url.pathname === "/api/parse" && request.method === "GET") {
      const target = url.searchParams.get("url") || "";
      if (!target) return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 url 参数" }), { status: 400, headers: corsHeaders() });
      try {
        const res = await parseDouyin(target);
        if (!res) return new Response(JSON.stringify({ errcode: 2, errmsg: "解析失败：链接无效或抖音已限制" }), { status: 200, headers: corsHeaders() });
        return new Response(JSON.stringify({ errcode: 0, ...res }), { status: 200, headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 500, headers: corsHeaders() });
      }
    }

    // ---- 草稿箱端点 ----
    if (url.pathname === "/api/wechat/draft") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
      const appid = env.WECHAT_APPID, secret = env.WECHAT_SECRET;
      if (!appid || !secret) return new Response(JSON.stringify({ errcode: 1, errmsg: "Worker 未配置 WECHAT_APPID/WECHAT_SECRET" }), { status: 500, headers: corsHeaders() });

      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ errcode: 1, errmsg: "请求体不是合法 JSON" }), { status: 400, headers: corsHeaders() }); }

      const { title, content, digest = "", cover } = body;
      if (!title || !content) return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 title 或 content" }), { status: 400, headers: corsHeaders() });

      try {
        const token = await getAccessToken(appid, secret);
        const thumb_media_id = cover ? await uploadThumb(token, cover) : "";
        if (!thumb_media_id) return new Response(JSON.stringify({ errcode: 1, errmsg: "未提供封面，无法创建草稿（微信要求 thumb_media_id）" }), { status: 400, headers: corsHeaders() });

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
        if (j.errcode === 0) return new Response(JSON.stringify({ errcode: 0, media_id: j.media_id, ok: true }), { headers: corsHeaders() });
        return new Response(JSON.stringify({ errcode: j.errcode, errmsg: j.errmsg }), { status: 502, headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 502, headers: corsHeaders() });
      }
    }

    // ---- 转写端点（解析后直接转写，免去下载→上传 JotMe）----
    if (url.pathname === "/api/transcribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return new Response(JSON.stringify({ errcode: 1, errmsg: "请求体不是合法 JSON" }), { status: 400, headers: corsHeaders() }); }
      const { url: mediaUrl, apiKey, model = "whisper-1" } = body;
      if (!mediaUrl || !apiKey)
        return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 media url 或 OpenAI apiKey" }), { status: 400, headers: corsHeaders() });
      try {
        const mediaRes = await fetch(mediaUrl, { headers: { "User-Agent": MOBILE_UA } });
        if (!mediaRes.ok)
          return new Response(JSON.stringify({ errcode: 2, errmsg: "拉取媒体失败（HTTP " + mediaRes.status + "）" }), { status: 502, headers: corsHeaders() });
        const buf = await mediaRes.arrayBuffer();
        if (buf.byteLength > 25 * 1024 * 1024)
          return new Response(JSON.stringify({ errcode: 3, errmsg: "媒体超过 25MB（OpenAI 限制），请用 JotMe 手动转写" }), { status: 413, headers: corsHeaders() });
        const contentType = mediaRes.headers.get("content-type") || "video/mp4";
        const form = new FormData();
        form.append("file", new Blob([buf], { type: contentType }), "media.mp4");
        form.append("model", model);
        form.append("response_format", "json");
        const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + apiKey },
          body: form,
        });
        const tj = await tr.json();
        if (!tr.ok) return new Response(JSON.stringify({ errcode: tr.status, errmsg: (tj.error && tj.error.message) || "转写请求失败" }), { status: 502, headers: corsHeaders() });
        return new Response(JSON.stringify({ errcode: 0, text: tj.text || "" }), { headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 502, headers: corsHeaders() });
      }
    }

    // ---- 转写引擎运行时 wasm 代理（transformers.js 默认从 jsdelivr 拉，国内不稳）----
    if (url.pathname.startsWith("/api/ort/") && request.method === "GET") {
      const file = url.pathname.slice("/api/ort/".length);
      if (!file || file.includes("..") || file.includes("?")) return new Response(JSON.stringify({ errcode: 1, errmsg: "非法文件名" }), { status: 400, headers: corsHeaders() });
      const target = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/" + file;
      try {
        const r = await fetch(target, { redirect: "follow" });
        if (!r.ok) return new Response(JSON.stringify({ errcode: 2, errmsg: "wasm 拉取失败（HTTP " + r.status + "）" }), { status: 502, headers: corsHeaders() });
        const h = { ...corsHeaders(), "Content-Type": r.headers.get("content-type") || "application/wasm", "Cache-Control": "public, max-age=86400" };
        const cl = r.headers.get("content-length");
        if (cl) h["Content-Length"] = cl;
        return new Response(r.body, { headers: h });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 500, headers: corsHeaders() });
      }
    }

    // ---- 模型文件代理（直连 huggingface.co 官方源，Worker 边缘节点国际网络畅通）----
    if (url.pathname.startsWith("/api/hf/") && request.method === "GET") {
      const rest = url.pathname.slice("/api/hf/".length);
      if (!rest || rest.includes("..")) return new Response(JSON.stringify({ errcode: 1, errmsg: "非法路径" }), { status: 400, headers: corsHeaders() });
      const target = "https://huggingface.co/" + rest;
      try {
        const r = await fetch(target, { redirect: "follow" });
        if (!r.ok) return new Response(JSON.stringify({ errcode: 2, errmsg: "模型文件拉取失败（HTTP " + r.status + "）" }), { status: 502, headers: corsHeaders() });
        const h = { ...corsHeaders(), "Content-Type": r.headers.get("content-type") || "application/octet-stream", "Cache-Control": "public, max-age=86400" };
        const cl = r.headers.get("content-length");
        if (cl) h["Content-Length"] = cl;
        return new Response(r.body, { headers: h });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 500, headers: corsHeaders() });
      }
    }

    // ---- 改写中转（OpenRouter 密钥存服务端，前端免粘贴）----
    if (url.pathname === "/api/rewrite" && request.method === "POST") {
      try {
        return await handleRewrite(request, env, corsHeaders());
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: "Worker 内部错误：" + (e && e.message ? e.message : String(e)) }), { status: 500, headers: corsHeaders() });
      }
    }

    // ---- 媒体代理（本地 Whisper 取媒体，绕开浏览器跨域）----
    if (url.pathname === "/api/media" && request.method === "GET") {
      const target = url.searchParams.get("url") || "";
      if (!target) return new Response(JSON.stringify({ errcode: 1, errmsg: "缺少 url 参数" }), { status: 400, headers: corsHeaders() });
      try {
        const r = await fetch(target, {
          headers: { "User-Agent": MOBILE_UA, "Referer": "https://www.douyin.com/" },
          redirect: "follow",
        });
        if (!r.ok) return new Response(JSON.stringify({ errcode: 2, errmsg: "拉取媒体失败（HTTP " + r.status + "）" }), { status: 502, headers: corsHeaders() });
        // 流式转发：不把视频读进 Worker 内存（大视频会撞 128MB 内存上限导致崩溃）
        const ct = r.headers.get("content-type") || "application/octet-stream";
        const h = { ...corsHeaders(), "Content-Type": ct, "Cache-Control": "no-store" };
        const cl = r.headers.get("content-length");
        if (cl) h["Content-Length"] = cl;
        return new Response(r.body, { headers: h });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: 1, errmsg: String(e.message || e) }), { status: 500, headers: corsHeaders() });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};
