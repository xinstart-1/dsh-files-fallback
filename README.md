# dsh-files-fallback

<p align="right"><a href="#english">English</a> | 中文</p>

<div align="center">

![Node.js](https://img.shields.io/badge/node-%3E%3D18-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

**文件引用与附件插件 for [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) Web GUI**

拖拽 / `Ctrl+V` 粘贴 / 📎 按钮上传 · `@绝对路径` 引用 · 桌面端兜底引用（目录、超大文件、失败不落空）· 内联缩略图 · VLM 图片识别

</div>

> **File reference & attachment plugin for DSH web GUI:** drag, paste, or upload files and images; desktop entries that cannot be uploaded (folders, oversized files, unlisted types, failed transfers) gracefully fall back to `@path` references with zero copy and no size limit.

> 🧭 **来源说明**：本插件基于 [dsh-file-attachment](https://github.com/wszhoho/dsh-file-attachment)（MIT License）二次开发，感谢原作者 [@wszhoho](https://github.com/wszhoho)。在原落盘管线之上新增桌面端 `@路径` 兜底引用等能力，并由本项目独立维护与迭代。

## 目录

- [亮点](#亮点)
- [快速开始](#快速开始)
- [核心能力](#核心能力)
- [处理流程](#处理流程)
- [界面](#界面)
- [行为一览](#行为一览)
- [与原插件的差异](#与原插件的差异)
- [存储细节](#存储细节)
- [安装](#安装)
- [架构](#架构)
- [开发说明](#开发说明)
- [English](#english)
- [License](#license)

## 亮点

**桌面端 `@路径` 兜底引用**：在 DSH 桌面壳里，本插件可以通过 Electron `webUtils` 拿到拖入文件的**真实操作系统路径**。于是凡是「不适合走浏览器上传」的条目——文件夹、超过 50MB 的大文件、空文件、类型不在允许列表、乃至上传中途失败——都不再弹失败提示，而是自动在草稿光标处插入 `@绝对路径` 引用 chip：

- **零拷贝**：文件不读取、不上传、不落盘，直接引用原位置；
- **无大小上限**：几个 GB 的数据集目录、日志文件照样引用；
- **文本模型可用**：agent 收到 `@路径` 后可自行按需读取，浏览器半与桌面半行为统一。

## 快速开始

```powershell
dsh plugin --profile web add ./dsh-files-fallback
```

安装后重启 web GUI 即生效。

## 核心能力

| 能力 | 说明 |
| :--- | :--- |
| 🔗 **桌面端兜底引用** | 桌面壳内拿到真实 OS 路径：目录 / 超 50MB / 空文件 / 未放行类型 / 上传失败，一律自动转为 `@路径` 引用插入草稿，零拷贝、无大小限制 |
| 📥 **三种入口** | 拖入、`Ctrl+V` 粘贴、接管 dsh 原生 📎 附件按钮（加号右侧、modes 左侧，可多选）；PC 与移动端浏览器均适用 |
| 🗂️ **统一落盘管线** | 图片与文档同走一条链路，平铺保存到 `<会话工作区>/.dsh-file-attachment/<文件名>`；同名冲突追加 `-N` 绝不覆盖；同名同大小自动去重复用；单文件上限 50MB |
| 🔖 **`@绝对路径` 引用** | 落盘后在光标处插入 chip，文本模型也能「看懂」附件 |
| 🖼️ **双区预览** | 输入框内联附件条（图片缩略图 / 文档类型图标 + 文件名，可移除并同步清除引用）；聊天区图片渲染为可点击放大的缩略图（Lightbox） |
| 🤖 **VLM 识别** | 非多模态模型下自动调用 OpenAI 兼容接口生成中文图片描述回填草稿（仅注入模型上下文）；agent 可主动调用 `describe_image` 工具 |

## 处理流程

```mermaid
flowchart LR
    A["📥 拖入 / 粘贴 / 📎 选择"] --> B{"文件校验<br/>类型 · 大小 ≤50MB"}
    B -- "通过" --> C["读全文 → base64 → Host 落盘"]
    C --> D[(".dsh-file-attachment/文件名<br/>同名追加 -N")]
    D --> E["光标处插入 @绝对路径 chip"]
    B -- "不通过 / 上传失败" --> F{"桌面端拿到真实路径？"}
    F -- "是" --> G["自动插入 @路径 引用<br/>零拷贝 · 无大小限制"]
    F -- "否（纯浏览器）" --> X["跳过并 toast 提示"]
    E --> H{"模型支持多模态？"}
    G --> H
    H -- "否 · 已配 VLM" --> I["VLM 生成中文描述<br/>仅注入模型上下文"]
    H -- "是 / 未配 VLM" --> J["随消息正常发送"]
```

## 界面

**演示**：拖入/粘贴 → 落盘并插入 `@` 引用 → 输入框内联附件条待发送状态；桌面端拖入目录或超大文件时直接插入 `@路径` 引用。

**设置页**（「设置 → 文件附件」）：

| 设置组 | 内容 |
| :--- | :--- |
| **可上传类型** | 按文档 / 代码 / 配置文件三类增删扩展名（小写不带点，图片恒可发送） |
| **VLM 参数** | Base URL / API Key / 模型 / 思考模式开关（默认禁用）/ 超时时间（默认 60 秒）；未填 API Key 时静默跳过 |

## 行为一览

| 操作 | 行为 |
| --- | --- |
| 📎 按钮多选 / 拖入 / 粘贴文档、代码、配置文件 | 读全文 → base64 → 落盘 → 光标一次性插入全部 `@` 引用；成功不提示，失败简短 toast |
| 一次多个文件 | 批量处理，一次性插入全部引用；部分失败仅提示「N 个已跳过」 |
| 拖入 / 粘贴图片 | 同一管线落盘 + 插引用；附件条缩略图预览，聊天区可点击放大 |
| 拖入目录 | 桌面端（可取真实路径）：自动插入 `@路径` 引用；纯浏览器：toast 提示「不支持拖入目录」 |
| 单文件 > 50MB | 桌面端：自动 `@路径` 引用（零拷贝、不受限制）；纯浏览器：跳过并提示 |
| 类型不在允许列表 | 桌面端：自动 `@路径` 引用；纯浏览器：跳过并 toast 提示 |
| 单条目上传失败 | 桌面端可取真实路径时自动转为 `@路径` 引用，否则提示「文件处理失败」 |
| 当前模型不支持多模态 | 自动调 VLM 生成中文描述回填草稿；agent 可用 `describe_image` 工具 |
| 粘贴纯文本 | 不改写，完全原生行为 |
| 重复拖入同名文件（同一天内） | 追加 `-1`、`-2` 序号，绝不覆盖 |
| 点附件条 `×` 移除 | 移除条目并清除该文件路径的全部 `@` 引用 chip，其他文件不受影响 |

## 与原插件的差异

| 行为 | dsh-file-attachment（原版） | dsh-files-fallback（本插件） |
| :--- | :--- | :--- |
| 拖入目录 | 拒绝 + toast | 桌面端自动转为 `@路径` 引用 |
| 单文件 > 50MB | 跳过 + toast | 桌面端自动转为 `@路径` 引用（零拷贝） |
| 类型未放行 / 空文件 | 跳过 + toast | 桌面端自动转为 `@路径` 引用 |
| 上传失败 | 提示「文件处理失败」 | 能取真实路径即自动转为 `@路径` 引用 |
| 标识符 | `@wszhoho/dsh-file-attachment` | `dsh-files-fallback`（包名 / patch id / 模块 id） |
| 落盘目录与配置 | `.dsh-file-attachment/`、`~/.dsh/file-attachment.json` | 保持一致，现有数据与设置无缝兼容 |

## 存储细节

- **命名**：`.dsh-file-attachment/<清洗后文件名>`（如 `.dsh-file-attachment/说明.docx`），同名在扩展名前追加 `-N`。
- **去重**：上传前先查重（键 = 文件名 + 文件大小，元数据级判定），命中直接复用已有文件路径、零字节上传；`.dsh-file-attachment/.index.json` 为去重索引（自动维护，删除后自动重建）。
- **根目录** = 当前会话工作区（回退顺序：`session.header.cwd` → `sandboxPolicy.workspaceRoot` → `process.cwd()`），每个项目各自维护自己的 `.dsh-file-attachment/`。
- **跨平台**：保存路径用 `path.join` 自适应分隔符；文件名清洗对 Windows / POSIX 均安全；Host 半经 `node:fs/promises` 直接写字节，无 shell 依赖。

## 安装

本仓库是标准 dsh 插件包（声明了 `dsh.bundle.patch`）。`dsh plugin add` 的参数会转发给 profile 目录的 pnpm 执行：

```powershell
# 本地源码安装（相对路径等价 pnpm link，改完 lib/*.js 后重启 GUI 即生效）
dsh plugin --profile web add ./dsh-files-fallback

# 从 GitHub 安装
dsh plugin --profile web add github:xinstart-1/dsh-files-fallback
```

无论哪种来源，安装后都自动进入 profile 的 `dsh.profile.bundles`，无需手改 profile `package.json`；升级：`dsh plugin --profile web update dsh-files-fallback`。

## 架构

```
├── package.json          # dsh.client 声明 + bundle patch 指向
├── cordis.patch.yml      # bundle 补丁：插入本插件行
└── lib/
    ├── index.js          # Host 半：webServer 路由（/save /config /describe）+ describe_image 工具
    └── client.js         # Client 半：document 级 capture drop/paste 监听 + 📎 按钮接管 + @路径 兜底 + 槽组件
```

```mermaid
flowchart TB
    subgraph client["Client 半 · lib/client.js"]
        C1["capture 阶段拦截<br/>drop / paste / 📎 fileInput"]
        C2["shadow 内联附件条<br/>conversation.input.attachments"]
        C3["shadow 用户消息渲染器<br/>聊天区图片缩略图"]
        C4["shell.overlay 浮动 toast"]
    end
    subgraph host["Host 半 · lib/index.js"]
        H1["POST /save<br/>base64 → node:fs/promises 写盘"]
        H2["GET/POST /config<br/>可上传类型 · VLM 配置"]
        H3["POST /describe"]
        H4["tools.register<br/>describe_image"]
    end
    VLM[("OpenAI 兼容 VLM")]
    C1 -- "文件 base64" --> H1
    C2 -.-> H2
    C1 -.-> C4
    H3 --> VLM
    H4 --> VLM
    C3 -- "GET /api/file?path=" --> FS[(".dsh-file-attachment/ 落盘文件")]
    H1 --> FS
```

- **Host 半**：前缀路由 `/dsh-file-attachment`——POST `/save`（base64 解码后用 `node:fs/promises` 写盘）、GET/POST `/config`（读写可上传类型与 VLM 配置）、POST `/describe`（调 VLM 返回中文描述与思考模式配置）；另经 `tools.register` 注册 `describe_image` 工具。响应信封 `{ ok, value | error }`。
- **Client 半**：shadow 原生附件条（`conversation.input.attachments`）实现内联附件条；shadow 用户消息渲染器（`conversation.chat.node` keyed `user`）把聊天区 `@图片路径` 渲染为缩略图（经宿主 `/api/file?path=` 读取落盘图片）；capture 阶段拦截原生 `fileInput` change 事件接管 📎 按钮，文件进入插件统一管线；`window.__DSH_HOST_PATHS__.pathFor`（Electron `webUtils`）可取到真实路径时启用 `@路径` 兜底引用；纯文本粘贴完全原生不改写。
- **通知与浮层**：`shell.overlay` frame-wide 浮动 toast（不参与文档流，4 秒自动消失）；拖入任何文件时 capture 阶段拦截应用自带的图片 DropOverlay（其文案对文档是误导）。

## 开发说明

- `lib/*.js`、`package.json`、`cordis.patch.yml`、`README.md` 均为 UTF-8 无 BOM，编辑时保持原编码。
- 纯 ESM 无构建，不依赖装饰器 / 远程反射。
- 兜底引用逻辑在 `lib/client.js` 内以 `[patch/ref]` 注释标记，便于后续对照上游版本做 rebase。
- VLM 请求发送 `thinking: { type: "enabled"|"disabled" }`（部分兼容 API 忽略扁平 `thinkingType`；默认开启深度思考的模型识别极慢，关闭后明显提速）；超时后明确报错中止而非挂死会话；未填 API Key 时识别静默跳过，不影响落盘。
- 50MB 上限两侧一致（client 跳过 + host 校验）。

## English

**dsh-files-fallback** is a [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) web GUI plugin for attaching files and images to the chat composer via drag-and-drop, paste, or the native DSH paperclip button.

Key capabilities: unified storage pipeline under `.dsh-file-attachment/`; `@absolute-path` references so text-only models can use attachments; a desktop-only **path-reference fallback** — folders, oversized files, unlisted types, and failed uploads are automatically converted into `@path` references (zero copy, no size limit) instead of error toasts; inline attachment previews plus clickable chat thumbnails with a lightbox; multi-file upload with same-name conflict handling and a 50MB guard; optional OpenAI-compatible VLM descriptions for non-multimodal models; works on desktop and mobile browsers.

Install:

```powershell
dsh plugin --profile web add ./dsh-files-fallback
```

For detailed behavior, settings, architecture, and development notes, see the Chinese documentation above.

## License

MIT。本项目基于 [dsh-file-attachment](https://github.com/wszhoho/dsh-file-attachment)（MIT）二次开发，原版权声明保留于 [LICENSE](LICENSE)。
