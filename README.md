# 视频 → 公众号 一键成文工作台

把抖音视频变成一篇可发布的公众号文章：**抖音解析 → JotMe 转写 → DeepSeek/GPT 改写 → 直推草稿箱**。
纯静态网页 + 一个免费 Cloudflare Worker，**零费用、不装本地软件、不依赖 WorkBuddy / 言序**。

---

## 一、它能做什么（全流程）

| 步骤 | 动作 | 实现方式 | 费用 |
|---|---|---|---|
| 1 输入/解析 | 粘贴抖音链接拿媒体直链 | 浏览器直连多个免费解析网关（带兜底） | 免费 |
| 2 转写 | 视频/音频 → 文字 | 跳转 JotMe 网页，手动粘贴回来（JotMe 无 API） | 免费额度 |
| 3 改写 | 深度改写 AI 模型/工具类内容 | 浏览器直连 DeepSeek / OpenAI（Key 存本地） | 自带免费额度 |
| 4 推送 | 进公众号草稿箱 | 免费 Worker 桥接微信 `draft/add`；未配 Worker 则复制+开后台手动 | 免费 |

每个外部环节都做了**降级/兜底**，避免单点失效导致停摆：
- 解析：aa1.cn（主，已验证可前端直连）→ vvhan → pearktrue → eryou；全挂则提示「上传文件」或「手动下载」。
- 推送：配了 Worker 一键直推；没配则「复制 HTML + 打开 mp.weixin.qq.com 手动粘贴存草稿」。
- 每步都有「↻ 重跑」按钮；顶部「🗑 清空全部」一键复位。

---

## 二、部署（两条线，都是免费）

### A. 前端静态站（GitHub Pages）
1. 把本目录（`index.html` / `style.css` / `app.js`）推到 GitHub 仓库。
2. 仓库 Settings → Pages → Source 选 `main` 分支根目录 → Save。
3. 几分钟后得到 `https://<你的用户名>.github.io/<仓库名>/`，浏览器打开即用。

### B. 推送桥接 Worker（Cloudflare，可选但推荐）
不配也能用（走手动兜底），配了才有一键直推。
1. 安装 `npm i -g wrangler` 并 `wrangler login`。
2. 在该目录执行：
   ```
   wrangler secret put WECHAT_APPID    # 输入公众号 AppID
   wrangler secret put WECHAT_SECRET   # 输入 AppSecret
   wrangler deploy
   ```
3. 部署后得到 `https://<子域>.workers.dev/api/wechat/draft`。
4. 打开网页 → 右上「⚙ 配置」→ 填入上面的 Worker 地址 → 保存。

> Worker 用环境变量保管密钥、固定出口 IP（解决微信 `40164 invalid ip`）、并加 CORS 头让 GitHub Pages 能直接 `POST`。

---

## 三、使用步骤
1. **步骤 1**：粘贴抖音分享链接 → 「🔗 解析」。成功会给出媒体直链（可下载后丢给 JotMe）；若解析源全挂，直接「上传媒体文件」。
2. **步骤 2**：点「🎙 去 JotMe 转写 ↗」→ 在 JotMe 网页上传视频/音频 → 复制文字 → 粘回本页文本框。
3. **步骤 3**：选模型（DeepSeek / OpenAI）、文风（专业干货 / 轻松口语 / 故事种草），填 API Key（仅存浏览器本地）→ 「✨ 开始改写」。结果可手动微调。
4. **步骤 4**：预览成稿；可上传封面（不上传则用自动生成的渐变封面）→ 「🚀 推送到草稿箱」（已配 Worker）或「📋 复制+开后台手动存」。

---

## 四、前置条件 / 注意
- **公众号资质**：微信 `draft/add` 要求**已认证的订阅号/服务号** + AppID + AppSecret + IP 白名单。个人未认证号在 2025-07 后已被收回权限（会报 `48001`）。用 Worker 后白名单只需填 Worker 固定出口 IP（Cloudflare 提供），比自己服务器省心。
- **JotMe 无 API**：故转写采用「跳转网页 + 粘贴返回」，已实测其独立网页可用、可复制文本、有免费额度。
- **改写模型 CORS**：已实测 DeepSeek 与 OpenAI 均返回 CORS 头，浏览器可直连；用你自己的 Key。
- **解析源稳定性**：抖音持续封杀第三方解析，免费网关可能随时失效；本工具多源+兜底，但仍建议关键内容走「手动上传」最稳。

---

## 五、文件结构
```
index.html      # 主页面（四步流程 + 配置弹窗）
style.css       # 样式
app.js          # 全流程前端逻辑（解析降级 / JotMe 跳转 / 改写 / 封面生成 / 推送）
worker.js       # Cloudflare Worker：桥接微信草稿箱
wrangler.toml   # Worker 部署配置
README.md       # 本文件
```

## 六、常见问题
- **解析一直失败？** 免费网关多半又被抖音封了。直接「上传文件」或在 JotMe 那条链路里手动处理，不影响后续。
- **推送到草稿箱报 40164？** 说明 Worker 出口 IP 不在公众号白名单。Cloudflare Workers 有固定 IP 段，把对应 IP 加进公众号「IP 白名单」即可（或在微信后台把调用放开）。
- **不想暴露任何密钥？** 不配 Worker，全程用「复制+开后台手动存」，零服务器、零密钥泄露。
- **Key 安全？** API Key 只存在你浏览器 localStorage，不上传任何服务器；Worker 的微信密钥存在 Cloudflare Secret，不进代码仓库。
