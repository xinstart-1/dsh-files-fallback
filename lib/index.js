// dsh-files-fallback Host 半：webServer HTTP 路由方案。
// Client 半 POST /dsh-file-attachment/save：元数据（name/sessionId）走查询参数，
// 请求体即文件原始字节流，本端流式写盘（不经 JS 全量缓冲、无 base64 膨胀）。
// 写入 <会话工作区根>/.dsh-file-attachment/<文件名>（平铺，0.7.0 起不再按日期分子目录；文件名保留原始名）并返回 { path, dir, name, size }。
// 去重（0.7.0）：Client 上传前先 POST /precheck（name+size 键，元数据级去重），命中直接复用旧路径、零字节上传；
// /save 侧同名同大小做兜底后检。索引持久化在 <root>/.dsh-file-attachment/.index.json。
// 项目根解析：Client 传 sessionId → sessions.get(sessionId).header.cwd →
// sandboxPolicy.workspaceRoot → process.cwd()（三平台绝对路径，Node path.join 自适应分隔符）。
// 纯 ESM 无构建：不依赖 TypertRemoteService/装饰器，原生 Node 可直接加载。
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @deepseek-ai/dsh-tools 为 peerDependency：以 link: 方式安装（pnpm link 本地源码目录）时，
// 包的真实路径在源码目录，Node 的 ESM 解析无法到达应用内置的这些包，宿主会**静默跳过整个 bundle**。
// 因此改为顶层 await 可选加载：解析失败时插件其余功能（上传/引用/兜底/会话清理）全部照常工作，
// 仅 describe_image 工具降级不注册；用 github:/npm 方式安装（peer 由 pnpm 正常安装）时能力完整。
let defineTool = null
try { defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool } catch { /* 降级：跳过 describe_image 工具注册 */ }
/** 本包声明依赖的 Host 服务。 */
export const name = 'dsh-file-attachment'
export const inject = ['webServer', 'tools', 'agentDefaultModel', 'llm']

// 临时目录名：落在会话工作区根下；每个项目都能看到自己引用过的文档
const ATTACHMENT_DIR = '.dsh-file-attachment'
// 单文件上限 50MB（与 Client 半一致）
const MAX_BYTES = 50 * 1024 * 1024
// 文件名非法字符：路径分隔符、Windows 保留字符、控制字符
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/gu
// 配置持久化：用户级 ~/.dsh/file-attachment.json（存多模态识别参数与会话清理联动配置）
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'file-attachment.json')

// 多模态识别（VLM）默认参数：thinkingType/timeout 空值回退默认。
// baseURL/apiKey 留空 = 走 harness 自带模型（凭据由 harness 提供），填写 = 走该 OpenAI 兼容端点；
// model 可由设置页从 harness 模型目录下拉选取（provider + model），也兼容手填自定义模型名。
const VLM_DEFAULTS = {
  // 下面 baseURL/model 的默认值仅作设置页 placeholder 示例参考，不参与兜底
  baseURL: 'https://api.xiaomimimo.com/v1',
  apiKey: '',
  model: 'mimo-v2.5',
  provider: '',
  thinkingType: 'disabled',
  timeout: 60, // 识别超时（秒）。实测 VLM 延迟波动大（12~73s），30s 会误杀多数请求
}

/** VLM 未配置时的统一提示。 */
const VLM_CONFIG_ERROR = '请正确配置视觉模型（设置→文件附件选择模型；自定义端点还需填 Base URL 与 API Key）'

/**
 * 兜底 VLM 是否可用：
 * - 自定义端点模式：baseURL + apiKey + model 三项均非空；
 * - harness 模式：baseURL/apiKey 为空且 model 非空（route 交给 harness 的 llm）。
 */
function isVlmConfigured(vlm) {
  if (!vlm || typeof vlm.model !== 'string' || vlm.model === '') return false
  const customEndpoint = vlm.baseURL !== '' || vlm.apiKey !== ''
  if (!customEndpoint) return true
  return vlm.baseURL !== '' && vlm.apiKey !== ''
}

/** harness 模式判定：未填自定义端点，走 harness 自身 llm。 */
function isVlmHarnessMode(vlm) {
  return !!(vlm && vlm.baseURL === '' && vlm.apiKey === '')
}
/** 解析项目根：会话 cwd → sandboxPolicy.workspaceRoot → process.cwd()。 */
function projectRoot(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions !== undefined && typeof sessions.get === 'function' && typeof sessionId === 'string' && sessionId !== '') {
    try {
      const sess = sessions.get(sessionId)
      if (sess !== undefined && sess.header !== undefined && typeof sess.header.cwd === 'string' && sess.header.cwd !== '') {
        return sess.header.cwd
      }
    } catch (err) { /* 回退下一来源 */ }
  }
  if (typeof ctx.get === 'function') {
    const sp = ctx.get('sandboxPolicy')
    if (sp !== undefined && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') {
      return sp.workspaceRoot
    }
  }
  return process.cwd()
}

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 读取 JSON 请求体（带上限）。 */
async function readJsonBody(req, maxBytes) {
  let size = 0
  let data = ''
  const decoder = new TextDecoder('utf-8')
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) return null
    data += decoder.decode(buf, { stream: true })
  }
  data += decoder.decode()
  if (data === '') return null
  try {
    return JSON.parse(data)
  } catch (err) {
    return null
  }
}

/** 清洗文件名：只取 last segment、去非法字符、空名 → file。 */
function cleanName(raw) {
  let s = raw === undefined || raw === null ? '' : String(raw)
  while (s.length > 0) {
    const c = s.charCodeAt(s.length - 1)
    if (c === 47 || c === 92) s = s.slice(0, -1)
    else break
  }
  let seg = ''
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 47 || c === 92) { if (cur !== '') { seg = cur; cur = '' } }
    else cur += s.charAt(i)
  }
  if (cur !== '') seg = cur
  const safe = seg.replace(BAD_CHARS, '_').trim() || 'file'
  return safe
}

/** 规范化会话清理联动配置：仅接受 { enabled: boolean }；缺省/非法回退默认关闭。 */
function normalizeCleanup(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {}
  return { enabled: r.enabled === true }
}

/**
 * 规范化多模态识别参数（trim 去空白）。
 * baseURL/apiKey/provider/model 不回退默认（空即未配置，由 isVlmConfigured 拦截）；
 * thinkingType/timeout 空值回退默认。
 */
function normalizeVlm(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {}
  const pickStr = (key) => (typeof r[key] === 'string' ? r[key].trim() : '')
  const pickOrDefault = (key) => (typeof r[key] === 'string' && r[key].trim() !== '' ? r[key].trim() : VLM_DEFAULTS[key])
  // 超时（秒）：正整数 1~600，非法回退默认
  const t = Number(r && r.timeout)
  const timeout = Number.isFinite(t) && t >= 1 && t <= 600 ? Math.floor(t) : VLM_DEFAULTS.timeout
  const thinkingType = pickOrDefault('thinkingType') === 'enabled' ? 'enabled' : 'disabled'
  return {
    baseURL: pickStr('baseURL'),
    apiKey: pickStr('apiKey'),
    model: pickStr('model'),
    provider: pickStr('provider'),
    thinkingType,
    timeout,
  }
}

/** 读取配置；文件缺失/损坏时回退默认值（多模态识别参数 + 会话清理联动）。 */
async function readConfig() {
  let stored = {}
  try {
    const text = await readFile(CONFIG_PATH, 'utf8')
    stored = JSON.parse(text) || {}
  } catch (err) {
    stored = {}
  }
  return {
    vlm: normalizeVlm(stored.vlm || stored.mimo),
    cleanup: normalizeCleanup(stored.cleanup),
  }
}

/** 保存配置（多模态识别参数 + 会话清理联动）；返回规范化后的配置。 */
async function writeConfig(body) {
  const next = {
    vlm: normalizeVlm(body && (body.vlm || body.mimo)),
    cleanup: normalizeCleanup(body && body.cleanup),
  }
  // 保留会话上传记账（sessions）：全量覆盖配置时不动未知字段
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    if (raw !== null && typeof raw === 'object' && raw.sessions !== null && typeof raw.sessions === 'object') next.sessions = raw.sessions
  } catch { /* 无既有配置 */ }
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---- 去重索引（0.7.0）：键 = cleanName(name) + \u0000 + size（元数据级去重，精度误差已由作者确认接受）。
// 每个项目根一份 <root>/.dsh-file-attachment/.index.json；内存 Map 权威，变更后临时文件 + rename 原子落盘。
// 命中即复用旧路径（决策④乙）：返回前 stat 验旧文件仍在，丢失则删条目按未命中处理。
// 首次触碰某根目录时懒加载；文件损坏则 .index.json.bak 备份留证后重建。
const INDEX_FILE = '.index.json'

// ---- 会话上传日志（0.8.0）：sessionId -> Map<root, Set<dedupKey>>，记录每个会话真正上传过的条目 ----
// 会话删除联动（cleanup.enabled）：会话被删除时按引用计数清理其上传的落盘附件——
// 仅删除「无其他会话引用」的条目（同名同大小去重复用的文件在最后一个引用会话删除时才清除）；
// 未记录归属的旧文件（启用联动之前上传）一律不动，向后兼容零误伤。
// 持久化：随去重索引写入各 root 的 .index.json（sessions 字段：{ <sessionId>: { <root>: [key...] } }），重启自动恢复。
const sessionUploads = new Map() // sessionId -> Map<root, Set<key>>
/** 记录一次会话上传（dedup 命中复用也算引用）。 */
function trackUpload(sessionId, root, key) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  let perRoot = sessionUploads.get(sessionId)
  if (perRoot === undefined) { perRoot = new Map(); sessionUploads.set(sessionId, perRoot) }
  let keys = perRoot.get(root)
  if (keys === undefined) { keys = new Set(); perRoot.set(root, keys) }
  keys.add(key)
}
const indexMap = new Map()  // root -> Map<key, { path, size, firstSeen }>
const indexLoads = new Map() // root -> Promise（并发去重，同一根只加载一次）

function dedupKey(safeName, size) { return safeName + '\u0000' + size }

async function loadIndex(root) {
  const m = new Map()
  try {
    const idxPath = join(root, ATTACHMENT_DIR, INDEX_FILE)
    const text = await readFile(idxPath, 'utf8')
    const stored = JSON.parse(text)
    if (stored !== null && typeof stored === 'object' && typeof stored.entries === 'object' && stored.entries !== null) {
      for (const [k, v] of Object.entries(stored.entries)) {
        if (v !== null && typeof v === 'object' && typeof v.path === 'string' && typeof v.size === 'number') m.set(k, v)
      }
    }
    if (stored !== null && typeof stored === 'object' && stored.sessions !== null && typeof stored.sessions === 'object') {
      for (const [sid, rootsObj] of Object.entries(stored.sessions)) {
        if (rootsObj === null || typeof rootsObj !== 'object') continue
        let perRoot = sessionUploads.get(String(sid))
        if (perRoot === undefined) { perRoot = new Map(); sessionUploads.set(String(sid), perRoot) }
        for (const [r, keys] of Object.entries(rootsObj)) {
          if (!Array.isArray(keys)) continue
          const list = keys.filter((x) => typeof x === 'string')
          const existing = perRoot.get(String(r))
          if (existing === undefined) perRoot.set(String(r), new Set(list))
          else for (const k of list) existing.add(k)
        }
      }
    }
  } catch (err) {
    // ENOENT = 首启，静默空索引；其余（损坏/权限）备份坏文件后重建，下次保存自然覆盖
    try { await rename(join(root, ATTACHMENT_DIR, INDEX_FILE), join(root, ATTACHMENT_DIR, INDEX_FILE + '.bad-' + Date.now().toString(36))) } catch { /* 目录不存在等，忽略 */ }
  }
  return m
}

/** 确保该根的索引已加载，返回权威 Map。 */
function ensureIndex(root) {
  let m = indexMap.get(root)
  if (m !== undefined) return Promise.resolve(m)
  let p = indexLoads.get(root)
  if (p === undefined) {
    p = loadIndex(root).then((loaded) => {
      indexLoads.delete(root)
      const existing = indexMap.get(root)
      if (existing !== undefined) return existing
      indexMap.set(root, loaded)
      return loaded
    })
    indexLoads.set(root, p)
  }
  return p
}

/** 原子落盘索引（临时文件 + rename）。失败只警告，不阻断上传链路。同一 root 的写排队串行，防 rename 乱序覆盖。 */
const indexWrites = new Map() // root -> Promise 链尾
function persistIndex(root) {
  const prev = indexWrites.get(root) ?? Promise.resolve()
  const next = prev.then(() => writeIndexNow(root)).catch(() => {})
  indexWrites.set(root, next)
  return next
}
async function writeIndexNow(root) {
  const m = indexMap.get(root)
  if (m === undefined) return
  const dir = join(root, ATTACHMENT_DIR)
  const tmp = join(dir, '.index-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.tmp')
  try {
    await mkdir(dir, { recursive: true })
    const obj = {}
    for (const [k, v] of m) obj[k] = v
    const sessionsObj = {}
    for (const [sid, perRoot] of sessionUploads) {
      const ro = {}
      for (const [r, keys] of perRoot) ro[r] = Array.from(keys)
      sessionsObj[sid] = ro
    }
    await writeFile(tmp, JSON.stringify({ version: 1, entries: obj, sessions: sessionsObj }) + '\n', 'utf8')
    await rename(tmp, join(dir, INDEX_FILE))
  } catch (err) {
    await unlink(tmp).catch(() => {})
    console.warn('[dsh-file-attachment] 索引落盘失败（不影响上传）:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 查询去重命中：返回旧条目 { path, size, firstSeen }；未命中或旧文件已丢失返回 null。
 * 必须经 ensureIndex 之后调用（纯内存查询 + 一次 stat 验证）。
 */
async function dedupLookup(root, key) {
  const m = indexMap.get(root)
  if (m === undefined) return null
  const e = m.get(key)
  if (e === undefined) return null
  try {
    const st = await stat(e.path)
    if (st.isFile() && st.size === e.size) return e
  } catch { /* 旧文件已删：视为未命中并清条目 */ }
  m.delete(key)
  await persistIndex(root)
  return null
}

/** 记录新落盘文件到索引（幂等覆盖 + 落盘完成才返回：响应返回 = 磁盘一致）。 */
async function dedupRecord(root, key, path, size, sessionId) {
  const m = indexMap.get(root)
  if (m === undefined) return
  m.set(key, { path, size, firstSeen: Date.now() })
  trackUpload(sessionId, root, key)
  await persistIndex(root)
}

/**
 * 流式保存一个上传文件（请求体即文件原始字节流）并返回落盘信息。
 * 先以 wx 独占创建随机临时文件、经计数管道流式写入（超 MAX_BYTES 立即中断），
 * 完成后用 link（目标存在即 EEXIST）原子占用最终名——并发同名各自拿到不同序号，
 * 中断/超限只清临时文件，不会留下半截正式文件或互相覆盖。
 * @param root - 项目根（会话工作区）。
 * @param rawName - 查询参数带来的原始文件名。
 * @param req - HTTP 请求（作为可读流直接管道到磁盘）。
 * @returns { path, dir, name, size, deduped? }。deduped=true 表示复用已有文件（未新落盘）。
 */
async function handleSaveStream(root, rawName, req, sessionId) {
  const safe = cleanName(rawName)
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  const dir = join(root, ATTACHMENT_DIR)
  // 0.7.0 起平铺存放（不再按日期分子目录）；文件保留原始文件名 → 芯片 basename 即原始名
  await mkdir(dir, { recursive: true })
  // 去重索引需先就位（after-check 与落盘记录都用得到），与接收流并行加载不拖慢首包
  const indexReady = ensureIndex(root)
  const tmp = join(dir, '.upload-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10))
  let size = 0
  let oversize = false
  const fh = await open(tmp, 'wx')
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > MAX_BYTES) { oversize = true; throw new Error('OVERSIZE') }
          yield chunk
        }
      },
      fh.createWriteStream(),
    )
  } catch (err) {
    await unlink(tmp).catch(() => {})
    if (oversize) throw new Error('文件超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB 上限')
    throw err
  }
  if (size === 0) {
    await unlink(tmp).catch(() => {})
    throw new Error('内容为空')
  }
  // ---- 去重 after-check（兜底，覆盖绕过 /precheck 的直连上传与并发竞态）----
  // 此时 size 已知；键 = cleanName + size。命中：丢弃刚接收的临时文件，复用旧路径（决策④乙：用旧名字）。
  await indexReady
  const key = dedupKey(safe, size)
  const hit = await dedupLookup(root, key)
  if (hit !== null) {
    await unlink(tmp).catch(() => {})
    trackUpload(sessionId, root, key)
    const base = hit.path.slice(Math.max(hit.path.lastIndexOf('/'), hit.path.lastIndexOf('\\')) + 1)
    return { path: hit.path, dir, name: base, size, deduped: true }
  }
  // link 在目标已存在时抛 EEXIST —— 天然原子的「不存在才占位」；冲突则递增序号重试
  let target = join(dir, safe)
  for (let i = 1; ; i += 1) {
    try {
      await link(tmp, target)
      break
    } catch (err) {
      if (err !== null && err.code === 'EEXIST') {
        target = join(dir, stem + '-' + i + ext)
        continue
      }
      await unlink(tmp).catch(() => {})
      throw err
    }
  }
  await unlink(tmp).catch(() => {})
  // 并发收敛：link 与索引写入之间另一路同名上传可能已入索引；link 已成功（原子、名字不同），
  // 后到者弃用自己的产物改指先者（unlink 只删自己的目录项，不影响对方文件数据）
  const late = await dedupLookup(root, key)
  if (late !== null && late.path !== target) {
    await unlink(target).catch(() => {})
    const base = late.path.slice(Math.max(late.path.lastIndexOf('/'), late.path.lastIndexOf('\\')) + 1)
    return { path: late.path, dir, name: base, size, deduped: true }
  }
  await dedupRecord(root, key, target, size, sessionId)
  return { path: target, dir, name: safe, size }
}

// ---- 会话清理联动（0.8.0）：搭配 dsh-session-delete 等提供「删除会话」的插件使用 ----
// 触发：监听 api-session/removed 总线事件（会话删除完成后的广播）。
// 动作：按引用计数清理该会话上传到 <root>/.dsh-file-attachment/ 的文件；
// 仍被其他会话引用（同名同大小去重复用）的文件保留到最后一个引用会话删除时再清。
async function cleanupSessionUploads(sessionId) {
  const perRoot = sessionUploads.get(sessionId)
  sessionUploads.delete(sessionId)
  if (perRoot === undefined || perRoot.size === 0) return { removed: 0, kept: 0 }
  let removed = 0
  let kept = 0
  for (const [root, keys] of perRoot) {
    await ensureIndex(root)
    const m = indexMap.get(root)
    if (m === undefined) continue
    for (const key of keys) {
      const entry = m.get(key)
      if (entry === undefined) continue
      // 引用计数：其他会话是否仍引用该条目（同 root 同 key）
      let refs = 0
      for (const [, other] of sessionUploads) {
        const otherKeys = other.get(root)
        if (otherKeys !== undefined && otherKeys.has(key)) refs += 1
      }
      if (refs > 0) { kept += 1; continue }
      await unlink(entry.path).catch(() => {})
      m.delete(key)
      removed += 1
    }
    await persistIndex(root)
  }
  console.log('[dsh-file-attachment] cleanup for session', sessionId, ': removed=' + removed + ', kept=' + kept)
  return { removed, kept }
}

/** 清空某会话存放在用户级配置里的设置值（会话删除时联动触发；无记录时静默跳过）。 */
async function clearSessionConfig(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    if (raw !== null && typeof raw === 'object' && raw.sessions !== null && typeof raw.sessions === 'object' && sessionId in raw.sessions) {
      delete raw.sessions[sessionId]
      await writeFile(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf8')
    }
  } catch { /* 配置不存在/损坏：静默跳过 */ }
}

// ---- 多模态识别（VLM）：两条调用路径 ----
// 1) harness 模式（默认）：baseURL/apiKey 留空 → 走 harness 自身的 llm 服务
//    （凭据由 harness 已配置的服务商提供），prepareCall + stream 出文本；
// 2) 自定义端点模式：baseURL + apiKey 已填 → 直接打该 OpenAI 兼容 /chat/completions。

/** 仅思考模型识别：这类模型不接受 thinking 扁平参数，派生字段在旧实现里用于跳过 thinking 注入。 */
function isThinkingOnlyModel(model) {
  const m = String(model || '').toLowerCase()
  return m.includes('reasoner') || m.includes('-r1') || m.includes('thinking')
}

/** 自定义端点的 thinking 参数（部分兼容 API 忽略扁平 thinkingType，认 thinking:{type}）。 */
function buildThinkingParams(vlm) {
  if (isThinkingOnlyModel(vlm.model)) return {}
  const wantEnabled = vlm.thinkingType === 'enabled'
  return { thinking: { type: wantEnabled ? 'enabled' : 'disabled' } }
}

/** 从 OpenAI 兼容响应的 content 里取文本（兼容字符串 / 分片数组两种形状）。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const part of content) {
      if (typeof part === 'string') out += part
      else if (part && typeof part.text === 'string') out += part.text
    }
    return out
  }
  return ''
}

/**
 * 走自定义 OpenAI 兼容端点识别图片。
 * @param vlm - 多模态参数 { baseURL, apiKey, model, thinkingType, timeout }（timeout 单位秒）。
 * @param dataUrl - base64 data URL。
 * @param prompt - 可选关注点。
 * @returns 识别出的中文描述（非空）。
 */
async function describeImageViaEndpoint(vlm, dataUrl, prompt) {
  const url = vlm.baseURL.replace(/\/+$/u, '') + '/chat/completions'
  const timeoutSec = (Number.isFinite(vlm.timeout) && vlm.timeout >= 1 && vlm.timeout <= 600) ? vlm.timeout : VLM_DEFAULTS.timeout
  const controller = new AbortController()
  let timer = null
  /** 超时中止：明确报错而非挂死会话。 */
  const expire = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('图片识别超时（' + timeoutSec + ' 秒），可在设置→文件附件调大超时'))
    }, timeoutSec * 1000)
  })
  const request = (async () => {
    const body = {
      model: vlm.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : '请描述这张图片的内容' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      ...buildThinkingParams(vlm),
    }
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + vlm.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) throw new Error('图片识别超时（' + timeoutSec + ' 秒），可在设置→文件附件调大超时')
      throw new Error('无法连接视觉模型端点：' + (err && err.message ? err.message : String(err)))
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error('视觉模型返回 ' + response.status + '：' + text.slice(0, 300))
    let payload = null
    try { payload = JSON.parse(text) } catch { throw new Error('视觉模型返回非 JSON：' + text.slice(0, 200)) }
    const message = payload && Array.isArray(payload.choices) && payload.choices[0] ? payload.choices[0].message : null
    const content = message ? contentToText(message.content) : ''
    if (typeof content !== 'string' || content.trim() === '') throw new Error('视觉模型未返回描述内容')
    return content.trim()
  })()
  try {
    return await Promise.race([request, expire])
  } finally {
    if (timer !== null) clearTimeout(timer)
    request.catch(() => {})
  }
}

/** 把 data URL 拆成 mime + base64 字节（harness 模式的图片消息用）。 */
function splitDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/su.exec(dataUrl)
  if (m === null) return null
  const mime = m[1] !== undefined && m[1] !== '' ? m[1] : 'image/png'
  const base64 = m[2] !== undefined ? m[2] : ''
  if (base64 === '') return null
  return { mime, bytes: Buffer.from(base64, 'base64') }
}

/**
 * 按 harness BlockAssembler 的语义从流式块里取「正文」文本。
 *
 * 两个必须照抄的规则（真实 adapter 会触发，否则描述会重复）：
 *  1) 只收 text-delta，忽略 reasoning-delta（思考过程不能污染回填描述）；
 *  2) 一个 index 的 block-end 到达后，该 index 后续的 delta 一律丢弃——
 *     adapter 常在 block-end 之后再补发一次「完整正文」的 text-delta（累积回放），
 *     照收就会把同一段话拼两遍。
 * @param chunks - 按流序排列的块。
 * @returns 按块顺序拼出的正文，块间以换行分隔。
 */
function assembleTextFromChunks(chunks) {
  /** index -> { blockType, text, closed } */
  const partials = new Map()
  const order = []
  const ensure = (index, blockType) => {
    let p = partials.get(index)
    if (p === undefined) {
      p = { blockType, text: '', closed: false }
      partials.set(index, p)
      order.push(index)
    }
    return p
  }
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined || typeof chunk !== 'object') continue
    if (chunk.type === 'block-start') {
      ensure(chunk.index, chunk.blockType)
      continue
    }
    if (chunk.type === 'text-delta') {
      const p = ensure(chunk.index, 'text')
      if (p.closed) continue // block-end 之后的回放，丢弃
      if (typeof chunk.text === 'string') p.text += chunk.text
      continue
    }
    if (chunk.type === 'block-end') {
      const block = chunk.block && typeof chunk.block === 'object' ? chunk.block : null
      const p = ensure(chunk.index, block && typeof block.type === 'string' ? block.type : 'text')
      if (p.closed) continue // 重复 close，忽略
      p.closed = true
      // 块内容以 block-end 携带的完整文本为准（delta 可能缺失）
      if (block !== null && typeof block.text === 'string') p.text = block.text
      if (block !== null && typeof block.type === 'string') p.blockType = block.type
      continue
    }
    // reasoning-delta / tool-call-delta / usage / finish 等一律忽略
  }
  const parts = []
  for (const index of order) {
    const p = partials.get(index)
    if (p === undefined || p.blockType !== 'text') continue
    const text = typeof p.text === 'string' ? p.text : ''
    if (text.trim() !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 走 harness 自身 llm 识别图片：prepareCall + stream，凭据由 harness 配置。
 * model 为 harness 模型 id；provider 可选（留空则由 llm 解析默认路由）。
 * @returns 识别出的中文描述（非空）。
 */
async function describeImageViaHarness(ctx, vlm, dataUrl, prompt) {
  const llm = (ctx && typeof ctx.get === 'function') ? ctx.get('llm') : (ctx && ctx.llm)
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new Error('harness 的 llm 服务不可用，无法使用内置模型识别；请在设置→文件附件填写 Base URL 与 API Key 走自定义端点')
  }
  const split = splitDataUrl(dataUrl)
  if (split === null) throw new Error('图片数据无效（data URL 解析失败）')
  // provider 未指定时，退到当前会话/默认模型的服务商
  let provider = typeof vlm.provider === 'string' ? vlm.provider : ''
  if (provider === '') {
    const adm = (ctx && typeof ctx.get === 'function') ? ctx.get('agentDefaultModel') : (ctx && ctx.agentDefaultModel)
    try {
      const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
      if (sel && typeof sel.provider === 'string') provider = sel.provider
    } catch { /* 取不到则交给 prepareCall 报错 */ }
  }
  if (provider === '') throw new Error('无法确定服务商：请在设置→文件附件重新选择模型')
  const timeoutSec = (Number.isFinite(vlm.timeout) && vlm.timeout >= 1 && vlm.timeout <= 600) ? vlm.timeout : VLM_DEFAULTS.timeout
  const controller = new AbortController()
  let timer = null
  const expire = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('图片识别超时（' + timeoutSec + ' 秒），可在设置→文件附件调大超时'))
    }, timeoutSec * 1000)
  })
  const run = (async () => {
    // 思考模式 → harness 的 reasoningEffort：必须落在该模型声明的 effort 集合内，
    // 否则 prepareCall 直接抛 UNSUPPORTED_REASONING_EFFORT。用 configure 回调按模型元数据挑：
    // 关闭时选最低档（尽量快，识别任务不需要深度思考）；开启时选模型默认档。
    const prepared = await llm.prepareCall({ provider, model: vlm.model }, controller.signal, (_controls, info) => {
      const reasoning = info && info.reasoning
      if (reasoning === undefined || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) {
        return {} // 模型不支持 reasoning：不传该字段
      }
      const ids = reasoning.efforts.map((e) => e && e.id).filter((id) => typeof id === 'string')
      if (ids.length === 0) return {}
      const wanted = vlm.thinkingType === 'enabled'
        ? (reasoning.defaultEffort && ids.includes(reasoning.defaultEffort) ? reasoning.defaultEffort : ids[0])
        : ids[0] // 最低档：efforts 按强度升序声明
      return { reasoningEffort: wanted }
    })
    // harness 的 image 内容块要求 durable 附件引用（block.attachment），不接受内联 base64：
    // 先经 attachments 服务落盘取得引用，再随消息发送。
    const attachments = (ctx && typeof ctx.get === 'function') ? ctx.get('attachments') : undefined
    if (attachments === undefined || typeof attachments.saveImages !== 'function') {
      throw new Error('harness 的 attachments 服务不可用，无法把图片交给内置模型；请在设置→文件附件填写 Base URL 与 API Key 走自定义端点')
    }
    const refs = await attachments.saveImages([{ data: split.bytes, mediaType: split.mime }])
    const ref = Array.isArray(refs) ? refs[0] : undefined
    if (ref === undefined) throw new Error('图片附件落盘失败，无法识别')
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : '请描述这张图片的内容' },
        { type: 'image', attachment: ref },
      ],
    }]
    const chunks = []
    let terminal = null
    const options = { ...prepared.config, messages, signal: controller.signal }
    for await (const chunk of prepared.stream(options)) {
      if (chunk === null || chunk === undefined) continue
      if (chunk.type === 'finish' || chunk.type === 'end') terminal = chunk
      chunks.push(chunk)
    }
    if (terminal !== null && typeof terminal === 'object' && terminal.reason && terminal.reason.kind === 'error') {
      throw new Error('harness 模型调用失败：' + (terminal.reason.message || '未知原因'))
    }
    const text = assembleTextFromChunks(chunks).trim()
    if (text === '') throw new Error('harness 模型未返回描述内容（该模型可能不支持图片输入）')
    return text
  })()
  try {
    return await Promise.race([run, expire])
  } finally {
    if (timer !== null) clearTimeout(timer)
    run.catch(() => {})
  }
}

/**
 * 按配置选择调用路径识别图片。
 * @param ctx - 宿主上下文（harness 模式需要 llm 服务）。
 * @param vlm - 规范化后的多模态参数。
 * @param dataUrl - base64 data URL。
 * @param prompt - 可选关注点。
 */
async function describeImage(ctx, vlm, dataUrl, prompt) {
  if (isVlmHarnessMode(vlm)) return describeImageViaHarness(ctx, vlm, dataUrl, prompt)
  return describeImageViaEndpoint(vlm, dataUrl, prompt)
}

/**
 * 校验视觉模型配置是否可用（设置页保存前调用，不落盘）。
 * 两种模式各探一次：自定义端点发最小请求；harness 模式只校验模型可用性（不发图片，省额度）。
 */
async function testVlm(ctx, vlm) {
  if (isVlmHarnessMode(vlm)) {
    const llm = (ctx && typeof ctx.get === 'function') ? ctx.get('llm') : (ctx && ctx.llm)
    if (!llm || typeof llm.listModels !== 'function') throw new Error('harness 的 llm 服务不可用')
    const provider = typeof vlm.provider === 'string' ? vlm.provider : ''
    if (provider === '') throw new Error('请选择服务商')
    const models = await llm.listModels(provider).catch((err) => {
      throw new Error('无法读取服务商模型目录：' + (err && err.message ? err.message : String(err)))
    })
    const ids = (Array.isArray(models) ? models : []).map((m) => m && m.id).filter((x) => typeof x === 'string')
    if (!ids.includes(vlm.model)) throw new Error('该服务商下没有模型「' + vlm.model + '」')
    return
  }
  const url = vlm.baseURL.replace(/\/+$/u, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + vlm.apiKey },
      body: JSON.stringify({ model: vlm.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error('视觉模型端点返回 ' + response.status + '：' + text.slice(0, 200))
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error('视觉模型端点连接超时（20 秒）')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * harness 模型目录（供设置页「模型」下拉选取，参考 dsh-pet 的做法）：
 * listProviders() → 逐个 listModels(provider)，只返回支持图片输入的模型
 * （多模态识别专用，避免选到纯文本模型）。任何失败都降级为空目录，不阻断设置页。
 * @returns { providers: [{ id, name, models: [{ id, name }] }] }
 */
async function listHarnessModels(ctx) {
  const llm = (ctx && typeof ctx.get === 'function') ? ctx.get('llm') : (ctx && ctx.llm)
  if (!llm) return { providers: [] }
  const named = (id, name) => {
    const pid = String(id ?? '')
    return { id: pid, name: String(name ?? '') || pid }
  }
  let providers = []
  try {
    if (typeof llm.listProviders === 'function') providers = llm.listProviders().map((p) => named(p?.id, p?.name))
    if (providers.length === 0 && typeof llm.listConfigurableProviders === 'function') {
      providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName))
    }
  } catch (err) {
    console.warn('[dsh-file-attachment] listProviders failed:', err instanceof Error ? err.message : String(err))
    return { providers: [] }
  }
  providers = providers.filter((p) => p.id !== '')
  const catalog = await Promise.all(providers.map(async (p) => {
    let models = []
    try {
      const list = await llm.listModels?.(p.id)
      models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id !== '')
    } catch { models = [] }
    // 只保留声明支持 image 输入的模型；能力未知的保留（可能只是没声明）
    const kept = []
    for (const m of models) {
      let capable = true
      try {
        const info = await llm.resolveModelInfo?.(p.id, m.id)
        const mods = info && info.inputModalities
        if (Array.isArray(mods)) capable = mods.includes('image')
      } catch { capable = true }
      if (capable) kept.push(m)
    }
    return { id: p.id, name: p.name, models: kept }
  }))
  return { providers: catalog.filter((p) => p.models.length > 0) }
}


async function modelSupportsImage(ctx) {
  const llm = (ctx && typeof ctx.get === 'function') ? ctx.get('llm') : (ctx && ctx.llm)
  const adm = (ctx && typeof ctx.get === 'function') ? ctx.get('agentDefaultModel') : (ctx && ctx.agentDefaultModel)
  if (!llm || typeof llm.resolveModelInfo !== 'function') return { ok: true, supportsImage: true, known: false }
  let sel = null
  try {
    if (adm && typeof adm.currentSelection === 'function') sel = adm.currentSelection()
  } catch { /* 取不到选择 → 按未知放行 */ }
  if (!sel || typeof sel.provider !== 'string' || sel.provider === '' || typeof sel.model !== 'string' || sel.model === '') {
    return { ok: true, supportsImage: true, known: false }
  }
  try {
    const info = await llm.resolveModelInfo(sel.provider, sel.model)
    const mods = info && info.inputModalities
    if (!Array.isArray(mods)) return { ok: true, supportsImage: true, known: false }
    return { ok: true, supportsImage: mods.includes('image'), known: true, provider: sel.provider, model: sel.model }
  } catch (err) {
    console.warn('[dsh-file-attachment] resolveModelInfo failed, allow upload:', err instanceof Error ? err.message : String(err))
    return { ok: true, supportsImage: true, known: false }
  }
}

/** 注册 /dsh-file-attachment 前缀路由（save POST）。 */
function registerRoutes(ctx) {
  const webserver = ctx.get('webServer')
  if (webserver === undefined) return
  webserver.register({
    kind: 'prefix',
    path: '/dsh-file-attachment',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/save') {
        // 协议（0.6.4 起）：元数据走查询参数（name/sessionId，URL 编码），
        // 请求体是文件原始字节流，服务端流式写盘（不再 JSON+base64 整包进内存）
        const q = new URL(req.url ?? '/', 'http://x').searchParams
        const rawName = q.get('name') ?? ''
        const sessionId = q.get('sessionId') ?? ''
        let root
        try {
          root = projectRoot(ctx, sessionId)
        } catch (err) {
          json(res, { ok: false, error: '无法解析项目根' }, 500)
          return
        }
        try {
          const value = await handleSaveStream(root, rawName, req, sessionId)
          json(res, { ok: true, value })
          return
        } catch (err) {
          const message = err && err.message ? err.message : '保存失败'
          const oversized = message.indexOf('上限') >= 0
          json(res, { ok: false, error: message }, oversized ? 413 : 400)
          return
        }
      }
      // 去重预检（0.7.0）：Client 上传前 POST {name,size,sessionId}（JSON）。
      // 命中返回 { path, name, size, dir, deduped:true }（客户端据此零字节上传）；未命中 value 为 null。
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/precheck') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null || typeof body !== 'object' || typeof body.name !== 'string' || !Number.isFinite(Number(body.size)) || Number(body.size) <= 0) {
          json(res, { ok: false, error: '请求体须为 JSON 且含 name 与正数 size' }, 400)
          return
        }
        let root
        try {
          root = projectRoot(ctx, typeof body.sessionId === 'string' ? body.sessionId : '')
        } catch (err) {
          json(res, { ok: false, error: '无法解析项目根' }, 500)
          return
        }
        try {
          await ensureIndex(root)
          const hit = await dedupLookup(root, dedupKey(cleanName(body.name), Math.floor(Number(body.size))))
          if (hit !== null) {
            const base = hit.path.slice(Math.max(hit.path.lastIndexOf('/'), hit.path.lastIndexOf('\\')) + 1)
            json(res, { ok: true, value: { path: hit.path, name: base, size: hit.size, dir: join(root, ATTACHMENT_DIR), deduped: true } })
          } else {
            json(res, { ok: true, value: null })
          }
          return
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : '预检失败' }, 500)
          return
        }
      }
      // 会话清理状态（GET /cleanup-status?sessionId=...）：该会话上传的文件数与总字节，供设置页展示
      // 当前模型多模态能力（供客户端上传图片前判定；参考 pet 的 harness 模型选取）
      if (req.method === 'GET' && pathname === '/dsh-file-attachment/model-capability') {
        json(res, await modelSupportsImage(ctx))
        return
      }
      if (req.method === 'GET' && pathname === '/dsh-file-attachment/cleanup-status') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams
        const sid = q.get('sessionId') ?? ''
        let total = 0
        let count = 0
        const perRoot = sessionUploads.get(sid)
        if (perRoot !== undefined) {
          for (const [root, keys] of perRoot) {
            await ensureIndex(root)
            const m = indexMap.get(root)
            if (m === undefined) continue
            for (const key of keys) {
              const e = m.get(key)
              if (e !== undefined) { count += 1; total += e.size }
            }
          }
        }
        const cfg = await readConfig()
        json(res, { ok: true, value: { files: count, bytes: total, enabled: cfg.cleanup.enabled } })
        return
      }
      // 【已屏蔽 /version 路由，保留代码以备后用】
      // if (req.method === 'GET' && pathname === '/dsh-file-attachment/version') {
      //   try {
      //     const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
      //     const raw = await readFile(pkgPath, 'utf8')
      //     const pkg = JSON.parse(raw)
      //     json(res, { ok: true, version: pkg.version || '0.0.0' })
      //     return
      //   } catch {
      //     json(res, { ok: false, version: 'unknown' }, 500)
      //     return
      //   }
      // }
      if (req.method === 'GET' && pathname === '/dsh-file-attachment/config') {
        json(res, { ok: true, value: await readConfig() })
        return
      }
      // harness 模型目录：设置页「模型」下拉的选项来源（参考 dsh-pet 的 /models 做法）
      if (req.method === 'GET' && pathname === '/dsh-file-attachment/models') {
        try {
          json(res, { ok: true, value: await listHarnessModels(ctx) })
        } catch (err) {
          console.warn('[dsh-file-attachment] listHarnessModels failed:', err instanceof Error ? err.message : String(err))
          json(res, { ok: true, value: { providers: [] } })
        }
        return
      }
      // 设置页保存前校验视觉模型配置（不落盘）：端点不可达 / 模型不存在时提示原因
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/test') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON' }, 400)
          return
        }
        const vlm = normalizeVlm(body.vlm)
        if (!isVlmConfigured(vlm)) {
          json(res, { ok: false, error: VLM_CONFIG_ERROR }, 400)
          return
        }
        try {
          await testVlm(ctx, vlm)
          json(res, { ok: true, value: { tested: true } })
        } catch (err) {
          json(res, { ok: false, error: err && err.message ? err.message : '视觉模型校验失败' }, 502)
        }
        return
      }
      // 图片识别（供 describe_image 工具与调试用）：dataUrl + 可选 prompt
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/describe') {
        const body = await readJsonBody(req, 64 * 1024 * 1024)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON（含 dataUrl）' }, 400)
          return
        }
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        if (dataUrl === '') {
          json(res, { ok: false, error: 'dataUrl 必须是非空字符串（base64 data URL）' }, 400)
          return
        }
        const cfg = await readConfig()
        if (!isVlmConfigured(cfg.vlm)) {
          json(res, { ok: false, error: VLM_CONFIG_ERROR }, 400)
          return
        }
        try {
          const description = await describeImage(ctx, cfg.vlm, dataUrl, body.prompt)
          json(res, { ok: true, value: { description, thinkingType: cfg.vlm.thinkingType } })
        } catch (err) {
          json(res, { ok: false, error: err && err.message ? err.message : '识别失败' }, 502)
        }
        return
      }
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/config') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON' }, 400)
          return
        }
        const value = await writeConfig(body)
        json(res, { ok: true, value: { saved: true, config: value } })
        return
      }
      json(res, { ok: false, error: 'only POST /dsh-file-attachment/save、POST /dsh-file-attachment/precheck、GET/POST /dsh-file-attachment/config、POST /dsh-file-attachment/test、POST /dsh-file-attachment/describe、GET /dsh-file-attachment/models、GET /dsh-file-attachment/cleanup-status、GET /dsh-file-attachment/model-capability are allowed' }, 405)
    },
  })
}

/** 把 fs 常见错误码转成中文提示（其余错误原样抛出）。 */
function fsErrorToMessage(err, p) {
  const code = err !== null && err !== undefined ? err.code : undefined
  if (code === 'ENOENT') return new Error('图片文件不存在：' + p)
  if (code === 'EACCES' || code === 'EPERM') return new Error('图片文件无读取权限：' + p)
  if (code === 'EISDIR') return new Error('path 指向目录，不是图片文件：' + p)
  return err
}

/** 图片扩展名判定（describe_image 工具用）。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/iu
/** describe_image 工具读图上限 20MB：模型可传任意图片路径，先按 stat 大小拦截。 */
const MAX_DESCRIBE_BYTES = 20 * 1024 * 1024
/** 门控涉及的两个工具名（注册与按-agent 隐藏共用同一标识）。 */
const DESCRIBE_TOOL = 'describe_image'
const READ_TOOL = 'read_image'

/** 按扩展名推断 MIME（缺省 image/png）。 */
function mimeFromPath(p) {
  const ext = String(p ?? '').toLowerCase().split('.').pop() || ''
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'bmp': return 'image/bmp'
    default: return 'image/png'
  }
}

/**
 * 多模态能力门控（对称双向）：按会话所选模型 inputModalities 对该 agent scope 调整工具可见性——
 *   支持图片（含 image）→ deny describe_image（host 原生 read_image 直接看图，无需 VLM 中转）；
 *   明确不支持（有 inputModalities 数组但不含 image）→ deny read_image
 *     （它对纯文本模型必然抛「does not declare image input」错，留着只会诱导模型走死路）；
 *   能力未知（absent / provider·model 缺失 / 查询抛错）→ 两边都不动（保守：宁留 VLM 也不误藏）。
 * @param ctx - 插件宿主 Context（软依赖 llm / agents 服务）。
 */
function createVisionGate(ctx) {
  /** sessionId -> { appliedKey, release, seq } */
  const state = new Map()

  /** 三态能力判定：'vision' / 'text' / 'unknown'。 */
  async function classifyCapability(provider, model) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return 'unknown'
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return 'unknown'
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const mods = info && info.inputModalities
      if (!Array.isArray(mods)) return 'unknown' // absent = unknown，不是 negative capability
      return mods.includes('image') ? 'vision' : 'text'
    } catch (err) {
      console.warn('[dsh-file-attachment] resolveModelInfo failed, keep both tools:', err instanceof Error ? err.message : String(err))
      return 'unknown'
    }
  }

  /** 对一个 live agent 重新评估能力并按需重设该 agent 的 deny 集。fire-and-forget。 */
  async function evaluate(agent, sel) {
    if (agent === null || agent === undefined || typeof agent.id !== 'string') return
    let s = state.get(agent.id)
    if (s === undefined) { s = { appliedKey: '', release: null, seq: 0 }; state.set(agent.id, s) }
    const mySeq = ++s.seq
    const opts = (agent.options && typeof agent.options === 'object') ? agent.options : {}
    let headerCfg
    try { headerCfg = (agent.session && typeof agent.session.requestHeader === 'function') ? agent.session.requestHeader()?.config : undefined } catch { headerCfg = undefined }
    const pick = (k) => ((sel && typeof sel[k] === 'string' && sel[k] !== '') ? sel[k] : ((headerCfg && typeof headerCfg[k] === 'string' && headerCfg[k] !== '') ? headerCfg[k] : opts[k]))
    const provider = pick('provider')
    const model = pick('model')
    const cap = await classifyCapability(provider, model)
    if (state.get(agent.id) !== s || s.seq !== mySeq) return
    const deny = cap === 'vision' ? [DESCRIBE_TOOL] : cap === 'text' ? [READ_TOOL] : []
    const key = deny.join(',')
    if (key === s.appliedKey) return
    try { if (s.release !== null) s.release() } catch { /* 可能已被 scoped unwind，忽略 */ }
    s.release = null
    s.appliedKey = ''
    if (deny.length > 0) {
      try {
        const tools = (agent.ctx && typeof agent.ctx === 'object') ? agent.ctx.tools : undefined
        if (tools === undefined || typeof tools.restrict !== 'function') return
        const release = tools.restrict({ deny })
        if (typeof release === 'function') { s.release = release; s.appliedKey = key }
      } catch (err) {
        console.warn('[dsh-file-attachment] restrict failed (' + key + '):', err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** agent 销毁：释放 disposer 并清除状态。 */
  function dispose(sessionId) {
    const s = state.get(sessionId)
    if (s === undefined) return
    try { if (s.release !== null) s.release() } catch { /* scoped world 已回退，忽略 */ }
    state.delete(sessionId)
  }

  return { evaluate, dispose }
}

/**
 * 注册 describe_image 工具：模型看到用户消息里的图片路径引用（@/绝对路径）时调用，
 * 读图片 → 调 VLM 识别 → 识别结果直接作为工具输出返回（tool/result 的 content 是 model-facing）。
 * @param ctx - 宿主上下文。
 */
function registerTools(ctx) {
  const tools = (ctx != null && typeof ctx.get === 'function') ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    console.warn('[dsh-file-attachment] tools 服务不可用，跳过 describe_image 注册')
    return
  }
  if (typeof defineTool !== 'function') {
    console.warn('[dsh-file-attachment] @deepseek-ai/dsh-tools 不可用，跳过 describe_image 注册')
    return
  }
  tools.register(defineTool({
    name: DESCRIBE_TOOL,
    description: '当用户消息里出现图片路径引用（形如 @/绝对路径，扩展名 png/jpg/jpeg/gif/webp/bmp）且需要理解图片内容时调用此工具，获取该图片的中文内容描述。path 参数填去掉前导 @ 的绝对路径。prompt 可选，指定要关注的内容（如"识别图中文字"、"描述 UI 布局"）。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '图片文件的绝对路径（去掉前导 @）',
      },
      prompt: {
        type: 'string',
        description: '可选。告诉多模态模型要关注什么（如"识别图中的文字"、"描述 UI 布局"）。不填则默认"请描述这张图片"。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          description: { type: 'string' },
          thinkingType: { type: 'string', description: '当前 VLM 思考模式配置：enabled=开启 / disabled=关闭' },
        },
      },
      render: (_args, value) => {
        if (value && value.ok === true && typeof value.description === 'string' && value.description !== '') {
          return [{ type: 'text', text: '图片识别结果：' + value.description }]
        }
        return [{ type: 'text', text: (value && value.ok === true) ? '（图片已识别）' : '（图片识别失败）' }]
      },
    },
    async execute(args) {
      let path = typeof args.path === 'string' ? args.path.trim() : ''
      if (path.startsWith('@')) path = path.slice(1)
      if (path === '') throw new Error('path 不能为空')
      if (!IMAGE_EXT.test(path)) throw new Error('path 不是受支持的图片（png/jpg/jpeg/gif/webp/bmp）')
      // 先 stat 拦截：非普通文件 / 空文件 / 超限大文件都不读入内存
      let st
      try {
        st = await stat(path)
      } catch (err) {
        throw fsErrorToMessage(err, path)
      }
      if (!st.isFile()) throw new Error('path 不是普通文件')
      if (st.size === 0) throw new Error('图片文件为空')
      if (st.size > MAX_DESCRIBE_BYTES) throw new Error('图片超过 ' + Math.round(MAX_DESCRIBE_BYTES / 1024 / 1024) + 'MB 上限，无法识别')
      let bytes
      try {
        bytes = await readFile(path)
      } catch (err) {
        throw fsErrorToMessage(err, path)
      }
      if (bytes.length === 0) throw new Error('图片文件为空')
      const dataUrl = 'data:' + mimeFromPath(path) + ';base64,' + bytes.toString('base64')
      const cfg = await readConfig()
      if (!isVlmConfigured(cfg.vlm)) throw new Error(VLM_CONFIG_ERROR + '，无法识别图片')
      const description = await describeImage(ctx, cfg.vlm, dataUrl, args.prompt)
      return { ok: true, description, thinkingType: cfg.vlm.thinkingType }
    },
  }))
  console.log('[dsh-file-attachment] describe_image tool registered')
}

/**
 * @param ctx - 宿主上下文（webServer + tools 注入）。
 */
export function apply(ctx, config = {}) {
  registerTools(ctx)
  registerRoutes(ctx)
  // ---- 对称双向能力门控：会话开始与模型切换时按所选模型 inputModalities 调整工具可见性 ----
  const gate = createVisionGate(ctx)
  ctx.on('agent/created', ({ agent }) => { void gate.evaluate(agent) })
  ctx.on('agent/disposed', ({ agent }) => { gate.dispose(agent.id) })
  // ---- 会话删除联动：dsh-session-delete 等插件删除会话后广播 api-session/removed ----
  ctx.on('api-session/removed', (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    void readConfig().then((cfg) => {
      if (!cfg.cleanup.enabled) return
      return Promise.all([cleanupSessionUploads(sessionId), clearSessionConfig(sessionId)])
    }).catch((err) => {
      console.warn('[dsh-file-attachment] session cleanup failed:', err instanceof Error ? err.message : String(err))
    })
  })
  ctx.on('session/event', (session, event) => {
    if (event === null || event === undefined || event.type !== 'model/selection') return
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = (agents !== undefined && typeof agents.get === 'function') ? agents.get(session.id) : undefined
    if (agent !== undefined && agent !== null) void gate.evaluate(agent, event.data)
  })
  console.log('[dsh-file-attachment] host loaded (webServer routes + describe_image tool)')
}
