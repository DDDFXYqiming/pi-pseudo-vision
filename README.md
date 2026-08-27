简体中文 | [English](README.en.md)

# pi-pseudo-vision

> 给 **Pi Coding Agent** 的 text-only provider 装上"工具层视觉"：把图片在 LLM dispatch 路径上自动拆解成 OCR 文字 + 颜色统计 + 像素扫描 + 元信息，让任意纯文本模型也能"看图"。全程本机执行，**无外部视觉 API**。

**Pi 适配版**。从同作者的 [dsh-pseudo-vision](https://github.com/DDDFXYqiming/dsh-pseudo-vision)（DeepSeek Harness 插件）移植，**保留全部 vision 算法**（颜色统计 / 元信息 / 像素扫描 / OCR + 数字复核通道 + 分块 OCR），入口改成 Pi 扩展规范。

## 它在做什么

- 注册 4 个 `vision_*` 工具（OCR / 颜色统计 / 像素扫描 / 元信息）给 LLM 直接调用，并加一个 `pseudo_vision_convert` 工具做一键汇总
- 注册 `/pseudo-vision` 命令：`on` / `off` / `status` / `<path>` 四种用法（手动转换本地图片）
- 可选的 `context` 事件钩子：自动把 user message 里的 `ImageContent` 块替换为本地 vision observation 文本，仅当：
  - `/pseudo-vision on` 已开启 **或** `bridgeProviders` 配置中包含当前 provider，**且**
  - 当前 model 声明 `input: ["text"]`（**原生视觉模型完全不动**）

## 提供的工具

| 工具 | 作用 | 实现 |
|---|---|---|
| `vision_ocr` | 提取图中所有文字（带归一化坐标），含数字复核通道（IP/URL/端口/长数字的 `0↔6/9/8` 字形重识别 + 标点保持融合） | tesseract.js（chi_sim + eng） |
| `vision_color_stats` | 9 桶（白/黑/灰/红/绿/蓝/黄/青/品红/其他）像素占比 + 平均亮度 | sharp + 直方图 |
| `vision_pixel_scan` | 行 + 列多色桶扫描；`mode=target` 找指定颜色（默认红 `#ff0000`），`mode=universal` 共享 512px 降采样输出全部非背景桶；每桶最多 5 行 + 5 列 | sharp raw pixel |
| `vision_meta` | 尺寸、格式、色彩空间、四角/中心采样 | sharp metadata |
| `pseudo_vision_convert` | 把 4 个工具串成单一 `<pseudo-vision-context>` 证据块（与 auto-bridge 路径同源） | sharp + tesseract.js |

### OCR 管线（v5，与 dsh-pseudo-vision 同步）

1. **预处理**：预算缩放（small/normal/large/mega，28 网格吸附）→ 深色模式检测（浅色不反色）→ 灰度 → 对比度拉伸 → 椒盐噪声检测（有噪才 3×3 中值降噪，干净图跳过，避免磨掉 1px 细笔画）→ 轻锐化（σ0.3）→ 白边
2. **主识别**：tesseract 整页，输出全部文字行 + 置信度；非文本块（image/separator）过滤
3. **低置信度重试**：最多 8 个区域，**文字行优先**（图标噪声行不抢占名额）；裁剪 + 3× Lanczos 放大 + 单文本块模式（PSM 6）重读；**置信度更高时替换主行**（证据块仍留痕）
4. **CJK 后处理**：字间空格合并（`通 知`→`通知`）、行首图标符号剥离
5. **数字复核**：IP/URL/端口/长数字用 ASCII 白名单 + 单行模式重识别，标点保持首遍骨架，同长度 + 置信提升 ≥5 才接受，`[数字复核 N 处]` 留痕

> 实机验证：设置页截图 OCR 从"只出顶部 3 行、菜单文字全丢"修复为 11 行全检出、"通用设置/模型/通知"完全干净。关键修复：tesseract.js 的 PSM 参数必须传数字（字符串 `"3"` 会破坏整页检测）。

## 安装

```bash
# GitHub 安装（推荐）
pi install git:github.com:DDDFXYqiming/pi-pseudo-vision

# Windows schannel / npm 拦截时改用本地路径
git clone https://github.com/DDDFXYqiming/pi-pseudo-vision.git
cd pi-pseudo-vision && npm install
pi install <本机绝对路径>
```

`npm install` 装上 `sharp` + `tesseract.js` 后扩展直接可用，**无需构建步骤**——pi 用 jiti 直接跑 TypeScript 源码。

## 使用

装上即生效，4 个 `vision_*` 工具和 `pseudo_vision_convert` 立即可被 LLM 调用。`/pseudo-vision` 命令切换会话级 auto-bridge：

```
/pseudo-vision              # 等同 status：打印当前状态
/pseudo-vision on           # 当前会话开启 auto-bridge
/pseudo-vision off          # 当前会话关闭 auto-bridge
/pseudo-vision <path>       # 一次性：把本地图片转成 vision observation 注入为 follow-up 消息
```

**Auto-bridge 默认对所有 provider 关闭**——避免你吐槽的"原生视觉模型也被强制改走伪视觉"。要桥接某个 text-only provider 时，显式配 `bridgeProviders` 白名单：

```json
{
  "extensions": ["..."],
  "pi-pseudo-vision": {
    "bridgeProviders": ["kimi-for-coding"],
    "ocrBudget": "auto",
    "ocrNoResize": false,
    "maxImages": 8,
    "langs": "chi_sim+eng",
    "cacheDir": ""
  }
}
```

或会话内一次性开启：`/pseudo-vision on`（仅对**当前会话**生效）。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `bridgeProviders` | `[]` | 白名单 provider 列表（空 = 默认**不**自动桥接） |
| `bypassCache` | `false` | `true` = 强制重算，跳过磁盘缓存 |
| `maxImages` | `8` | 单请求最多转换张数 |
| `langs` | `chi_sim+eng` | tesseract 语言包 |
| `ocrBudget` | `auto` | `auto` / `small` / `normal` / `large` / `mega` |
| `ocrNoResize` | `false` | `true` = 跳过 OCR 预算缩放/放大，但保留灰度/对比度/锐化/白边 |
| `cacheDir` | `~/.pi/agent/cache/pi-pseudo-vision` | OCR 结果缓存目录 |

`auto` 适合默认使用；密集表格 / 细小字体选 `large` / `mega`；想限制本地 CPU/内存选 `small`。`ocrNoResize: true` 跳过预算缩放但仍执行灰度/对比度/锐化/白边增强；颜色统计/像素扫描/元信息始终基于原图。

## 效果示例

`kimi-for-coding/kimi-k2-thinking`（纯文本）+ read_image 截图，模型收到的伪视觉证据：

```
[pi-pseudo-vision] sha256=b290f3d7e212 budget=normal 原图:image/png 187415B 预处理:灰度+反色 1196×636 238744B
[OCR chi_sim+eng] 12 行
  · "dsh web: http://127.0.0.1:3080"  x=0.128 y=0.230
  · "dsh web: opening the default browser; pass --no-open to disable"  x=0.251 y=0.262
  · …
[数字复核 2 处]
  · y=0.230 "http://127.6.6.1:3080" → "http://127.0.0.1:3080"（置信度 34→66）
  · y=0.413 "http://127.9.6.1:3689" → "http://127.0.0.1:3080"（置信度 38→85）
[颜色统计] 总像素 760896  · 平均亮度 57.5/255  · grey 94.3%  · white 4.9%
[像素扫描] 476×512 背景豁免:grey 27 条命中（行 14 / 列 13）
  · 行 y=0.0%  white  99.8%  · 列 x=0.2%  white  71.4%  · …
[元信息] 尺寸 1184×608  png  sRGB
  · [TL] #282c34 (深灰)  · [C] #282c34 (深灰)  · …
```

模型基于以上结构化证据"脑补"出整图内容——`[数字复核]` 块记录了原 OCR 误读与纠正前后，证据完全可审计。

## 权限

- 读取 conversation history 里的图片附件（base64 解码到内存）
- 写入缓存文件到 `~/.pi/agent/cache/pi-pseudo-vision/`（键含 sha256、budget、langs/resize 开关、OCR 管线参数版本、扫描版本）
- 进程内 tesseract.js OCR + sharp（首次运行从 tesseract CDN 下载语言包，之后离线）
- `context` 事件钩子在受控条件下改写 outgoing message context（非破坏性）

**不会**：上传图片到任何外部 API / 修改 Pi 核心代码 / 覆盖任何内置工具 / 改变原生视觉模型的路由。

## 已知边界

- 复杂空间关系 / 真实照片：描述精度有限，伪视觉证据 ≠ 真多模态理解
- OCR 仍可能认错非数字 token；数字关键 token（IP/URL/端口/长数字）已由复核通道兜底
- 颜色统计只给占比，无法还原布局/图标细节
- 大图：OCR 按 `ocrBudget` 预算处理；超长截图（高 > 3000px）会先切块
- 低置信度复核最多 3 个区域，提升小字可读性但不等同于图像超分辨率
- **明确不做**：embedding / 外部 Vision API（违背"无模型"红线）/ 自动切换到伪视觉路径（必须显式开启，避免污染原生视觉模型）/ npm 发布（仍走 `pi install`）

完整更新历史见 [CHANGELOG.md](./CHANGELOG.md)（待补）。关联项目：[dsh-pseudo-vision](https://github.com/DDDFXYqiming/dsh-pseudo-vision)（DeepSeek Harness 同源）；架构参考 [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision)（外部 API 路线）。

## License

MIT