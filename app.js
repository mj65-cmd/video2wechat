/* 视频→公众号 一键成文工作台 —— 纯前端逻辑
 * 设计原则：零后端、零费用、不依赖 WorkBuddy/言序；解析与推送均含兜底防停摆。
 */
(function () {
  "use strict";

  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);
  const LS = window.localStorage;

  // 默认 Worker 地址（已部署，解析走服务端中转，最稳）。用户可在「配置」里覆盖。
  const DEFAULT_WORKER = "https://video2wechat-bridge.moujian65.workers.dev";

  // 读取 Worker 根地址（配置里存的是根地址，如 https://xxx.workers.dev）
  function getWorkerBase() {
    let v = (LS.getItem("v2w_worker") || "").trim().replace(/\/+$/, "");
    if (!v) v = DEFAULT_WORKER;
    if (v.endsWith("/api/wechat/draft")) v = v.replace(/\/api\/wechat\/draft$/, "");
    return v;
  }
  // 用户是否「显式」配置过 Worker（用于推送：没配微信密钥前，默认 Worker 不接推送）
  function userConfiguredWorker() {
    return !!(LS.getItem("v2w_worker") || "").trim();
  }

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

  // ---------- 解析（多级降级：免费源 → 网页自解析 → 手动兜底） ----------
  const PARSE_SOURCES = [
    { name: "aa1.cn", url: (u) => "https://v.api.aa1.cn/api/douyin/index.php?url=" + encodeURIComponent(u) },
    { name: "vvhan", url: (u) => "https://api.vvhan.com/api/douyin/parse?url=" + encodeURIComponent(u) },
    { name: "pearktrue", url: (u) => "https://api.pearktrue.cn/api/douyin/?url=" + encodeURIComponent(u) },
    { name: "eryou", url: (u) => "https://api.eryou.net/api/douyin/?url=" + encodeURIComponent(u) },
  ];

  // 免费传输通道（CORS 代理轮换）：抖音域不开放 CORS，读 JSON/页面需经代理中转
  const TRANSPORTS = [
    { name: "直连", wrap: (u) => u },
    { name: "cors.workers", wrap: (u) => "https://test.cors.workers.dev/?" + u },
    { name: "cors.lol", wrap: (u) => "https://api.cors.lol/?url=" + encodeURIComponent(u) },
    { name: "cors.eu.org", wrap: (u) => "https://cors.eu.org/" + u },
    { name: "allorigins", wrap: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u) },
    { name: "codetabs", wrap: (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u) },
  ];

  // 从用户粘贴的任意文本（分享口令等）提取 http(s) 链接
  function extractUrls(text) {
    const m = (text || "").match(/https?:\/\/[^\s，,。""'）)【】]+/g) || [];
    return m.map((s) => s.replace(/[)，。、）\]\}.,]+$/, "")).filter(Boolean);
  }

  // 经多个传输通道取回文本内容
  async function fetchViaTransports(url, timeoutMs, onTry) {
    for (const t of TRANSPORTS) {
      if (onTry) onTry(t.name);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(t.wrap(url), { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) continue;
        const txt = await r.text();
        if (txt && txt.length > 20) return txt;
      } catch (e) { /* 该通道失败，换下一个 */ }
    }
    return null;
  }

  // 从链接（或其分享页内容）解析出视频 aweme_id
  async function resolveAwemeId(url, onTry) {
    let m = url.match(/\/video\/(\d+)/) || url.match(/modal_id=(\d+)/);
    if (m) return m[1];
    if (/v\.douyin\.com\//i.test(url)) {
      // 短链：取分享页内容（代理会跟随302），从中找 itemId
      const html = await fetchViaTransports(url, 10000, onTry);
      if (html) {
        const m2 = html.match(/"itemId"\s*:\s*"(\d+)"/) ||
                  html.match(/\/video\/(\d{15,})/) ||
                  html.match(/aweme_id=(\d+)/) ||
                  html.match(/modal_id=(\d+)/);
        if (m2) return m2[1];
      }
    }
    return null;
  }

  // 用 aweme_id 调 snssdk feed 接口拿标题 + 播放直链（已实测可用）
  async function fetchInfoById(id, onTry) {
    const api = "https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=" + id;
    const txt = await fetchViaTransports(api, 15000, onTry);
    if (!txt) return null;
    try {
      const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
      const item = j.aweme_list && j.aweme_list[0];
      if (!item) return null;
      const v = item.video || {};
      const pick = (a) => {
        const ls = (a && a.url_list) || [];
        return ls.find((u) => /^https:\/\//.test(u)) || ls[0] || "";
      };
      let media = pick(v.play_addr) || pick(v.play_addr_lowbr) || pick(v.download_addr);
      const uri = v.play_addr && v.play_addr.uri;
      if (!media && uri) media = "https://aweme.snssdk.com/aweme/v1/play/?video_id=" + uri + "&ratio=720p&line=0";
      if (!media) return null;
      return {
        media,
        title: item.desc || "",
        author: (item.author && item.author.nickname) || "",
        source: "网页自解析（snssdk feed）",
      };
    } catch (e) { return null; }
  }

  async function tryParse(src, url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(src.url(url), { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { return null; }
      const media = deepFindMediaUrl(json);
      if (!media) return null;
      return { media, title: deepFindTitle(json), author: "", source: src.name };
    } catch (e) {
      clearTimeout(t);
      return null;
    }
  }

  async function doParse() {
    const raw = ($("inpUrl").value || "").trim();
    if (!raw) { setStatus("parseStatus", "请先粘贴抖音链接（直接把分享口令整段粘贴进来也行）", "warn"); return; }
    const urls = extractUrls(raw);
    if (!urls.length) { setStatus("parseStatus", "没有在输入里找到链接，请确认包含 https://v.douyin.com/... ", "warn"); return; }

    $("btnParse").disabled = true;
    let result = null;

    // 第零级：已配置 Worker 则优先走服务端解析（最稳，绕开 CORS/代理）
    const wbase = getWorkerBase();
    if (wbase) {
      setStatus("parseStatus", "经 Worker 服务端解析（最稳）…", "info");
      try {
        const r = await fetch(wbase + "/api/parse?url=" + encodeURIComponent(urls[0]), { headers: { "Accept": "application/json" } });
        const j = await r.json();
        if (j && j.errcode === 0 && j.media) {
          result = { media: j.media, title: j.title || "", author: j.author || "", source: "Worker 服务端解析" };
        } else if (j && j.errmsg) {
          setStatus("parseStatus", "Worker 解析：" + j.errmsg + "，转备用通道…", "warn");
        }
      } catch (e) {
        setStatus("parseStatus", "Worker 解析异常：" + e.message + "，转备用通道…", "warn");
      }
    }

    // 第一级：免费解析源（快速跳过失效源）
    if (!result) {
      for (const src of PARSE_SOURCES) {
        setStatus("parseStatus", "尝试免费源：" + src.name + " …", "info");
        result = await tryParse(src, urls[0]);
        if (result) break;
      }
    }

    // 第二级：网页自解析（短链→ID→feed接口，经免费代理中转）
    if (!result) {
      for (const u of urls.slice(0, 3)) {
        setStatus("parseStatus", "免费源不可用，转网页自解析：识别视频 ID…", "info");
        const id = await resolveAwemeId(u, (tName) =>
          setStatus("parseStatus", "网页自解析：识别视频 ID（通道 " + tName + "）…", "info"));
        if (!id) continue;
        setStatus("parseStatus", "已拿到视频 ID " + id.slice(-6) + "，获取播放地址…", "info");
        result = await fetchInfoById(id, (tName) =>
          setStatus("parseStatus", "网页自解析：获取播放地址（通道 " + tName + "）…", "info"));
        if (result) break;
      }
    }
    $("btnParse").disabled = false;

    if (result) {
      $("mediaLink").href = result.media;
      $("mediaLink").textContent = result.media.length > 80 ? result.media.slice(0, 80) + "…" : result.media;
      window.__lastMedia = result.media;
      $("parseResult").classList.remove("hidden");
      setStatus("parseStatus",
        "✅ 解析成功（" + result.source + "）" +
        (result.title ? "｜《" + result.title.slice(0, 30) + "》" : "") +
        (result.author ? "｜@" + result.author : "") +
        "，点击链接下载视频后去 JotMe 转写", "ok");
    } else {
      $("parseResult").classList.add("hidden");
      setStatus("parseStatus",
        "⚠️ 自动解析全部通道不可用（免费源失效或代理限流，通常过一会重试即可）。" +
        "兜底：① 用「上传媒体文件」直接拿去 JotMe；② 或点下方按钮搜一个在线解析站手动下载。",
        "warn");
      showManualParseLinks();
    }
  }

  function showManualParseLinks() {
    const el = $("parseStatus");
    const q = encodeURIComponent("抖音去水印解析 在线");
    el.innerHTML =
      '⚠️ 自动解析暂不可用（免费源失效或代理限流，通常稍后重试即可）。兜底：' +
      '① 用「上传媒体文件」直接拿去 JotMe；② 或 <a href="https://parsedock.kitt.tools/douyin" target="_blank" rel="noopener">打开 ParseDock 解析 ↗</a> / ' +
      '<a href="https://www.bing.com/search?q=' + q + '" target="_blank" rel="noopener">搜索其他解析站 ↗</a>，把链接粘贴过去下载视频后回来上传。';
    el.className = "status show warn";
  }

  // ---------- 打开指定的解析工具（手动兜底） ----------
  function copyLinkToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    } catch (e) { /* 忽略复制失败，不阻断跳转 */ }
  }

  function openParserTool(url) {
    const raw = ($("inpUrl").value || "").trim();
    const urls = extractUrls(raw);
    let copied = false;
    if (urls.length) { copyLinkToClipboard(urls[0]); copied = true; }
    window.open(url, "_blank", "noopener");
    setStatus("parseStatus",
      "已在新标签页打开 ParseDock 解析" +
      (copied ? "，你的抖音链接已复制到剪贴板，直接粘贴即可" : "，把抖音视频链接（v.douyin.com 或 douyin.com/video/...）粘贴到该网站") +
      "，下载视频后回到本页用「上传媒体文件」继续。", "info");
  }

  // ---------- JotMe 跳转 ----------
  function openJotMe() {
    const type = $("jotmeType").value; // video-to-text / audio-to-text
    window.open("https://translate.jotme.io/zh-cn/" + type, "_blank", "noopener");
  }

  // ---------- 解析后直接转写（OpenAI 优先，无 Key 则本地 Whisper） ----------
  async function doAutoTranscribe() {
    const media = window.__lastMedia;
    if (!media) { setStatus("parseStatus", "请先解析成功，再点直接转写", "warn"); return; }

    const wbase = getWorkerBase();
    if (!wbase) {
      setStatus("parseStatus", "直接转写需走 Worker（避免浏览器 CORS）。当前未配置 Worker，请先在「⚙ 配置」填入 Worker 根地址。", "warn");
      return;
    }

    const provider = ($("selProvider") && $("selProvider").value) || "openai";
    const apiKey = ($("inpKey") && ($("inpKey").value || "").trim()) || "";

    // 有 OpenAI Key → 服务端快速转写
    if (apiKey && provider === "openai") {
      $("btnAutoTranscribe").disabled = true;
      setStatus("parseStatus", "正在经 Worker 调用 OpenAI 转写（无需你下载）…", "info");
      try {
        const r = await fetch(wbase + "/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: media, apiKey, model: "whisper-1" }),
        });
        const j = await r.json();
        if (j && j.errcode === 0 && j.text) {
          $("inpTranscript").value = j.text;
          setStatus("parseStatus", "✅ 转写完成，文字已回填到步骤 2，可直接点「采用此文字进入改写」。", "ok");
        } else if (j && j.errcode === 3) {
          setStatus("parseStatus", "媒体超过 25MB，OpenAI 通道不可用，自动改走「本地 Whisper（无需 Key）」…", "info");
          await transcribeLocal(media, wbase);
        } else {
          setStatus("parseStatus", "OpenAI 转写失败：" + (j && j.errmsg ? j.errmsg : "未知错误") + "。可改用步骤 2 的「去 JotMe 转写」手动上传。", "warn");
        }
      } catch (e) {
        setStatus("parseStatus", "转写请求异常：" + e.message + "。可改用步骤 2 的「去 JotMe 转写」手动上传。", "warn");
      }
      $("btnAutoTranscribe").disabled = false;
      return;
    }

    // 无 OpenAI Key（或不是 OpenAI）→ 本地 Whisper，零门槛
    await transcribeLocal(media, wbase);
    $("btnAutoTranscribe").disabled = false;
  }

  // ---------- 本地 Whisper（transformers.js，免 Key、无大小限制） ----------
  let _asr = null;
  async function transcribeLocal(mediaUrl, wbase) {
    const btn = $("btnAutoTranscribe");
    btn.disabled = true;
    // 阶段 1：取媒体
    let buf;
    try {
      setStatus("parseStatus", "【1/4】正在经 Worker 取回媒体（大视频需等一会儿）…", "info");
      const res = await fetch(wbase + "/api/media?url=" + encodeURIComponent(mediaUrl));
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error("HTTP " + res.status + (j.errmsg ? "，" + j.errmsg : ""));
      }
      buf = await res.arrayBuffer();
    } catch (e) {
      setStatus("parseStatus", "❌ 取媒体阶段失败：" + e.message + "。可能是网络中断，重试一次通常可恢复；反复失败请改用 JotMe。", "warn");
      btn.disabled = false;
      return;
    }
    // 阶段 2：解码音频
    let pcm;
    try {
      setStatus("parseStatus", "【2/4】正在解码音频…", "info");
      pcm = await decodeToMono16k(buf);
    } catch (e) {
      setStatus("parseStatus", "❌ 音频解码失败（浏览器解不开该视频的音轨）。请改用步骤 2 的「去 JotMe 转写」。", "warn");
      btn.disabled = false;
      return;
    }
    // 阶段 3：加载转写库 + 模型
    try {
      setStatus("parseStatus", "【3/4】正在准备本地转写引擎…", "info");
      if (!_asr) {
        // 转写库 ESM 多源降级：国内镜像优先，jsdelivr / esm.sh 兜底
        const cdns = [
          "https://registry.npmmirror.com/@xenova/transformers/2.17.2/files/dist/transformers.min.js",
          "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm",
          "https://esm.sh/@xenova/transformers@2.17.2",
        ];
        let mod = null, lastErr = null;
        for (const u of cdns) {
          try { mod = await import(u); break; } catch (e) { lastErr = e; }
        }
        if (!mod) throw new Error("转写库无法加载（三个源均不可达：" + (lastErr && lastErr.message) + "）");
        // 模型 + wasm 全部经我们自己的 Worker 中转（浏览器→Worker 这条路已被解析功能验证稳定）
        let loadErrs = [];
        for (const cfg of [
          { name: "Worker中转", host: wbase + "/api/hf", wasm: wbase + "/api/ort/" },
          { name: "hf-mirror直连", host: "https://hf-mirror.com", wasm: null },
        ]) {
          try {
            if (mod.env) {
              mod.env.remoteHost = cfg.host;
              try { if (cfg.wasm && mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) mod.env.backends.onnx.wasm.wasmPaths = cfg.wasm; } catch (e) { /* 无此配置则保留默认 */ }
            }
            _asr = await mod.pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
              quantized: true,
              progress_callback: (p) => {
                if (p && p.status === "progress" && p.total) {
                  setStatus("parseStatus", "【3/4】正在下载语音模型 " + Math.round((p.loaded || 0) / 1048576) + "/" + Math.round(p.total / 1048576) + " MB（" + cfg.name + "，之后会缓存，仅首次）…", "info");
                }
              },
            });
            break;
          } catch (e) {
            loadErrs.push(cfg.name + ": " + (e.message || e));
            _asr = null;
          }
        }
        if (!_asr) throw new Error(loadErrs.join("；"));
      }
    } catch (e) {
      setStatus("parseStatus", "❌ 加载转写引擎失败：" + e.message + "。重试一次；反复失败请改用 JotMe。", "warn");
      btn.disabled = false;
      return;
    }
    // 阶段 4：推理转写
    try {
      setStatus("parseStatus", "【4/4】正在本地转写（CPU 运算，" + Math.round(pcm.length / 16000 / 60) + " 分钟的音频约需 1~5 分钟，请勿关闭页面）…", "info");
      const out = await _asr(pcm, { language: "chinese", task: "transcribe", chunk_length_s: 30 });
      const text = (out && out.text) || "";
      if (!text) { setStatus("parseStatus", "本地转写未返回文字，可改用步骤 2 的「去 JotMe 转写」。", "warn"); return; }
      $("inpTranscript").value = text;
      setStatus("parseStatus", "✅ 本地 Whisper 转写完成（无需任何 Key），文字已回填到步骤 2。", "ok");
    } catch (e) {
      setStatus("parseStatus", "❌ 转写运算失败：" + e.message + "。可重试，或改用 JotMe。", "warn");
    }
    btn.disabled = false;
  }

  // 解码媒体为 16kHz 单声道 Float32（Whisper 所需）
  async function decodeToMono16k(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let audioBuf;
    try {
      audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      ctx.close().catch(() => {});
    }
    const chs = audioBuf.numberOfChannels;
    let mono;
    if (chs > 1) {
      mono = new Float32Array(audioBuf.length);
      for (let c = 0; c < chs; c++) {
        const d = audioBuf.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += d[i] / chs;
      }
    } else {
      mono = audioBuf.getChannelData(0);
    }
    const targetRate = 16000;
    const ratio = audioBuf.sampleRate / targetRate;
    const newLen = Math.max(1, Math.floor(mono.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) out[i] = mono[Math.floor(i * ratio)] || 0;
    return out;
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

  async function callLLM(provider, apiKey, transcript, style, modelOverride) {
    let endpoint, model;
    if (provider === "deepseek") {
      endpoint = "https://api.deepseek.com/chat/completions";
      model = "deepseek-chat";
    } else if (provider === "openrouter") {
      endpoint = "https://openrouter.ai/api/v1/chat/completions";
      model = modelOverride || ($("selOrModel") && $("selOrModel").value) || "google/gemma-4-31b-it:free";
    } else {
      endpoint = "https://api.openai.com/v1/chat/completions";
      model = "gpt-4o-mini";
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = location.origin;
      headers["X-Title"] = "video2wechat";
    }
    const r = await fetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_BASE },
          { role: "user", content: buildUserPrompt(transcript, style) },
        ],
        temperature: 0.7,
        response_format: provider === "deepseek" ? { type: "json_object" } : undefined,
      }),
    });
    clearTimeout(t);
    if (!r.ok) {
      const err = await r.text();
      let hint = "";
      if (r.status === 401) hint = "｜Key 无效：请检查是否复制完整（sk- 开头），或到平台重新生成一个 Key";
      if (r.status === 402) hint = "｜余额不足：该平台需充值后才能调用";
      if (r.status === 429) hint = "｜限流：免费模型有频率限制，稍等几十秒再试";
      throw new Error("API " + r.status + "：" + err.slice(0, 160) + hint);
    }
    const j = await r.json();
    return j.choices[0].message.content;
  }

  // ---------- OpenRouter 浏览器直连（带 429 自动换模型；云端不可用时兜底） ----------
  async function directOpenRouter(apiKey, transcript, style) {
    const sel = $("selOrModel");
    const candidates = [];
    if (sel) {
      const chosen = sel.value;
      candidates.push(chosen);
      for (const o of sel.options) {
        if (candidates.length >= 6) break;
        if (o.value !== chosen && o.value.endsWith(":free")) candidates.push(o.value);
      }
    } else {
      candidates.push("google/gemma-4-31b-it:free");
    }
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      // 每个候选模型遇 429 自动重试（上游高峰短暂拥堵，稍等即好），换下一个前先本模型重试 3 次
      for (let attempt = 0; attempt < 3; attempt++) {
        setStatus("rewriteStatus", "正在调用 OpenRouter 改写（" + m.replace(":free", "") + "，第 " + (i + 1) + "/" + candidates.length + " 个候选" + (attempt ? "，限流重试 " + attempt + "/2" : "") + "）…", "info");
        try {
          const raw = await callLLM("openrouter", apiKey, transcript, style, m);
          return raw;
        } catch (e) {
          lastErr = e;
          if ((e.message || "").indexOf("429") !== -1) {
            if (attempt < 2) { await new Promise((r) => setTimeout(r, 3500)); continue; } // 等 3.5s 再试同一模型
            break; // 同一模型 3 次都限流 → 换下一个候选
          }
          throw e; // 其他错误（Key 无效等）直接报
        }
      }
    }
    throw lastErr || new Error("所有免费候选模型均限流，过 1~2 分钟再点一次即可（已自动换模型+退避重试）");
  }

  // ---------- OpenRouter 免费模型列表（启动时拉取，失败用内置兜底） ----------
  const OR_FALLBACK_MODELS = [
    "google/gemma-4-31b-it:free",
    "minimax/minimax-m3.1-flash:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
  ];
  async function loadOrModels() {
    const sel = $("selOrModel");
    if (!sel) return;
    let ids = OR_FALLBACK_MODELS;
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      if (r.ok) {
        const j = await r.json();
        const free = (j.data || []).map((m) => m.id).filter((id) => id.endsWith(":free"));
        if (free.length) {
          // 优先保留内置推荐的中文友好模型
          ids = [...OR_FALLBACK_MODELS.filter((m) => free.includes(m)), ...free.filter((m) => !OR_FALLBACK_MODELS.includes(m))];
        }
      }
    } catch (e) { /* 拉取失败 → 用兜底列表 */ }
    sel.innerHTML = "";
    ids.forEach((id) => {
      const o = document.createElement("option");
      o.value = id; o.textContent = id.replace(":free", "（免费）");
      sel.appendChild(o);
    });
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
    // Key 按提供商分开存，避免切换模型时互相覆盖
    let apiKey = ($("inpKey").value || "").trim();
    const keyLSKey = "v2w_key_" + provider;
    if (!apiKey) {
      apiKey = (LS.getItem(keyLSKey) || "").trim();
      if (apiKey) $("inpKey").value = apiKey;
    }
    // OpenRouter 支持云端取 Key（Worker 服务端存储），允许本地无 Key；其他提供商必须有 Key
    if (!apiKey && provider !== "openrouter") { setStatus("rewriteStatus", "请填写 API Key（DeepSeek / OpenAI）", "warn"); return; }

    const styleText = $("selStyle").selectedOptions[0].text;
    $("btnRewrite").disabled = true;
    try {
      let raw;
      if (provider === "openrouter") {
        // Key 优先用用户粘贴的；没粘贴则从云端 Worker 运行时获取（密钥存服务端，不进公开代码）
        if (!apiKey) {
          const wbase = getWorkerBase();
          if (wbase) {
            setStatus("rewriteStatus", "正在从云端获取 OpenRouter Key（无需粘贴）…", "info");
            try {
              const kr = await fetch(wbase + "/api/or-key");
              const kj = await kr.json().catch(() => ({}));
              if (kj && kj.key) apiKey = kj.key;
            } catch (e) { /* 忽略，走下面提示 */ }
          }
        }
        if (!apiKey) { setStatus("rewriteStatus", "未获取到 OpenRouter Key：请在步骤3粘贴 Key，或确认 Worker 已部署。", "warn"); return; }
        // 浏览器直连 OpenRouter（不受 Worker 执行时长限制，慢模型也能跑；429 自动换免费模型）
        raw = await directOpenRouter(apiKey, transcript, style);
      } else {
        if (!apiKey) { setStatus("rewriteStatus", "请填写 API Key（DeepSeek / OpenAI）", "warn"); return; }
        raw = await callLLM(provider, apiKey, transcript, style);
      }
      const out = parseModelOutput(raw);
      $("inpArticle").value = out.html;
      if (out.title) $("inpTitle").value = out.title;
      LS.setItem(keyLSKey, apiKey);
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

    const wbase = getWorkerBase();
    if (!userConfiguredWorker()) {
      // 兜底：复制 + 开后台（默认 Worker 未配微信密钥，推送走手动）
      return manualPush(html, title);
    }
    setStatus("pushStatus", "正在通过 Worker 推送到草稿箱…", "info");
    $("btnPush").disabled = true;
    try {
      const cover = await getCoverDataUrl();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(wbase + "/api/wechat/draft", {
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
    // 清空已存盘的步骤内容（避免下次打开又恢复出来）
    ["v2w_transcript","v2w_article","v2w_title"].forEach((k) => LS.removeItem(k));
  }

  // ---------- 步骤内容自动存盘（刷新/误关不丢进度） ----------
  function saveWork() {
    if (($("inpTranscript").value || "").trim()) LS.setItem("v2w_transcript", $("inpTranscript").value);
    if (($("inpArticle").value || "").trim()) LS.setItem("v2w_article", $("inpArticle").value);
    if (($("inpTitle").value || "").trim()) LS.setItem("v2w_title", $("inpTitle").value);
  }
  function restoreWork() {
    const t = LS.getItem("v2w_transcript"); if (t) { $("inpTranscript").value = t; }
    const a = LS.getItem("v2w_article"); if (a) { $("inpArticle").value = a; renderPreview(); }
    const ti = LS.getItem("v2w_title"); if (ti) { $("inpTitle").value = ti; }
  }

  function handleRerun(kind) {
    if (kind === "parse") doParse();
    else if (kind === "transcribe") openJotMe();
    else if (kind === "rewrite") doRewrite();
    else if (kind === "push") doPush();
  }

  // ---------- 配置弹窗 ----------
  function openSettings() { $("cfgWorker").value = LS.getItem("v2w_worker") || DEFAULT_WORKER; $("settingsModal").classList.remove("hidden"); }
  function saveSettings() {
    const v = ($("cfgWorker").value || "").trim();
    if (v) LS.setItem("v2w_worker", v); else LS.removeItem("v2w_worker");
    $("settingsModal").classList.add("hidden");
  }

  // ---------- 事件绑定 ----------
  document.addEventListener("DOMContentLoaded", function () {
    $("btnParse").addEventListener("click", doParse);
    $("btnOpenParser").addEventListener("click", () => openParserTool("https://parsedock.kitt.tools/douyin"));
    $("btnJotMe").addEventListener("click", openJotMe);
    $("btnAutoTranscribe").addEventListener("click", doAutoTranscribe);
    $("btnUseTranscript").addEventListener("click", () => setStatus("transcriptStatus", "✅ 已采用，可到步骤 3 改写", "ok"));
    $("btnRewrite").addEventListener("click", doRewrite);
    $("inpArticle").addEventListener("input", renderPreview);
    $("inpTitle").addEventListener("input", renderPreview);
    // 步骤内容自动存盘：任一输入框变化即保存，刷新/误关不丢
    ["inpTranscript","inpArticle","inpTitle"].forEach((id) => $(id).addEventListener("input", saveWork));
    $("btnPush").addEventListener("click", doPush);
    $("btnManual").addEventListener("click", () => manualPush($("inpArticle").value, $("inpTitle").value));
    $("btnClearAll").addEventListener("click", clearAll);
    document.querySelectorAll(".btn.rerun").forEach(b => b.addEventListener("click", () => handleRerun(b.dataset.rerun)));
    $("btnSettings").addEventListener("click", openSettings);
    $("btnSaveCfg").addEventListener("click", saveSettings);
    $("btnCloseCfg").addEventListener("click", () => $("settingsModal").classList.add("hidden"));

    // 预填本地保存的 key（按提供商分开）
    function syncKeyField() {
      const p = $("selProvider").value;
      const k = LS.getItem("v2w_key_" + p) || "";
      $("inpKey").value = k;
      $("inpKey").placeholder = p === "openrouter" ? "sk-or-v1-...（OpenRouter Key）" : (p === "deepseek" ? "sk-...（DeepSeek Key）" : "sk-...（OpenAI Key）");
      const orWrap = $("orModelWrap");
      if (orWrap) orWrap.classList.toggle("hidden", p !== "openrouter");
    }
    $("selProvider").addEventListener("change", syncKeyField);
    loadOrModels();
    syncKeyField();
    restoreWork(); // 恢复上次自动存盘的步骤内容（刷新/误关不丢）
    renderPreview();

    console.log("[v2w] 工作台已就绪。Worker 地址：" + (getWorkerBase() || "（未配置，将用手动兜底）"));
  });
})();
