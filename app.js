/* 视频→公众号 一键成文工作台 —— 纯前端逻辑
 * 设计原则：零后端、零费用、不依赖 WorkBuddy/言序；解析与推送均含兜底防停摆。
 */
(function () {
  "use strict";

  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);
  const LS = window.localStorage;

  function setStatus(elId, msg, type) {
    const el = $(elId);
    el.textContent = msg;
    el.className = "status show " + (type || "info");
  }
  function hideStatus(elId) { $(elId).className = "status"; }

  function deepFindMediaUrl(obj) {
    // 在任意嵌套 JSON 中找第一个看起来像视频/音频直链的 http(s) 字符串
    let found = null;
    (function walk(o) {
      if (found) return;
      if (typeof o === "string") {
        if (/^https?:\/\//.test(o)) {
          const low = o.toLowerCase();
          if (/\.(mp4|m4a|mp3|webm|mov)(\?|$)/.test(low) ||
              /(douyin|muscdn|byteimg|aweme|tiktok|cdn)/.test(low)) {
            found = o;
          }
        }
      } else if (Array.isArray(o)) {
        o.forEach(walk);
      } else if (o && typeof o === "object") {
        Object.values(o).forEach(walk);
      }
    })(obj);
    return found;
  }

  function deepFindTitle(obj) {
    let found = null;
    (function walk(o) {
      if (found) return;
      if (typeof o === "string" && o.length > 2 && o.length < 120) {
        if (/(标题|title|desc|description|text|内容)/i.test(JSON.stringify(o)) === false && /[\u4e00-\u9fa5]{4,}/.test(o)) {
          // 优先取明确字段
        }
      }
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (/(title|desc|description|text|内容|caption)/i.test(k) && typeof v === "string" && v.length > 3) {
            found = v; break;
          }
          walk(v);
        }
      }
    })(obj);
    return found;
  }

  // ---------- 解析（多级降级） ----------
  const PARSE_SOURCES = [
    { name: "aa1.cn（主，已验证 CORS）", url: (u) => "https://v.api.aa1.cn/api/douyin/index.php?url=" + encodeURIComponent(u) },
    { name: "vvhan", url: (u) => "https://api.vvhan.com/api/douyin/parse?url=" + encodeURIComponent(u) },
    { name: "pearktrue", url: (u) => "https://api.pearktrue.cn/api/douyin/?url=" + encodeURIComponent(u) },
    { name: "eryou", url: (u) => "https://api.eryou.net/api/douyin/?url=" + encodeURIComponent(u) },
  ];

  async function tryParse(src, url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(src.url(url), { signal: ctrl.signal, headers: { "Accept": "application/json" } });
      clearTimeout(t);
      if (!r.ok) return null;
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { return null; }
      const media = deepFindMediaUrl(json);
      if (!media) return null;
      const title = deepFindTitle(json);
      return { media, title, source: src.name };
    } catch (e) {
      clearTimeout(t);
      return null; // CORS/网络/超时 → 该源不可用
    }
  }

  async function doParse() {
    const url = ($("inpUrl").value || "").trim();
    if (!url) { setStatus("parseStatus", "请先粘贴抖音链接", "warn"); return; }
    setStatus("parseStatus", "正在解析（依次尝试多个免费源）…", "info");
    $("btnParse").disabled = true;
    let result = null;
    for (const src of PARSE_SOURCES) {
      setStatus("parseStatus", "尝试：" + src.name + " …", "info");
      result = await tryParse(src, url);
      if (result) break;
    }
    $("btnParse").disabled = false;

    if (result) {
      $("mediaLink").href = result.media;
      $("mediaLink").textContent = result.media;
      $("parseResult").classList.remove("hidden");
      setStatus("parseStatus", "✅ 解析成功（" + result.source + "）" + (result.title ? "｜" + result.title : ""), "ok");
    } else {
      $("parseResult").classList.add("hidden");
      setStatus("parseStatus",
        "⚠️ 自动解析暂不可用（免费源被拦/失效）。兜底方案：① 直接在本页「上传媒体文件」拿去 JotMe；② 复制链接到任意抖音解析站下载后上传。",
        "warn");
    }
  }

  // ---------- JotMe 跳转 ----------
  function openJotMe() {
    const type = $("jotmeType").value; // video-to-text / audio-to-text
    window.open("https://translate.jotme.io/zh-cn/" + type, "_blank", "noopener");
  }

  // ---------- 改写（DeepSeek / OpenAI） ----------
  const STYLE_PROMPTS = {
    pro: "文风「专业干货」：结构清晰、逻辑严密，使用小标题分段；补充必要的行业背景，给出适用场景、优缺点与对比；语言准确克制，少用口语化表达。",
    casual: "文风「轻松口语」：像和朋友聊技术一样自然，短句为主，适当使用 emoji 与反问；把专业概念讲得通俗好懂，保持亲切感。",
    story: "文风「故事种草」：用一个具体的使用场景或痛点开场，带情绪与画面感，逐步引出工具/模型的价值，结尾给出行动建议；可读性强、有代入感。",
  };

  const SYSTEM_BASE =
    "你是一名资深 AI 科普作者，擅长把 AI 模型与工具类知识写得通俗易懂又有深度。" +
    "请基于用户提供的转写文字（可能口语化、有口误）进行深度改写，要求：" +
    "1）忠实原意，不编造事实；2）为 AI 新手补充必要背景；3）给出具体例子或对比；4）给读者明确的「下一步」建议；" +
    "5）输出可直接用于微信公众号的 HTML（仅用 h2/p/strong/em/ul-li/blockquote 等基础标签，不要外链样式、不要 script）；" +
    "6）只返回一个 JSON 对象，格式：{\"title\":\"文章标题\",\"html\":\"<文章HTML>\"},不要任何额外说明。";

  function buildUserPrompt(transcript, style) {
    return "目标文风：" + STYLE_PROMPTS[style] + "\n\n以下是原始转写文字：\n" + transcript + "\n";
  }

  async function callLLM(provider, apiKey, transcript, style) {
    const isDS = provider === "deepseek";
    const endpoint = isDS ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
    const model = isDS ? "deepseek-chat" : "gpt-4o-mini";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_BASE },
          { role: "user", content: buildUserPrompt(transcript, style) },
        ],
        temperature: 0.7,
        response_format: isDS ? { type: "json_object" } : undefined,
      }),
    });
    clearTimeout(t);
    if (!r.ok) {
      const err = await r.text();
      throw new Error("API " + r.status + "：" + err.slice(0, 200));
    }
    const j = await r.json();
    return j.choices[0].message.content;
  }

  function parseModelOutput(text) {
    let s = (text || "").trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      const o = JSON.parse(s);
      if (o && o.html) return { title: o.title || "", html: o.html };
    } catch (e) { /* fall through */ }
    // 兜底：当纯 HTML
    const m = s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || s.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    return { title: m ? m[1].replace(/<[^>]+>/g, "").trim() : "未命名标题", html: s };
  }

  async function doRewrite() {
    const transcript = ($("inpTranscript").value || "").trim();
    if (!transcript) { setStatus("rewriteStatus", "请先在步骤 2 粘贴转写文字", "warn"); return; }
    const provider = $("selProvider").value;
    const style = $("selStyle").value;
    let apiKey = ($("inpKey").value || "").trim();
    if (!apiKey) {
      apiKey = (LS.getItem("v2w_key") || "").trim();
      if (apiKey) $("inpKey").value = apiKey;
    }
    if (!apiKey) { setStatus("rewriteStatus", "请填写 API Key（DeepSeek 或 OpenAI）", "warn"); return; }

    setStatus("rewriteStatus", "正在调用 " + (provider === "deepseek" ? "DeepSeek" : "OpenAI") + " 改写（" + $("selStyle").selectedOptions[0].text + "）…", "info");
    $("btnRewrite").disabled = true;
    try {
      const raw = await callLLM(provider, apiKey, transcript, style);
      const out = parseModelOutput(raw);
      $("inpArticle").value = out.html;
      if (out.title) $("inpTitle").value = out.title;
      LS.setItem("v2w_key", apiKey);
      renderPreview();
      setStatus("rewriteStatus", "✅ 改写完成，可手动微调后推送", "ok");
    } catch (e) {
      setStatus("rewriteStatus", "❌ 改写失败：" + e.message, "err");
    } finally {
      $("btnRewrite").disabled = false;
    }
  }

  // ---------- 预览 ----------
  function renderPreview() {
    const html = ($("inpArticle").value || "").trim();
    const title = ($("inpTitle").value || "").trim();
    const pre = $("preview");
    pre.innerHTML = (title ? "<h1>" + escapeHtml(title) + "</h1>" : "") + (html || "<p class='hint'>（暂无内容）</p>");
  }
  function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

  // ---------- 封面生成（canvas，避免外部依赖） ----------
  async function getCoverDataUrl() {
    const fileInput = $("inpCover");
    if (fileInput.files && fileInput.files[0]) {
      return await fileToDataUrl(fileInput.files[0]);
    }
    // 默认封面：渐变 + 标题文字
    const title = ($("inpTitle").value || "AI 工具分享").slice(0, 18);
    const c = document.createElement("canvas");
    c.width = 900; c.height = 500;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 900, 500);
    g.addColorStop(0, "#2f6bff"); g.addColorStop(1, "#7b5cff");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 900, 500);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = "bold 56px 'PingFang SC','Microsoft YaHei',sans-serif";
    wrapText(ctx, title, 60, 230, 780, 70);
    ctx.font = "28px 'PingFang SC',sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.fillText("视频转公众号 · 一键成文", 60, 430);
    return c.toDataURL("image/png");
  }
  function wrapText(ctx, text, x, y, maxW, lh) {
    const chars = text.split("");
    let line = "", yy = y;
    for (const ch of chars) {
      if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, x, yy); line = ch; yy += lh; }
      else line += ch;
    }
    ctx.fillText(line, x, yy);
  }
  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  // ---------- 推送 ----------
  async function doPush() {
    const html = ($("inpArticle").value || "").trim();
    const title = ($("inpTitle").value || "未命名文章").trim();
    if (!html) { setStatus("pushStatus", "请先完成改写生成成稿", "warn"); return; }

    const workerUrl = (LS.getItem("v2w_worker") || "").trim();
    if (!workerUrl) {
      // 兜底：复制 + 开后台
      return manualPush(html, title);
    }
    setStatus("pushStatus", "正在通过 Worker 推送到草稿箱…", "info");
    $("btnPush").disabled = true;
    try {
      const cover = await getCoverDataUrl();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(workerUrl, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: html, digest: ($("inpDigest").value || "").trim(), cover }),
      });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (j && (j.errcode === 0 || j.media_id || j.ok)) {
        setStatus("pushStatus", "✅ 已推送到公众号草稿箱！（media_id: " + (j.media_id || "-") + "）去公众号后台看看吧。", "ok");
      } else {
        setStatus("pushStatus", "⚠️ Worker 返回异常：" + JSON.stringify(j).slice(0, 200) + "。可改用「复制+开后台手动存」。", "warn");
      }
    } catch (e) {
      setStatus("pushStatus", "❌ 推送失败：" + e.message + "。可改用「复制+开后台手动存」。", "err");
    } finally {
      $("btnPush").disabled = false;
    }
  }

  async function manualPush(html, title) {
    try {
      await navigator.clipboard.writeText(html);
      setStatus("pushStatus", "✅ 文章 HTML 已复制到剪贴板。正在打开公众号后台，粘贴到正文即可存草稿。", "ok");
    } catch {
      setStatus("pushStatus", "请手动复制下方成稿，再打开公众号后台粘贴存草稿。", "warn");
    }
    window.open("https://mp.weixin.qq.com", "_blank", "noopener");
  }

  // ---------- 清空 / 重跑 ----------
  function clearAll() {
    ["inpUrl","inpTranscript","inpArticle","inpTitle","inpDigest","inpKey"].forEach(id=>$(id).value="");
    $("inpFile").value=""; $("inpCover").value="";
    $("parseResult").classList.add("hidden");
    ["parseStatus","transcriptStatus","rewriteStatus","pushStatus"].forEach(hideStatus);
    $("preview").innerHTML = "<p class='hint'>（预览区）</p>";
  }

  function handleRerun(kind) {
    if (kind === "parse") doParse();
    else if (kind === "transcribe") openJotMe();
    else if (kind === "rewrite") doRewrite();
    else if (kind === "push") doPush();
  }

  // ---------- 配置弹窗 ----------
  function openSettings() { $("cfgWorker").value = LS.getItem("v2w_worker") || ""; $("settingsModal").classList.remove("hidden"); }
  function saveSettings() {
    const v = ($("cfgWorker").value || "").trim();
    if (v) LS.setItem("v2w_worker", v); else LS.removeItem("v2w_worker");
    $("settingsModal").classList.add("hidden");
  }

  // ---------- 事件绑定 ----------
  document.addEventListener("DOMContentLoaded", function () {
    $("btnParse").addEventListener("click", doParse);
    $("btnJotMe").addEventListener("click", openJotMe);
    $("btnUseTranscript").addEventListener("click", () => setStatus("transcriptStatus", "✅ 已采用，可到步骤 3 改写", "ok"));
    $("btnRewrite").addEventListener("click", doRewrite);
    $("inpArticle").addEventListener("input", renderPreview);
    $("inpTitle").addEventListener("input", renderPreview);
    $("btnPush").addEventListener("click", doPush);
    $("btnManual").addEventListener("click", () => manualPush($("inpArticle").value, $("inpTitle").value));
    $("btnClearAll").addEventListener("click", clearAll);
    document.querySelectorAll(".btn.rerun").forEach(b => b.addEventListener("click", () => handleRerun(b.dataset.rerun)));
    $("btnSettings").addEventListener("click", openSettings);
    $("btnSaveCfg").addEventListener("click", saveSettings);
    $("btnCloseCfg").addEventListener("click", () => $("settingsModal").classList.add("hidden"));

    // 预填本地保存的 key
    const k = LS.getItem("v2w_key");
    if (k) $("inpKey").value = k;
    renderPreview();

    console.log("[v2w] 工作台已就绪。Worker 地址：" + (LS.getItem("v2w_worker") || "（未配置，将用手动兜底）"));
  });
})();
