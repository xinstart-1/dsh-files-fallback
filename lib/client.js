// dsh-files-fallback 浏览器半（client 半，全部功能在此）。
// 拖放/粘贴文件进输入框：
// 1) 纯图片 —— 不拦截事件，原样交给既有图片拖放路径（行为零变化）；
// 2) 文档（非图片文件）—— capture 阶段接管：桌面端能取到真实路径时直接插入 @原路径 引用
//    （零拷贝、不落副本、无大小限制，文件被移动/删除后由读取方报「文件不存在」）；
//    纯浏览器取不到路径时文件原始字节流 POST /dsh-file-attachment/save 落盘到
//    <会话工作区>/.dsh-file-attachment/ → 在草稿光标处插入 @绝对路径 引用；粘贴走同一核心；
// 3) 纯文本粘贴（含目录路径字符串）—— 完全原生，不做任何改写。
// 4) 拖入任何文件时在 capture 阶段拦截应用自带「拖入图片…」DropOverlay 浮层。
// 通知：shell.overlay 浮动 toast（frame-wide，fixed 定位，点击穿透，不破坏布局）。
window.__ModuleLoader__.load({
	id: 'dsh-files-fallback',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const react = require('react')

		// Client 服务依赖：槽位 / 输入机 / 会话。
		// 保存文件不走 remote，而是 fetch POST 宿主 webServer 路由 /dsh-file-attachment/save。
		const inject = [
			"slots",
			"conversation",
			"sessions",
			"locale"
		]

		// ---- 模块级状态：document 监听器 / dock 槽（同步桥）/ overlay 槽（toast）共享 ----
		let ctxRef = null // apply 时记下 ctx，供远程调用与降级判断
		const bridge = {
			shell: null,          // 输入机 shell（insertText/snapshot），来自当前会话
			actions: null,        // InputActions（setDraft/addImages...），来自当前会话
			input: undefined,     // 最新 InputState（draft/phase...），随渲染刷新
			conversation: undefined, // conversation 服务：登记草稿图片
			mounted: false,
			sessionId: '',        // 当前会话 id，宿主据此解析工作区根
			noticeText: null,     // 当前 toast 文本（模块级广播）
			noticeSub: null,      // toast 组件订阅的 setter
		}
		let noticeTimer = null
		const NOTICE_MS = 4000
		const MAX_BYTES = 50 * 1024 * 1024
		const MAX_DIM = 900 // 图片缩放：宽或高任一边 >900 时等比缩小（GIF 例外，原样保动画）
		// 所有文件类型一律允许上传，不再设扩展名白名单；图片同样走统一落盘管线。
		let cleanup = { enabled: false } // 会话清理联动：删除会话时联动清理由该会话上传的落盘附件（host 侧监听 api-session/removed）
		// 多模态识别（VLM）参数：模型可由设置页从 harness 模型目录下拉选取（provider + model）；
		// baseURL/apiKey 留空 = 走 harness 自带模型，填写 = 走该 OpenAI 兼容端点。
		let vlmCfg = { baseURL: '', apiKey: '', model: '', provider: '', thinkingType: 'disabled', timeout: 60 }
		// ---- 劫持 dsh 原生📎按钮（hero / composer 两模式同一 InputBar，按钮都在加号右侧、modes 左侧）----
		// 插件不再渲染自己的上传按钮；而是 capture 阶段拦截原生📎 click，改走本插件文件选择器，
		// ---- 接管 dsh 原生📎：上传入口位于与 dsh 本体完全一致的位置（hero/composer 两模式同一按钮）----
		// 方案：不劫持📎 click（原生 onClick 会打开 dsh 自己的 fileInput，files 可靠），
		// 改为劫持 dsh 原生 fileInput 的 change 事件（元素级监听先于 React 冒泡，stopImmediatePropagation 阻断 onPickFiles），
		// 读 files 后改走本插件 runBatch 管线。修复：自建隐藏 input 的 files 在某些浏览器返回空（count:0）导致上传失效。
		const hijackedInputs = new WeakSet() // 已挂拦截的原生 fileInput
		let uploadBusy = false // 文件选择中防重入
		const nativeFileInputSelector = '[data-composer-card] input[type="file"], [data-composer-card] input[type=file]'
		function onNativeFileChange(e) {
			const el = e.currentTarget
			if (el === null || el === void 0) return
			const list = el.files
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] native fileInput change', { count: list === null ? 0 : list.length })
			if (list === null || list.length === 0) return
			e.preventDefault()
			e.stopImmediatePropagation()
			// FileList 是活对象：el.value='' 会把它清空（length 变 0），必须先快照成数组
			const files = Array.prototype.slice.call(list)
			try { el.value = '' } catch (err) { /* 忽略 */ }
			const images = []
			const docs = []
			for (let i = 0; i < files.length; i++) {
				const f = files[i]
				if (f.type && f.type.indexOf('image/') === 0) { images.push(f); continue }
				docs.push({ path: null, name: f.name, isDir: false, file: f })
			}
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] native change classified', { images: images.length, docs: docs.length })
			if (images.length === 0 && docs.length === 0) return
			uploadBusy = true
			try {
				runBatch(images, docs).catch((err) => {
					console.error('[dsh-file-attachment] runBatch rejected:', err)
					announce('文件处理失败: ' + (err !== null && err !== void 0 && err.message ? err.message : String(err)))
				})
			} finally { uploadBusy = false }
		}
		function hijackFileInput(el) {
			if (hijackedInputs.has(el)) return
			hijackedInputs.add(el)
			el.addEventListener('change', onNativeFileChange)
		}
		// ---- 移动端双📎兼容：dsh-web-mobile 向 conversation.input.left 注入 file-upload 回形针，
		// 其设计前提是 host（0.1.6-alpha.2+）已删除 composer 原生📎；在 0.1.5-rc.x 上该前提不成立——
		// 该代 host 仍渲染原生📎（即 hidden fileInput 的前邻 button），移动端窄屏下两枚并排出现
		//（PC 宽屏被 dsh-web-mobile 的 pointer:fine 隐藏规则覆盖，故仅移动端可见）。
		// 此处按 host 原生📎是否存在对调：原生📎在 → 内联 display:none!important 隐藏 mobile 注入的
		//（压过其 display:grid!important）；原生📎不在（0.1.6+）→ 移除内联声明交还 CSS，保留为唯一入口。
		// 两枚按钮点击后都触发 host 的 hidden fileInput，change 已被本插件劫持走 runBatch，功能不受影响。
		function cardHasNativeClip(card) {
			let inputs
			try { inputs = card.querySelectorAll('input[type="file"], input[type=file]') } catch (err) { return false }
			for (let i = 0; i < inputs.length; i++) {
				const inp = inputs[i]
				if (typeof inp.hidden !== 'undefined' && !inp.hidden) continue // 只认 host 的 hidden fileInput
				let prev = inp.previousElementSibling
				while (prev !== null && prev.tagName !== 'BUTTON') prev = prev.previousElementSibling
				if (prev !== null) return true
			}
			return false
		}
		function reconcileMobileFileUpload() {
			let cards
			try { cards = Array.from(document.querySelectorAll('[data-composer-card]')) } catch (err) { cards = [] }
			for (let i = 0; i < cards.length; i++) {
				const hideMobile = cardHasNativeClip(cards[i])
				let btns
				try { btns = cards[i].querySelectorAll('[data-mobile-nav="file-upload"]') } catch (err) { btns = [] }
				for (let j = 0; j < btns.length; j++) {
					const curHidden = btns[j].style.display === 'none'
					if (hideMobile !== curHidden) btns[j].style.setProperty('display', hideMobile ? 'none' : '', 'important')
				}
			}
		}
		function installNativeAttachHijack() {
			if (typeof document === 'undefined' || document.body === null || document.body === undefined) return
			let body
			try { body = document.body } catch (err) { return }
			if (!(body instanceof Node)) return
			const scan = () => {
				let all = []
				try { all = Array.from(body.querySelectorAll(nativeFileInputSelector)) } catch (err) { all = [] }
				for (let i = 0; i < all.length; i++) hijackFileInput(all[i])
				reconcileMobileFileUpload() // 双📎对调：host 原生📎在则隐藏 dsh-web-mobile 注入的
			}
			scan()
			const mo = new MutationObserver(() => scan())
			try { mo.observe(body, { childList: true, subtree: true }) } catch (err) { /* 忽略 */ }
			// 兜底定时重扫：MutationObserver 偶发漏报（如同一帧内大段替换）时保底
			const timer = setInterval(scan, 1500)
			return { mo, timer }
		}
		// 应用配置：多模态识别参数 + 会话清理联动（文件类型一律放行，无其他可配置项）
		function applyConfig(cfg) {
			vlmCfg = normalizeVlmClient(cfg && (cfg.vlm || cfg.mimo))
			cleanup = { enabled: !!(cfg && cfg.cleanup && cfg.cleanup.enabled === true) }
		}
		// 客户端侧多模态参数规范化（与 host normalizeVlm 一致）：
		// baseURL/apiKey/provider/model 不回退默认（空即未配置），thinkingType/timeout 空值回退默认
		function normalizeVlmClient(raw) {
			const d = { thinkingType: 'disabled', timeout: 60 }
			if (raw === null || typeof raw !== 'object') return { baseURL: '', apiKey: '', model: '', provider: '', thinkingType: d.thinkingType, timeout: d.timeout }
			const pickStr = (k) => (typeof raw[k] === 'string' ? raw[k].trim() : '')
			// 超时（秒）：正整数 1~600，非法回退默认
			const t = Number(raw && raw.timeout)
			const timeout = Number.isFinite(t) && t >= 1 && t <= 600 ? Math.floor(t) : d.timeout
			return { baseURL: pickStr('baseURL'), apiKey: pickStr('apiKey'), model: pickStr('model'), provider: pickStr('provider'), thinkingType: raw.thinkingType === 'enabled' ? 'enabled' : 'disabled', timeout }
		}
		// 拉取持久化配置；成功覆盖默认，失败保留默认。幂等（复用同一 Promise）
		let configPromise = null
		function loadConfig() {
			if (configPromise === null) {
				configPromise = (async () => {
					let cfg = null
					try {
						const r = await fetch('/dsh-file-attachment/config')
						const env = await r.json()
						if (env && env.ok === true && env.value && typeof env.value === 'object') cfg = env.value
					} catch (err) { /* 无配置接口时保留默认 */ }
					if (cfg) applyConfig(cfg)
					return { vlm: vlmCfg, cleanup }
				})()
			}
			return configPromise
		}

		// 查询当前选中模型是否支持图片输入（宿主从 harness 的 llm 解析 inputModalities）。
		// 能力未知 / 接口不可用时放行，避免误拦。结果按短 TTL 缓存，避免每张图都请求。
		let capabilityCache = null
		let capabilityAt = 0
		async function modelSupportsImage() {
			if (capabilityCache !== null && Date.now() - capabilityAt < 15000) return capabilityCache
			try {
				const r = await fetch('/dsh-file-attachment/model-capability')
				const env = await r.json()
				const val = !!(env && env.ok === true && env.supportsImage !== false)
				capabilityCache = val; capabilityAt = Date.now()
				return val
			} catch (err) { return true } // 查询失败按支持放行
		}

		// ---- 通知广播：composer/dock 与 overlay toast 之间共享文本，自动消失 ----
		function publishNotice(text) {
			bridge.noticeText = text
			if (bridge.noticeSub !== null) bridge.noticeSub(text)
		}
		function announce(text) {
			publishNotice(text)
			if (noticeTimer !== null) clearTimeout(noticeTimer)
			noticeTimer = setTimeout(() => { noticeTimer = null; if (bridge.noticeText === text) publishNotice(null) }, NOTICE_MS)
		}

		// ---- 引用即附件 ----
		// 不单独维护"待发送清单"：草稿里插入的 @路径 chip（蓝色）即唯一的事实来源——
		// 它可见、可编辑、可整条删除（本插件在其悬浮时提供 × 按钮），发送后随草稿清空。

		// ---- 宿主保存调用：fetch POST 宿主 webServer 路由----
		// 协议（0.6.4 起）：元数据（name/sessionId）走查询参数（URL 编码），
		// body 直接放 File/Blob —— 浏览器原生分块流式上传，JS 侧不做 base64 拷贝。
		async function saveFileToHost(fileName, data, sessionId) {
			if (typeof fetch !== 'function') throw new Error('当前环境无 fetch，无法上传')
			let response
			try {
				const q = '?name=' + encodeURIComponent(fileName) + '&sessionId=' + encodeURIComponent(sessionId != null ? sessionId : '')
				response = await fetch('/dsh-file-attachment/save' + q, {
					method: 'POST',
					headers: { 'content-type': (data.type && data.type !== '') ? data.type : 'application/octet-stream' },
					body: data,
				})
			} catch (err) {
				throw new Error('无法连接宿主上传服务（网络错误）')
			}
			let envelope
			try {
				envelope = await response.json()
			} catch (err) {
				throw new Error('宿主返回非 JSON（HTTP ' + response.status + '）')
			}
			const record = envelope !== null && typeof envelope === 'object' ? envelope : null
			if (record !== null && record.ok === true && record.value !== null && typeof record.value === 'object') {
				const value = record.value
				if (typeof value.path === 'string' && value.path !== '') return value
				throw new Error('宿主保存返回缺少 path')
			}
			const errMsg = record !== null && typeof record.error === 'string' && record.error !== '' ? record.error : '宿主保存失败（HTTP ' + response.status + '）'
			throw new Error(errMsg)
		}

		// 去重预检（0.7.0 起）：上传前 POST {name,size,sessionId}，命中即复用宿主已有文件（零字节上传）。
		// 任何异常（网络/非 JSON/ok:false/value 非法）一律静默返回 null，降级为正常上传——预检失败绝不阻断附件流程。
		async function precheckOnHost(fileName, size, sessionId) {
			if (typeof fetch !== 'function') return null
			try {
				const response = await fetch('/dsh-file-attachment/precheck', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name: fileName, size, sessionId: sessionId != null ? sessionId : '' }),
				})
				if (!response.ok) return null
				const envelope = await response.json()
				if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) return null
				const value = envelope.value
				if (value !== null && typeof value === 'object' && typeof value.path === 'string' && value.path !== '') return value
				return null
			} catch (err) {
				return null
			}
		}

		// ---- 图片处理：扩展名 / GIF 判定 / 加载 / 缩放（宽或高任一边 >MAX_DIM 时处理，GIF 原样保动画，PNG 保透明） ----
		function fileExt(name) {
			const s = String(name == null ? '' : name)
			const dot = s.lastIndexOf('.')
			return dot > 0 ? s.slice(dot + 1).toLowerCase() : ''
		}
		function isGif(file) {
			const t = String(file && file.type ? file.type : '').toLowerCase()
			return t === 'image/gif' || fileExt(file && file.name) === 'gif'
		}
		function loadImage(url) {
			return new Promise((resolve, reject) => {
				const img = new Image()
				img.onload = () => resolve(img)
				img.onerror = () => reject(new Error('图片解码失败'))
				img.src = url
			})
		}
		// 缩放：宽或高任一边 > maxDim 时等比缩小（两边都不超过 maxDim 时原样）；返回 { data, name }（data 为 Blob/File）。
		// GIF 原样（canvas 取首帧丢动画 + 不支持 gif 输出）；PNG 输出 PNG 保透明；其余 JPEG 0.85。
		// 缩放失败/无需缩放时回退原文件。
		async function downscaleImage(file, maxDim) {
			if (isGif(file)) return { data: file, name: file.name }
			let url = ''
			try {
				url = URL.createObjectURL(file)
				const img = await loadImage(url)
				const w = img.naturalWidth || img.width || 0
				const h = img.naturalHeight || img.height || 0
				if (!w || !h) return { data: file, name: file.name }
				const scale = Math.min(1, maxDim / Math.max(w, h))
				if (scale >= 1) return { data: file, name: file.name } // 已够小，原样
				const nw = Math.max(1, Math.round(w * scale))
				const nh = Math.max(1, Math.round(h * scale))
				const canvas = document.createElement('canvas')
				canvas.width = nw
				canvas.height = nh
				canvas.getContext('2d').drawImage(img, 0, 0, nw, nh)
				const isPng = String(file.type || '').toLowerCase() === 'image/png' || fileExt(file.name) === 'png'
				const mime = isPng ? 'image/png' : 'image/jpeg'
				const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.85))
				if (!blob) return { data: file, name: file.name }
				// 输出 mime 决定扩展名（png→.png，jpeg→.jpg）；文件名主体保留
				const base = file.name.lastIndexOf('.') > 0 ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name
				const name = base + (mime === 'image/png' ? '.png' : '.jpg')
				return { data: blob, name }
			} catch (err) {
				return { data: file, name: file.name } // 缩放失败回退原文件
			} finally {
				if (url !== '') URL.revokeObjectURL(url)
			}
		}

		// 目录/文件引用的 @路径 文本格式（含引号形式）：
		// 目录补尾斜杠；含不可表示字符返回 undefined；含空白走引号形式（目录引号保持开启）
		function hasBadChar(p) {
			for (let i = 0; i < p.length; i++) {
				const c = p.charCodeAt(i)
				if (c === 34 || c < 32 || (c >= 127 && c <= 159)) return true
			}
			return false
		}
		// 等价于 /\s/u 的空白判定（含不可见分隔符）
		function isSpace(c) {
			return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760
				|| (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
		}
		function formatMention(path, isDir) {
			const p = isDir ? path + '/' : path
			if (hasBadChar(p)) return undefined
			for (let i = 0; i < p.length; i++) {
				if (isSpace(p.charCodeAt(i))) return isDir ? '@"' + p : '@"' + p + '"'
			}
			return '@' + p
		}

		// 把浏览器提供的路径源（webkitGetAsEntry().fullPath / file.path）规范化为绝对路径
		function isDrivePath(p) {
			if (p.length < 3) return false
			const c0 = p.charCodeAt(0); const c1 = p.charCodeAt(1); const c2 = p.charCodeAt(2)
			const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)
			return isLetter && c1 === 58 && (c2 === 47 || c2 === 92)
		}
		function resolveDropPath(raw) {
			if (typeof raw !== 'string' || raw === '') return null
			// Chrome 虚拟文件系统会给盘符路径加前导斜杠：/C:/... 或 /C:\...
			let p = raw
			if (p.length > 3 && p.charCodeAt(0) === 47 && p.charCodeAt(2) === 58
				&& (p.charCodeAt(3) === 47 || p.charCodeAt(3) === 92)) p = p.slice(1)
			if (isDrivePath(p) || (p.length > 0 && p.charCodeAt(0) === 47)) return p
			return null
		}
		// 取路径最后一段（等价 split(/[\\/]/).filter(Boolean).pop()，charCode 版防转义损坏）
		function lastSegment(s) {
			let seg = ''
			let cur = ''
			for (let i = 0; i < s.length; i++) {
				const c = s.charCodeAt(i)
				if (c === 47 || c === 92) { if (cur !== '') { seg = cur; cur = '' } }
				else cur += s.charAt(i)
			}
			if (cur !== '') seg = cur
			return seg
		}

		// 输入机快照读取：兼容两代 dsh。
		// 旧版（纯文本机，alpha.2 之前）：shell.snapshot 直接是 InputState；
		// 新版（Lexical composer，alpha.2 起）：shell.state 是 SnapshotStore，经
		// getSnapshot() 取值（字段不变：draft/draftRev/phase/occurrences）。
		function readShellSnapshot(shell) {
			if (shell === null || shell === void 0) return undefined
			const st = shell.state
			if (st !== null && st !== void 0 && typeof st.getSnapshot === 'function') {
				return st.getSnapshot()
			}
			return shell.snapshot
		}

		// 找可写的 composer 输入表面：可见、未禁用、未只读、phase 为 plain；
		// 多个候选时优先文本与桥内草稿一致的那一个（排除审批弹窗里的同名元素）。
		// 双代兼容：旧版 textarea（[data-composer-card] textarea）；
		// 新版 Lexical contenteditable（[data-composer-card] [data-composer-input]）。
		function findComposerInput() {
			const list = Array.from(document.querySelectorAll('[data-composer-card] textarea, [data-composer-card] [data-composer-input]'))
			const live = list.filter((ta) => {
				if (ta.disabled || ta.readOnly) return false
				const phase = ta.getAttribute('data-phase')
				if (phase !== null && phase !== 'plain') return false
				return ta.getClientRects().length > 0
			})
			if (live.length === 0) return null
			const draft = bridge.input !== void 0 ? bridge.input.draft : undefined
			const textOf = (el) => (el.tagName === 'TEXTAREA' ? el.value : (el.textContent || ''))
			if (typeof draft === 'string') {
				for (let i = 0; i < live.length; i++) {
					if (textOf(live[i]) === draft) return live[i]
				}
			}
			return live[0]
		}

		// 在光标（或选区）处插入文本；setDraft 是唯一的草稿写路径
		function insertTextAtCaret(ta, actions, text) {
			const draft = ta.value
			let start = ta.selectionStart
			let end = ta.selectionEnd
			if (typeof start !== 'number' || start < 0 || start > draft.length) start = draft.length
			if (typeof end !== 'number' || end < start) end = start
			const before = draft.slice(0, start)
			const after = draft.slice(end)
			const padStart = before.length > 0 && !isSpace(before.charCodeAt(before.length - 1)) ? ' ' : ''
			const padEnd = after.length > 0 && !isSpace(after.charCodeAt(0)) ? ' ' : ''
			const next = before + padStart + text + padEnd + after
			const caret = start + padStart.length + text.length + padEnd.length
			actions.setDraft(next)
			// React 重渲染会覆盖光标，下一帧校验写入成功后回填 selectionRange（同既有输入路径模式）
			if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
				window.requestAnimationFrame(() => {
					if (ta.value !== next) return // 写入被输入机拒绝，不动光标
					try {
						ta.focus({ preventScroll: true })
						ta.setSelectionRange(caret, caret)
					} catch (err) { /* 忽略：光标回填失败不影响草稿内容 */ }
				})
			}
		}

		function hasFiles(dataTransfer) {
			const types = dataTransfer && dataTransfer.types
			if (!types) return false
			for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
			return false
		}

		// 触发应用自身 drop 浮层的关闭：应用在 window 上监听 dragend 执行 reset()。
		// 从 OS 拖入时浏览器不派发 dragend，且我们拦截 drop 后应用的 drop 监听收不到事件，浮层会残留。
		function dismissDropOverlay() {
			try { window.dispatchEvent(new Event('dragend')) } catch (err) { /* 尽力而为 */ }
		}

		// capture 阶段拦截 dragenter：应用自身 DropOverlay 文案固定为「拖入图片…」，
		// 拖入任何文件都会误提示；这里阻止应用注册的 dragenter 监听执行。
		function onDragEnterCap(e) {
			const dt = e.dataTransfer
			if (dt === null || dt === undefined || !hasFiles(dt)) return
			e.preventDefault()
			e.stopImmediatePropagation()
		}

		// 拖放/粘贴文件共用核心。source：'drop' | 'paste'
		// 返回是否已接管事件（false = 纯图片拖放/粘贴，原样交给既有图片路径）
		function handleFilesEvent(e, files, items, source) {
			const images = []
			const docs = [] // { path, name, isDir, file }
			for (let i = 0; i < files.length; i++) {
				const file = files[i]
				// File.type 在剪贴板截图场景下可能为空（浏览器未填充 MIME）；
				// 回退到 DataTransferItem.type 判定，并创建带正确 MIME 的 File 副本，
				// 确保 createDrafts 的 imageMediaType 校验通过。
				const effType = file.type || ((items && items[i]) ? items[i].type : '') || ''
				if (effType.indexOf('image/') === 0) {
					// file.type 为空时用 items[i].type 补全，生成新 File 对象
					images.push(file.type ? file : new File([file], file.name || 'image.png', { type: effType }))
					continue
				}
				let entry = null
				const item = items ? items[i] : null
				if (item && typeof item.webkitGetAsEntry === 'function') {
					try { entry = item.webkitGetAsEntry() } catch (err) { entry = null }
				}
				let raw = entry ? entry.fullPath : null
				if (raw === null || raw === undefined) raw = file.path !== void 0 ? file.path : null
				const isDir = !!(entry && entry.isDirectory)
				let name = file.name
				if (name === '' && typeof raw === 'string') { const seg = lastSegment(raw); if (seg !== '') name = seg }
				docs.push({ path: resolveDropPath(raw), name, isDir, file })
			}

			// 无输入桥（hero/blank 未就绪）：纯图片交原生图片路径保留行为；含文档则提示不可用
			if (bridge.shell === null) {
				if (docs.length === 0) return false
				e.preventDefault()
				e.stopImmediatePropagation()
				dismissDropOverlay()
				announce('输入框不可用')
				return true
			}
			// 有输入桥：接管全部（图片与文档统一落盘 → @路径 纯文本，方案 B 绕开 dsh image 能力检查）
			e.preventDefault()
			e.stopImmediatePropagation()
			dismissDropOverlay()
			void runBatch(images, docs)
			return true
		}

		// 在草稿末尾插入 @路径 file-chip（label=短文件名显示，clipboardText=@完整路径发送）。
		// runBatch 图片/文档两分支共用的插入核心（原两处各持一份同款逻辑，现收敛于此）。
		// isFolder=true → appearance:'folder'（DSH 原生文件夹图标 chip，与 @path/ 尾斜杠语法配套）。
		function insertChipAtEnd(shell, name, clipboardText, isFolder) {
			// 每次插入前重取 snapshot（draftRev 随插入递增，span 取当前末尾）
			const snap = readShellSnapshot(shell)
			// 前导分隔空格：聊天记录对 @引用 的 file-chip 渲染（projectUserText）
			// 要求 @ 前是行首或空白；纯文本 @路径 也遵循同样边界。
			// 草稿末尾紧贴文字时先补一格，否则发送后聊天记录显示裸 @路径。
			if (snap !== void 0 && typeof snap.draft === 'string' && snap.draft !== ''
				&& !isSpace(snap.draft.charCodeAt(snap.draft.length - 1))) {
				const leadSpan = { draftRev: snap.draftRev, start: snap.draft.length, end: snap.draft.length }
				if (typeof shell.insertText === 'function') {
					try { shell.insertText(' ', leadSpan) } catch (err) { /* 忽略：补空格失败不阻塞插入 */ }
				} else if (typeof shell.setDraft === 'function') {
					try { shell.setDraft(snap.draft + ' ') } catch (err) { /* 忽略 */ }
				}
			}
			// 补空格会递增 draftRev，重新取快照后再定插入 span。
			// 关键：insertText 的 span 是 detect 坐标（编辑器实际节点坐标），
			// draft.length 是投影坐标，纯文本机下两者一致；仍优先 shell.caretSpan()
			// 拿 detect 坐标（有光标返回光标处，否则返回文档末尾），与历史行为对齐。
			const snap2 = readShellSnapshot(shell)
			let span
			if (typeof shell.caretSpan === 'function') {
				try {
					const cs = shell.caretSpan()
					span = { draftRev: snap2.draftRev, start: cs.start, end: cs.end }
				} catch (err) {
					span = { draftRev: snap2.draftRev, start: snap2.draft.length, end: snap2.draft.length }
				}
			} else {
				span = { draftRev: snap2.draftRev, start: snap2.draft.length, end: snap2.draft.length }
			}
			// chip 插入：label=短文件名（显示用），clipboardText=@完整路径（发送用）
			// 目录用原生 appearance:'folder'（文件夹图标），与 @path/ 尾斜杠语法配套
			return shell.insertReference({ source: 'reference', ref: clipboardText, label: name, appearance: isFolder === true ? 'folder' : 'file', clipboardText: clipboardText }, span)
		}

		// 异步批处理：桌面端（能取真实路径）一律 @原路径 引用；纯浏览器才落盘 → shell.insertReference
		// chip（label=短文件名显示，clipboardText=@完整路径发送）。
		// 图片走 @路径 文本引用（由支持多模态的当前模型自行读取，或经 describe_image 工具走 VLM）；
		// 目录走 @路径 引用；所有文件类型一律放行。
		async function runBatch(images, docs) {
			// 当前模型不支持多模态时：配了 VLM → 仍可上传（host 的 describe_image 兜底识别）；
			// 未配 VLM → 仅拦截图片（文档/代码走 @路径 文本引用，不依赖多模态能力）
			if (images.length > 0) {
				const supportsImage = await modelSupportsImage()
				if (!supportsImage) {
					const vlmReady = vlmCfg.model !== '' && (vlmCfg.baseURL === '' || (vlmCfg.baseURL !== '' && vlmCfg.apiKey !== ''))
					if (!vlmReady) {
						announce('当前模型不支持多模态，且未配置视觉模型（设置→文件附件）')
						images = []
						if (docs.length === 0) return
					}
				}
			}
			const shell = bridge.shell
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] runBatch start', { images: images.length, docs: docs.length, shell: shell === null ? 'null' : 'ok', mounted: bridge.mounted })
			if (shell === null || typeof shell.insertReference !== 'function') {
				announce(`输入框不可用 [mounted:${bridge.mounted} shell:${shell === null ? 'null' : 'ok'} addImg:${typeof bridge.addImages}]`)
				return
			}
			const snap0 = readShellSnapshot(shell)
			const phase = snap0 ? snap0.phase : 'plain'
			if (phase !== 'plain' && phase !== 'command' && phase !== 'claimed') {
				announce('输入框正忙')
				return
			}
			// 汇总待上传项：图片与所有文件类型一律放行；目录走 @路径 引用
			// 桌面壳经 __DSH_HOST_PATHS__.pathFor（Electron webUtils.getPathForFile）能拿到真实 OS 路径；
			// 有它就不必走浏览器上传，直接引用原文件（零拷贝、不受 50MB 限制；拖目录时即文件夹路径）。
			const hostPaths = (typeof window !== 'undefined' && window.__DSH_HOST_PATHS__) || null
			function realPathOf(f) {
				if (f === null || f === void 0) return null
				try { return (hostPaths && typeof hostPaths.pathFor === 'function' ? hostPaths.pathFor(f) : null) || null } catch (err) { return null }
			}
			const items = []
			for (let i = 0; i < docs.length; i++) {
				const d = docs[i]
				items.push({ file: d.file, name: d.name, isImage: false, isDir: d.isDir, refPath: realPathOf(d.file) })
			}
			for (let i = 0; i < images.length; i++) items.push({ file: images[i], name: images[i].name, isImage: true, isDir: false, refPath: realPathOf(images[i]) })
			// 桌面端能取到真实路径（Electron webUtils）→ 一律 @原路径 引用：零拷贝、不占额外磁盘、
			// 无大小限制；原文件被移动/删除后由读取方报「文件不存在」。仅纯浏览器等取不到路径的
			// 环境才上传副本到 <工作区>/.dsh-file-attachment/（50MB 上限、同名 -N、同内容去重）。
			function activateChipPath(sh) {
				try { if (sh && typeof sh.activatePath === 'function') sh.activatePath() } catch (err) { /* 忽略 */ }
			}
			function refEntry(label, refPath, flg, isDir) {
				if (typeof refPath !== 'string' || refPath === '') return false
				// 目录按 dsh file-reference 语法补尾斜杠：聊天区 refChip 据此识别为文件夹并显示文件夹图标
				const m = formatMention(refPath, isDir === true)
				const mention = m !== void 0 ? m : '@' + refPath + (isDir === true ? '/' : '')
				if (insertChipAtEnd(shell, label, mention, isDir === true)) {
					activateChipPath(shell)
					if (flg) flg.add(true)
					return true
				}
				return false
			}
			function refUsable(it) { return it !== null && it !== void 0 && typeof it.refPath === 'string' && it.refPath !== '' }
			const pending = []
			let dirRejected = 0
			let refInserted = 0
			const refCounter = { add: () => { refInserted += 1 } }
			for (let i = 0; i < items.length; i++) {
				const it = items[i]
				if (it.isDir) {
					if (refUsable(it)) refEntry(it.name, it.refPath, refCounter, true)
					else dirRejected += 1
					continue
				}
				// 能取到真实路径 → @原路径 引用；取不到才进入上传管线（文件类型一律放行）
				if (refUsable(it)) { refEntry(it.name, it.refPath, refCounter, false); continue }
				pending.push(it)
			}
			if (pending.length === 0) {
				if (refInserted > 0) { announce(refInserted + ' 个已按 @路径引用'); return }
				if (dirRejected > 0) { announce('不支持拖入目录'); return }
				return
			}
			let inserted = 0
			let failed = 0
			for (let i = 0; i < pending.length; i++) {
				const it = pending[i]
				try {
					if (it.isImage) {
						// 图片：落盘前等比缩小（宽或高任一边 >MAX_DIM 才处理；GIF 原样保动画），
						// 再走 @路径 纯文本引用（方案 B：不触发 dsh 的 image 能力检查）
						const sized = await downscaleImage(it.file, MAX_DIM)
						const data = sized.data
						const name = sized.name
						if (data === null || typeof data.size !== 'number' || data.size === 0) throw new Error('size')
						if (data.size > MAX_BYTES) throw new Error('size')
						if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] before saveFileToHost', { name, size: data.size })
						// 去重预检（键=name+size，与 save 落盘名/字节一致：图片此处传的是缩放后的名与体积）
						const hitImage = await precheckOnHost(name, data.size, bridge.sessionId)
						if (hitImage !== null && typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] dedup hit', hitImage.path)
						const res = hitImage !== null ? hitImage : await saveFileToHost(name, data, bridge.sessionId)
						if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] saved', res.path)
						const m = formatMention(res.path, false)
						const clipboardText = m !== undefined ? m : '@' + res.path
						const okInsert = insertChipAtEnd(shell, name, clipboardText)
						if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] image insertReference result', { ok: okInsert, name, clipboardText })
						if (okInsert) inserted += 1
						else failed += 1
						continue
					}
					// 文档：原样落盘 → @路径 纯文本（先走去重预检，命中零字节上传）
					const data = it.file
					const name = it.name
					// 超上限/空文件：不再抛错弹「文件处理失败」，改为直接引用原文件路径
					if (data === null || typeof data.size !== 'number' || data.size === 0) {
						if (refEntry(name, it.refPath, null, it.isDir === true)) { inserted += 1; continue }
						throw new Error('size')
					}
					if (data.size > MAX_BYTES) {
						if (refEntry(name, it.refPath, null, it.isDir === true)) { inserted += 1; continue }
						throw new Error('size')
					}
					const hitDoc = await precheckOnHost(name, data.size, bridge.sessionId)
					if (hitDoc !== null && typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] dedup hit', hitDoc.path)
					const res = hitDoc !== null ? hitDoc : await saveFileToHost(name, data, bridge.sessionId)
					const m = formatMention(res.path, false)
					const clipboardText = m !== undefined ? m : '@' + res.path
					const okInsert = insertChipAtEnd(shell, name, clipboardText)
					if (okInsert) inserted += 1
					else failed += 1
				} catch (err) {
					// 失败兜底：能拿到真实路径就贴 @路径（不弹失败提示），否则计入 failed
					if (refEntry(it && it.name, it && it.refPath, null, !!(it && it.isDir))) { inserted += 1; continue }
					failed += 1
					if (typeof console !== 'undefined' && console.error) console.error('[dsh-file-attachment] item failed', { name: it && it.name, isImage: it && it.isImage, error: err instanceof Error ? (err.message + '\n' + (err.stack || '')) : String(err) })
				}
			}
			if (inserted === 0 && refInserted === 0) {
				if (dirRejected > 0 && failed === 0) { announce('不支持拖入目录'); return }
				announce('文件处理失败')
				return
			}
			// refInserted 也算成功：不再落进「文件处理失败」分支
			const skipped = failed
			if (skipped > 0) announce((inserted + refInserted) + ' 个已插入 · ' + skipped + ' 个已跳过')
		}

		// document 级 drop（capture）：保证先于图片路径的 document 级 bubble 监听器执行
		function onDrop(e) {
			const dt = e.dataTransfer
			if (!dt || !hasFiles(dt)) return
			const files = Array.prototype.slice.call(dt.files)
			if (files.length === 0) return
			handleFilesEvent(e, files, dt.items, 'drop')
		}

		// document 级 paste（capture）：仅当粘贴目标就是 composer 输入表面时接管文件；
		// 纯文本（含目录路径字符串）完全原生，不改写。
		function onPaste(e) {
			const t = e.target
			const ta = findComposerInput()
			if (ta === null || (t !== ta && !(ta.contains && ta.contains(t)))) return
			const cd = e.clipboardData
			if (cd === null || cd === void 0) return
			const files = Array.prototype.slice.call(cd.files)
			if (files.length > 0) {
				handleFilesEvent(e, files, cd.items, 'paste')
				return
			}
			// 纯文本：不干预，走原生行为
		}

		// shell.overlay 槽：frame-wide 浮动层（官方定位：badge / toast / status pill）。
		// 通知在此渲染为底部浮动 toast，自动消失、点击穿透、不破坏布局。
		function FaToast(props) {
			const state = react.useState(null)
			const text = state[0]
			const setText = state[1]
			react.useEffect(() => {
				if (bridge.noticeText !== null) setText(bridge.noticeText)
				bridge.noticeSub = setText
				if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] FaToast mounted')
				return () => { if (bridge.noticeSub === setText) bridge.noticeSub = null }
			})
			if (text === null || text === '') return null
			return react.createElement('div', {
				style: {
					position: 'fixed',
					bottom: '24px',
					left: '50%',
					transform: 'translateX(-50%)',
					zIndex: 2000,
					maxWidth: 'min(640px, calc(100vw - 48px))',
					background: 'rgba(20, 24, 35, 0.92)',
					color: '#f2f4f8',
					padding: '10px 16px',
					borderRadius: '10px',
					fontSize: '13px',
					lineHeight: '1.5',
					boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
					pointerEvents: 'none',
				},
			}, text)
		}

		// input.dock 槽：比 composer.dock 更早且不受 hero（首轮空白无底部栏）限制，
		// 仅同步桥（actions/input/sessionId/conversation），不渲染可见文本。
		function FaBridge(props) {
			const sessionId = props.sessionId !== void 0 ? props.sessionId : ''
			// inject 只传 sessionId（string 可靠）；shell/addImages 由本组件经 ctxRef 自行计算（dsh slot 对 inject 返回的 object/function 会丢失）
			let shell = null
			let addImages = null
			try {
				const ctx = ctxRef
				if (ctx !== null && sessionId !== '') {
					const conversation = ctx.get('conversation')
					const actx = ctx.sessions.scope(sessionId)
					if (conversation !== void 0 && actx !== void 0) {
						shell = conversation.input.for(actx)
						if (shell !== null) {
							// 不再注册 dsh 原生附件（createDrafts + addAttachments 会导致原生附件条重复显示）
							// 插件按 @路径 chip 引用，附件条槽不接管（灰色药丸已移除，避免与草稿 chip 重复）
							addImages = (files) => { return null }
						}
					}
				}
			} catch (err) { shell = null; addImages = null }
			const input = readShellSnapshot(shell)
			react.useEffect(() => {
				bridge.shell = shell
				bridge.addImages = addImages
				bridge.input = input
				bridge.sessionId = sessionId
				bridge.mounted = true
				return () => {
					bridge.shell = null
					bridge.addImages = null
					bridge.input = undefined
					bridge.sessionId = ''
					bridge.mounted = false
				}
			})
			return null
		}

		// 文件类型图标：文档轮廓 SVG + 扩展名缩写（颜色继承 currentColor）
		function fileGlyph(name) {
			const ext = (fileExt(name) || '').toUpperCase().slice(0, 4) || 'FILE'
			return react.createElement('svg', { width: 18, height: 20, viewBox: '0 0 18 20', 'aria-hidden': true, style: { display: 'block' } },
				react.createElement('path', { d: 'M3 1h8l4 4v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z', fill: 'rgba(128,128,128,0.22)', stroke: 'currentColor', strokeWidth: 1 }),
				react.createElement('path', { d: 'M11 1v4h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1 }),
				react.createElement('text', { x: 9, y: 14, textAnchor: 'middle', fontSize: 5.5, fill: 'currentColor', fontFamily: 'monospace' }, ext),
			)
		}
		// 文件夹图标（蓝色线性 folder，尺寸自定；对齐 WorkBuddy 目录 chip 的观感）
		function folderGlyph(size) {
			return react.createElement('svg', { width: size, height: size, viewBox: '0 0 16 17', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, style: { display: 'block', color: '#30ACFF' } },
				react.createElement('path', { d: 'M3.5 5C3.5 4.72386 3.71208 4.5 3.97368 4.5H6.81579L8 6H12.0263C12.2879 6 12.5 6.22385 12.5 6.5V12C12.5 12.2761 12.2879 12.5 12.0263 12.5H3.97368C3.71208 12.5 3.5 12.2761 3.5 12V5Z', stroke: 'currentColor', strokeWidth: 0.975, strokeLinejoin: 'round' }),
			)
		}

		// ---- 草稿内 @引用 chip 的删除按钮（×）----
		// ---- 草稿 @引用 chip 的删除按钮（×）----
		// 草稿里的蓝色 chip 是宿主 Lexical 的原子节点 ReferenceChipNode，原生不带删除控件。
		// 这里沿用旧「灰色药丸」的交互补一个 ×：悬停 chip 时在其右侧浮出，点击即删除该引用。
		// 删除路径（按可靠性排序）：
		//  1) 用 Lexical 实例精确 remove() 该 chip 节点（只删这一颗）；
		//  2) 拿不到节点时，按该 chip 的 @完整路径 文本清理草稿。
		const CHIP_SELECTOR = '[data-composer-chip]'
		// 找到 chip 所在的 Lexical 编辑器实例（宿主把 editor 挂在 contenteditable 根节点上）
		function lexicalEditorOf(el) {
			let n = el
			while (n !== null && n !== void 0 && n.nodeType === 1) {
				if (n.__lexicalEditor !== null && n.__lexicalEditor !== void 0) return n.__lexicalEditor
				n = n.parentElement
			}
			return null
		}
		// 取该 chip 的节点 key。注意 Lexical 是把它存成 **JS 属性**（el['__lexicalKey_<editorKey>'] = key），
		// 不是 HTML attribute，所以必须读属性而不是 getAttribute。
		function chipKeyOf(editor, el) {
			const editorKey = editor !== null && editor !== void 0 ? editor._key : null
			if (typeof editorKey !== 'string' || editorKey === '') return null
			const prop = '__lexicalKey_' + editorKey
			try {
				let n = el
				while (n !== null && n !== void 0 && n.nodeType === 1) {
					const k = n[prop]
					if (typeof k === 'string' && k !== '') return k
					n = n.parentElement
				}
				// 兜底：nodeKey → DOM 的反查表
				const map = editor._keyToDOMMap
				let found = null
				if (map !== null && map !== void 0 && typeof map.forEach === 'function') {
					map.forEach((dom, k) => {
						if (found !== null || dom === null || dom === void 0) return
						if (dom === el) found = k
						else if (typeof dom.contains === 'function' && dom.contains(el)) found = k
					})
				}
				return found
			} catch (err) { return null }
		}
		// 取该 chip 的持久化文本（@完整路径）。chip 显示的是 label，路径只存在节点里。
		function chipClipboardText(editor, key) {
			if (editor === null || key === null) return null
			let out = null
			try {
				// 注意：editor.update(fn) 的回调不接收 state 参数，必须自己取 pending/当前状态。
				const state = editor._pendingEditorState !== null && editor._pendingEditorState !== void 0
					? editor._pendingEditorState
					: (typeof editor.getEditorState === 'function' ? editor.getEditorState() : null)
				const map = state !== null && state !== void 0 ? state._nodeMap : null
				const node = map !== null && map !== void 0 && typeof map.get === 'function' ? map.get(key) : null
				if (node !== null && node !== void 0 && typeof node.__clipboardText === 'string') out = node.__clipboardText
			} catch (err) { out = null }
			return out
		}
		// 删除一颗 chip 节点（Lexical 精确移除）。editor.update 的回调无参数，故状态自行获取。
		function removeChipNode(editor, key) {
			if (editor === null || key === null || typeof editor.update !== 'function') return false
			let removed = false
			try {
				editor.update(() => {
					const state = editor._pendingEditorState !== null && editor._pendingEditorState !== void 0
						? editor._pendingEditorState
						: (typeof editor.getEditorState === 'function' ? editor.getEditorState() : null)
					const map = state !== null && state !== void 0 ? state._nodeMap : null
					const node = map !== null && map !== void 0 && typeof map.get === 'function' ? map.get(key) : null
					if (node !== null && node !== void 0 && typeof node.remove === 'function') { node.remove(); removed = true }
				}, { discrete: true })
			} catch (err) { return false }
			return removed
		}
		// 回退：按 chip 的 @路径 文本定位并删除草稿中的这一处引用
		function removeDraftRefText(text) {
			const shell = bridge.shell
			if (shell === null || typeof text !== 'string' || text === '') return false
			if (typeof shell.setDraft !== 'function') return false
			const bare = text.replace(/^@/u, '').replace(/[\\/]+$/u, '')
			const forms = [
				{ token: '@' + bare, len: bare.length + 1 },
				{ token: '@' + bare + '/', len: bare.length + 2 },
				{ token: '@"' + bare + '"', len: bare.length + 3 },
				{ token: '@"' + bare + '/"', len: bare.length + 4 },
			]
			const snap = readShellSnapshot(shell)
			if (snap === null || snap === void 0 || typeof snap.draft !== 'string') return false
			if (snap.phase === 'adjudicating' || snap.phase === 'submitting') return false
			const draft = snap.draft
			for (const f of forms) {
				for (let i = 0; i <= draft.length; i++) {
					const p = draft.indexOf(f.token, i)
					if (p === -1) break
					if (p !== 0 && !/\s/.test(draft[p - 1])) continue
					let end = p + f.len
					if (draft.charCodeAt(end) === 32) end += 1 // 吃掉插入时补的空格
					shell.setDraft(draft.slice(0, p) + draft.slice(end))
					return true
				}
			}
			return false
		}
		// 删除一颗 chip：先精确删节点，失败再按文本清理；失败时把诊断信息打到控制台便于排查
		function removeChip(el) {
			const editor = lexicalEditorOf(el)
			const key = chipKeyOf(editor, el)
			const text = chipClipboardText(editor, key)
			const nodeRemoved = removeChipNode(editor, key)
			if (nodeRemoved) return true
			if (text !== null && removeDraftRefText(text)) return true
			if (typeof console !== 'undefined' && console.warn) {
				console.warn('[dsh-file-attachment] chip remove failed', {
					hasEditor: editor !== null,
					editorKey: editor !== null && editor !== void 0 ? editor._key : null,
					nodeKey: key,
					clipboardText: text,
					hasShell: bridge.shell !== null,
					canSetDraft: !!(bridge.shell !== null && typeof bridge.shell.setDraft === 'function'),
				})
			}
			return false
		}
		// 给一颗 chip 挂上 × —— 只把左侧那个「字形」（文件图标 或 前导 @ 标记）换成 ×：
		// 悬停时字形隐藏、× 显示在同一位置，文件名始终保留；移开后恢复原字形。
		// 幂等以「按钮是否真的还在 DOM 里」为准（宿主重渲染可能重建 chip 内部 DOM）。
		function decorateChip(el) {
			if (el === null || el === void 0 || el.nodeType !== 1) return
			if (typeof el.querySelector !== 'function') return
			if (el.querySelector('[data-dsh-fa-chip-x]') !== null) return
			// 只取「字形叶子」：优先 svg（文件/文件夹图标）；没有 svg 时取纯文本的前导 @ 标记。
			// 关键：绝不能取 svg.parentElement —— 宿主把 svg 与文件名放在同一个 inline-flex
			// 容器里（.chip{display:inline-flex}），隐藏它会连文件名一起抹掉。
			const glyphOf = () => {
				try {
					const svg = el.querySelector('svg')
					if (svg !== null) return svg
					const spans = el.querySelectorAll('span')
					for (let i = 0; i < spans.length; i++) {
						const s = spans[i]
						if (s.children !== null && s.children.length === 0 && String(s.textContent == null ? '' : s.textContent).trim() === '@') return s
					}
				} catch (err) { /* 忽略 */ }
				return null
			}
			const btn = document.createElement('span')
			btn.setAttribute('data-dsh-fa-chip-x', '')
			btn.setAttribute('role', 'button')
			btn.setAttribute('title', '移除该引用')
			btn.textContent = '×'
			// 外观对齐原生字形：透明底、继承 chip 文字色；用 visibility 控制可点性（隐藏时不响应鼠标）
			btn.style.cssText = [
				'position:absolute', 'left:0', 'top:0',
				'display:inline-flex', 'align-items:center', 'justify-content:center',
				'width:14px', 'height:14px', 'border-radius:4px',
				'background:transparent', 'color:inherit',
				'font-size:14px', 'line-height:1', 'font-weight:500',
				'cursor:pointer', 'opacity:0', 'visibility:hidden',
				'transition:opacity .1s ease', 'z-index:5', 'user-select:none',
			].join(';')
			let hiddenGlyph = null
			const show = () => {
				const glyph = glyphOf()
				if (glyph !== null && hiddenGlyph !== glyph) {
					if (hiddenGlyph !== null && hiddenGlyph.style !== null) hiddenGlyph.style.visibility = ''
					glyph.style.visibility = 'hidden'
					hiddenGlyph = glyph
				}
				// 把 × 精确叠在被隐藏的字形上（visibility:hidden 不改变布局，故仍能量到位置）。
				// 量不到（未布局、分离节点）时保留默认左端位置，避免跳到 0,0。
				try {
					if (glyph !== null && typeof el.getBoundingClientRect === 'function') {
						const chipRect = el.getBoundingClientRect()
						const gr = glyph.getBoundingClientRect()
						if (gr.height > 0 && chipRect.height > 0) {
							const size = Math.max(12, Math.round(gr.height))
							btn.style.width = size + 'px'
							btn.style.height = size + 'px'
							btn.style.left = Math.round(gr.left - chipRect.left) + 'px'
							btn.style.top = Math.round(gr.top - chipRect.top) + 'px'
						}
					}
				} catch (err) { /* 忽略：量不到就用默认位置 */ }
				btn.style.visibility = 'visible'
				btn.style.opacity = '1'
			}
			const hide = () => {
				btn.style.opacity = '0'
				btn.style.visibility = 'hidden'
				if (hiddenGlyph !== null && hiddenGlyph.style !== null) {
					hiddenGlyph.style.visibility = ''
					hiddenGlyph = null
				}
			}
			// × 不含背景块、纯粹替换图标：鼠标进入 chip 区域即显示，离开才隐藏。
			// 用 relatedTarget 判断是否真的离开 chip（含其子元素），避免在 chip 内移动时闪隐。
			const onLeave = (ev) => {
				const to = ev !== null && ev !== void 0 ? ev.relatedTarget : null
				if (to !== null && to !== void 0 && typeof el.contains === 'function' && el.contains(to)) return
				hide()
			}
			el.addEventListener('mouseenter', show)
			el.addEventListener('mouseleave', onLeave)
			btn.addEventListener('mouseenter', show)
			btn.addEventListener('mouseleave', onLeave)
			// 阻止抢焦点 / 触发宿主编辑器的选区操作
			btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation() })
			btn.addEventListener('click', (ev) => {
				ev.preventDefault()
				ev.stopPropagation()
				if (removeChip(el)) return
				hide()
				announce('无法删除该引用，请把光标移到 chip 后按退格')
			})
			// chip 宿主元素需要成为定位上下文（× 是 absolute，不参与 inline-flex 布局，
			// 不会挤动字形与文件名）。已有 static 以外的定位则保持不变。
			try {
				if (typeof el.style === 'object' && el.style !== null && el.style.position === '') el.style.position = 'relative'
			} catch (err) { /* 忽略 */ }
			el.appendChild(btn)
		}
		// 扫描并装饰当前所有 chip
		function decorateAllChips(root) {
			const scope = root !== null && root !== void 0 && root.nodeType === 1 ? root : (typeof document !== 'undefined' ? document : null)
			if (scope === null) return
			try {
				if (scope.matches !== undefined && scope.matches(CHIP_SELECTOR)) decorateChip(scope)
				const list = scope.querySelectorAll !== undefined ? scope.querySelectorAll(CHIP_SELECTOR) : []
				for (let i = 0; i < list.length; i++) decorateChip(list[i])
			} catch (err) { /* 忽略：扫描失败不影响宿主 */ }
		}
		let chipObserver = null
		let chipSweepTimer = null
		function startChipDecorator() {
			if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return
			if (chipObserver !== null) return
			decorateAllChips(null)
			// 宿主 React 重渲染可能重建 chip 内部 DOM 把 × 抹掉，且不产生新 chip 节点；
			// 因此对「我们的按钮被移除」做精准补挂，另有合并下一帧的兜底扫描。
			const sweepSoon = () => {
				if (chipSweepTimer !== null) return
				chipSweepTimer = setTimeout(() => {
					chipSweepTimer = null
					decorateAllChips(null)
				}, 120)
			}
			chipObserver = new MutationObserver((records) => {
				for (let i = 0; i < records.length; i++) {
					const r = records[i]
					if (r.type !== 'childList') continue
					// 1) 新增了 chip（或包含 chip 的子树）→ 立即挂载
					for (let j = 0; j < r.addedNodes.length; j++) {
						const n = r.addedNodes[j]
						if (n.nodeType === 1) decorateAllChips(n)
					}
					// 2) 我们的 × 被宿主重渲染抹掉 → 精准补挂对应 chip
					for (let j = 0; j < r.removedNodes.length; j++) {
						const n = r.removedNodes[j]
						if (n.nodeType !== 1) continue
						const isOurBtn = n.hasAttribute !== undefined && n.hasAttribute('data-dsh-fa-chip-x')
						const holdsOurBtn = n.querySelector !== undefined && n.querySelector('[data-dsh-fa-chip-x]') !== null
						if (!isOurBtn && !holdsOurBtn) continue
						const t = r.target
						if (t !== null && t !== void 0 && t.nodeType === 1) {
							const chip = t.closest !== undefined ? t.closest(CHIP_SELECTOR) : null
							if (chip !== null) decorateAllChips(chip)
							else sweepSoon()
						}
					}
				}
			})
			chipObserver.observe(document.body, { childList: true, subtree: true })
		}

		// ---- 聊天区用户消息渲染器（shadow conversation.chat.node keyed 'user'）----
		// 需求：图片在聊天区也要预览（缩略图 + 点击放大）；文件自始至终不需要预览（保持 chip）。
		// 方案 B 下用户消息以 @绝对路径 文本形式落库（无原生附件块），故核心是扫描 text 块内的
		// @路径：图片路径 → /api/file?path= 缩略图（宿主既有文件服务路由，同 AssistantMarkdown
		// localPathMediaUrl 机制）；文件路径 → 复刻 dsh projectUserText 的 refChip 样式（无预览）。
		// 原生 image/file 附件块（若存在）→ 尽力渲染（renderMessageImages / 文件卡片）。
		// 本插件自包含（无法 import dsh 包），全部 react.createElement + 内联样式复刻。

		// 图片扩展名集合（与 host IMAGE_EXT 一致：png/jpg/jpeg/gif/webp/bmp）
		const IMAGE_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
		function isImagePath(p) {
			if (typeof p !== 'string' || p === '') return false
			const dot = p.lastIndexOf('.')
			if (dot <= 0) return false
			return IMAGE_EXT_SET.has(p.slice(dot + 1).toLowerCase())
		}
		// 复刻 dsh fileSizeText：字节数 → 人类可读
		function fileSizeText(bytes) {
			if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return ''
			if (bytes < 1024) return bytes + ' B'
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace(/\.0$/u, '') + ' KB'
			if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, '') + ' MB'
			return (bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/u, '') + ' GB'
		}
		// 复刻 dsh contentParts：用户消息 content（块数组）拆 text/attachments/rest
		function contentParts(content) {
			const texts = []
			const attachments = []
			const rest = []
			if (!Array.isArray(content)) {
				return { text: (typeof content === 'string' ? content : ''), attachments, rest }
			}
			for (const block of content) {
				const b = (block !== null && typeof block === 'object') ? block : null
				if (b !== null && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
				else if (b !== null && b.type === 'image' && b.attachment !== void 0) attachments.push({ type: 'image', image: b.attachment })
				else if (b !== null && b.type === 'file' && b.attachment !== void 0) attachments.push({ type: 'file', file: b.attachment })
				else if (b !== null) rest.push(block)
			}
			return { text: texts.join(''), attachments, rest }
		}
		// 复刻 dsh projectUserText 的 @路径 扫描（含引号形式），扫描 text 中的引用 token。
		// 返回 [{ start, end, raw, path }]：raw=完整 token（含@），path=去 @ 与前导引号后的路径。
		// 用户常把图片引用夹在中文句子里（如 “而且@C:\x.png切换”），@前后都不是空白，
		// 旧正则 (^|\s)@[^\s]+ 会整条漏配或把后面正文吞进路径。这里改为：
		// 1) 边界用 lookbehind：@前不能紧跟路径字符（\w @ . \ / -），行首/空白/CJK 邻接都放行（邮箱 foo@bar.com 被 \w 挡住）；
		// 2) 文件必须以扩展名锚定结尾、目录必须带尾斜杠，且其后不能再是路径字符，.png 后紧贴中文时才能正确截断；
		// 3) 无扩展名路径（纯 ASCII 路径体）仅在后随空白/结尾时才匹配，CJK 夹字不误配。
		function scanRefTokens(text) {
			const out = []
			if (typeof text !== 'string' || text === '') return out
			// @/引号 边界：前面不能紧跟路径字符（字母数字、点、@、斜杠、连字符）
			const BOUND = '(?<![\\w@.\\\\/-])'
			// 引号形式（路径含空格）：@"..."
			const reQ = new RegExp(BOUND + '(@"[^"\\n]+")', 'gu')
			const reF = new RegExp(BOUND + '(@((?:[A-Za-z]:[\\\\/]|[\\\\/]|~[\\\\/])[^\\s@"<>|*?]*?[^\\s@"<>|*?\\\\/]\\.[A-Za-z0-9]{1,12}))(?![\\w.\\\\/-])', 'gu')
			const reD = new RegExp(BOUND + '(@((?:[A-Za-z]:[\\\\/]|[\\\\/]|~[\\\\/])[^\\s@"<>|*?]*[\\\\/]))(?![\\w.\\\\/-])(?![A-Za-z0-9.])', 'gu')
			const reC = new RegExp(BOUND + '(@((?:[A-Za-z]:[\\\\/]|[\\\\/]|~[\\\\/])[A-Za-z0-9._\\\\/-]*))(?=$|[\\s])', 'gu')
			const push = (re) => {
				let m = null
				while ((m = re.exec(text)) !== null) {
					const raw = m[1]
					const start = m.index
					if (out.some(t => t.start === start)) continue
					let path = raw.slice(1)
					if (path.charAt(0) === '"' && path.length > 1 && path.charAt(path.length - 1) === '"') path = path.slice(1, -1)
					out.push({ start, end: start + raw.length, raw, path })
				}
			}
			push(reQ); push(reF); push(reD); push(reC) // 文件形式先于目录形式
			out.sort((a, b) => a.start - b.start || b.end - a.end)
			// 丢弃与前一 token 重叠的（同起点时排序已保证更长者在前）
			const kept = []
			let lastEnd = -1
			for (const t of out) {
				if (t.start >= lastEnd) { kept.push(t); lastEnd = t.end }
			}
			return kept
		}
		// 复刻 dsh IconBrowseOutline16 的 SVG path（16×16 viewBox，文件浏览图标，currentColor）
		function fileBrowseGlyph(size) {
			return react.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, style: { display: 'block' } },
				react.createElement('path', { d: 'M11.2426 4.80473V6.10551H4.75819V4.80473H11.2426Z', fill: 'currentColor' }),
				react.createElement('path', { d: 'M9.40858 7.84478V9.14557H4.75819V7.84478H9.40858Z', fill: 'currentColor' }),
				react.createElement('path', {
					d: 'M9.23438 0.546389C10.1941 0.546389 10.9683 0.544914 11.5859 0.611819C12.2161 0.680096 12.7634 0.825745 13.2393 1.17139C13.5172 1.3733 13.7619 1.61812 13.9639 1.896C14.3096 2.37183 14.4551 2.91922 14.5234 3.54932C14.5903 4.16686 14.5889 4.94133 14.5889 5.90088V10.0981C14.5889 11.0576 14.5903 11.8321 14.5234 12.4497C14.4552 13.0798 14.3094 13.6272 13.9639 14.103C13.7619 14.381 13.5172 14.6257 13.2393 14.8276C12.7633 15.1734 12.2163 15.3189 11.5859 15.3872C10.9683 15.4541 10.1942 15.4536 9.23438 15.4536H6.76563C5.80591 15.4536 5.03168 15.4541 4.41407 15.3872C3.78385 15.3189 3.23665 15.1734 2.76074 14.8276C2.48291 14.6257 2.23802 14.3809 2.03614 14.103C1.69066 13.6272 1.54483 13.0798 1.47657 12.4497C1.40973 11.8321 1.41114 11.0576 1.41114 10.0981V5.90088C1.41113 4.94132 1.40966 4.16686 1.47657 3.54932C1.54488 2.91921 1.69042 2.37184 2.03614 1.896C2.2381 1.61807 2.4828 1.37333 2.76074 1.17139C3.23665 0.825682 3.78386 0.680109 4.41407 0.611819C5.03168 0.544905 5.80591 0.546389 6.76563 0.546389H9.23438ZM6.76563 1.896C5.77586 1.896 5.0876 1.89738 4.55957 1.95459C4.0443 2.01043 3.76214 2.11349 3.55469 2.26416C3.39135 2.38284 3.24761 2.52662 3.12891 2.68994C2.97821 2.89736 2.8752 3.17967 2.81934 3.69483C2.76214 4.22279 2.76075 4.91131 2.76074 5.90088V10.0981C2.76074 11.0876 2.76221 11.7762 2.81934 12.3042C2.87516 12.8194 2.97829 13.1026 3.12891 13.3101C3.24754 13.4733 3.39147 13.6172 3.55469 13.7358C3.76213 13.8865 4.04438 13.9896 4.55957 14.0454C5.0876 14.1026 5.77586 14.103 6.76563 14.103H9.23438C10.2242 14.103 10.9124 14.1026 11.4404 14.0454C11.9556 13.9896 12.2379 13.8865 12.4453 13.7358C12.6086 13.6172 12.7525 13.4733 12.8711 13.3101C13.0217 13.1026 13.1248 12.8195 13.1807 12.3042C13.2378 11.7762 13.2393 11.0876 13.2393 10.0981V5.90088C13.2393 4.91131 13.2379 4.22279 13.1807 3.69483C13.1248 3.17969 13.0218 2.89736 12.8711 2.68994C12.7524 2.52667 12.6086 2.38281 12.4453 2.26416C12.2379 2.11355 11.9556 2.01041 11.4404 1.95459C10.9124 1.8974 10.2241 1.896 9.23438 1.896H6.76563Z', fill: 'currentColor' }),
			)
		}
		// 聊天区 @文件路径 → refChip（复刻 dsh css.refChip：inline + 主题色 + 图标 + 末段名；无预览）
		// 目录（尾斜杠 / @path/ 语法）显示蓝色文件夹图标，文件显示文档图标。
		function renderRefChip(raw, path) {
			const isFolder = raw.charAt(raw.length - 1) === '/' || path.charAt(path.length - 1) === '/'
			// 目录尾斜杠先去掉再取末段，否则 lastIndexOf('/') 命中末尾导致整条路径都显示
			const bare = isFolder ? path.replace(/[\\/]+$/u, '') : path
			let name = bare
			const sl = Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\'))
			if (sl >= 0 && sl < bare.length - 1) name = bare.slice(sl + 1)
			return react.createElement('span', {
				title: raw,
				style: {
					display: 'inline', margin: '0 2px', whiteSpace: 'nowrap',
					color: 'var(--dsw-alias-state-business-primary)', fontWeight: 500,
				},
			},
				react.createElement('span', { style: { display: 'inline-block', width: '1em', height: '1em', marginRight: '4px', verticalAlign: '-0.125em', color: 'inherit' } },
					isFolder ? folderGlyph(16) : fileBrowseGlyph(16)),
				name,
			)
		}
		// 图片放大预览（Lightbox）：模块级状态，FaUserMessage 缩略图点击打开，FaLightbox 渲染
		let lightboxSrc = null
		let lightboxName = ''
		let lightboxListener = null
		function openLightbox(src, name) {
			lightboxSrc = src
			lightboxName = name || ''
			if (lightboxListener !== null) lightboxListener()
		}
		function FaLightbox() {
			const [, force] = react.useState(0)
			react.useEffect(() => {
				lightboxListener = () => force(n => n + 1)
				return () => { if (lightboxListener !== null) lightboxListener = null }
			}, [])
			const src = lightboxSrc
			if (src === null || src === '') return null
			const close = () => { openLightbox(null, '') }
			return react.createElement('div', {
				onClick: close,
				style: {
					position: 'fixed', inset: '0', zIndex: 3000,
					background: 'rgba(0,0,0,0.74)', display: 'flex', alignItems: 'center', justifyContent: 'center',
					cursor: 'zoom-out',
				},
			},
				react.createElement('img', { src, alt: lightboxName, style: { maxWidth: '90vw', maxHeight: '90vh', borderRadius: '8px', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' } }),
				react.createElement('span', {
					onClick: (e) => { e.stopPropagation(); close() },
					title: '关闭',
					style: { position: 'absolute', top: '18px', right: '24px', color: '#fff', fontSize: '30px', cursor: 'pointer', lineHeight: '1', userSelect: 'none' },
				}, '×'),
			)
		}
		// 宿主文件服务 URL：与 dsh AssistantMarkdown.localPathMediaUrl 同机制
		function imageUrlFor(path) {
			return '/api/file?path=' + encodeURIComponent(path)
		}
		// 聊天区 @图片路径 → 输入框附件条同款 chip（默认外观）；hover 弹出放大预览；点击 Lightbox。
		// 名称取路径末段（与 refChip 一致）
		function chatImageName(path) {
			const bare = String(path == null ? '' : path).replace(/[\\/]+$/u, '')
			const sl = Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\'))
			return sl >= 0 && sl < bare.length - 1 ? bare.slice(sl + 1) : bare
		}
		// chip 外观：聊天区引用 chip 与草稿原生 @路径 chip 保持一致（22px 高、13px 字、6px 圆角、14px 缩略图）
		const CHAT_CHIP_STYLE = {
			display: 'inline-flex', alignItems: 'center', gap: '4px',
			boxSizing: 'border-box', height: '22px', maxWidth: '240px',
			background: 'var(--cr-tag-bg, rgba(128,128,128,0.12))',
			borderRadius: '6px', padding: '2px 6px', margin: '0 2px',
			fontSize: '13px', fontWeight: 500, lineHeight: '14px',
			color: 'var(--cr-text-primary, inherit)', whiteSpace: 'nowrap',
			verticalAlign: 'middle', cursor: 'zoom-in',
		}
		// 缩略图占位：原生附件块 URL 尚未就绪时用 1×1 透明 SVG，避免构造无效 /api/file 请求与破图
		const CHIP_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')
		// hover 放大预览定位：优先贴 chip 上方 8px；上方空间不足改贴下方；
		// 右半屏以右边缘对齐（向左展开），左半屏以左边缘对齐，避免溢出视口
		function chatPreviewPlacement(rect) {
			if (rect === null) return null
			const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
			const vh = typeof window !== 'undefined' ? window.innerHeight : 768
			const style = {
				position: 'fixed', zIndex: 2500, pointerEvents: 'none',
				maxWidth: 'min(360px, calc(100vw - 32px))',
			}
			if (rect.top >= 220) style.bottom = (vh - rect.top + 8) + 'px'
			else style.top = (rect.bottom + 8) + 'px'
			if (rect.left + rect.width / 2 > vw / 2) style.right = Math.max(8, vw - rect.right) + 'px'
			else style.left = Math.max(8, rect.left) + 'px'
			return style
		}
		// 聊天区图片 chip：默认=输入框同款小 pill（14px 缩略图 + 文件名）；
		// hover=上方浮层放大预览（pointer-events:none，不遮挡点击）；点击=现有 Lightbox 大图。
		// 缩略图加载失败回退为文件 chip（不显示破图）。
		function FaChatImageChip(props) {
			const path = props.path
			const raw = props.raw
			// src：@路径图片由 imageUrlFor 生成；原生附件块由宿主 loadImage 解析后传入，
			// 未就绪（空串）时用透明占位，绝不拿附件名当路径去请求 /api/file
			const hasExplicitSrc = typeof props.src === 'string'
			const src = hasExplicitSrc
				? (props.src === '' ? CHIP_PLACEHOLDER : props.src)
				: imageUrlFor(path)
			const [hover, setHover] = react.useState(false)
			const [rect, setRect] = react.useState(null)
			const [failed, setFailed] = react.useState(false)
			const chipRef = react.useRef(null)
			if (failed) return renderRefChip(raw, path)
			const enter = () => {
				const el = chipRef.current
				if (el !== null && typeof el.getBoundingClientRect === 'function') {
					const r = el.getBoundingClientRect()
					setRect({ left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom })
				}
				setHover(true)
			}
			const leave = () => { setHover(false); setRect(null) }
			return react.createElement(react.Fragment, null,
				react.createElement('span', {
					ref: chipRef, title: raw,
					onMouseEnter: enter, onMouseLeave: leave,
					onClick: () => { openLightbox(src, path) },
					style: CHAT_CHIP_STYLE,
				},
					react.createElement('span', { style: { display: 'inline-flex', width: '14px', height: '14px', flex: 'none', overflow: 'hidden' } },
						react.createElement('img', {
							src, alt: '', onError: () => setFailed(true),
							style: { width: '14px', height: '14px', objectFit: 'cover', borderRadius: '3px', display: 'block' },
						})),
					react.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, props.name ? props.name : chatImageName(path)),
				),
				hover && rect !== null ? react.createElement('div', {
					style: {
					  ...chatPreviewPlacement(rect),
					  padding: '4px', borderRadius: '14px',
					  background: 'var(--dsw-alias-bg-layer-1, rgba(28,28,32,0.96))',
					  border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
					  boxShadow: '0 10px 32px rgba(0,0,0,0.35)',
					},
				}, react.createElement('img', {
					src, alt: '',
					style: { display: 'block', maxWidth: '100%', maxHeight: '360px', borderRadius: '10px' },
				})) : null,
			)
		}
		// 原生 image 附件块（上传通道 / 历史消息）→ 与 @路径图片同一套 chip：
		// 宿主 chat.node 注入的是 loadImage(attachment) → Promise<url>（带 peek 同步缓存），
		// 旧代码用的 renderMessageImages 在当前宿主并不存在，导致原生图片块整块不渲染。
		function FaNativeImageChip(props) {
			const attachment = props.attachment
			const loadImage = props.loadImage
			const [src, setSrc] = react.useState(() => {
				try {
					if (loadImage !== null && loadImage !== void 0 && typeof loadImage.peek === 'function') {
						const cached = loadImage.peek(attachment)
					if (typeof cached === 'string' && cached !== '') return cached
				}
				} catch (err) { /* 无缓存则异步加载 */ }
				return null
			})
			const [failed, setFailed] = react.useState(false)
			react.useEffect(() => {
				if (typeof loadImage !== 'function') { setFailed(true); return }
				let live = true
				Promise.resolve()
					.then(() => loadImage(attachment))
					.then((url) => { if (live && typeof url === 'string' && url !== '') setSrc(url) })
					.catch(() => { if (live) setFailed(true) })
				return () => { live = false }
			}, [attachment, loadImage])
			const name = attachment && typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : '图片'
			const raw = '@' + name
			if (failed) return renderRefChip(raw, name)
			return react.createElement(FaChatImageChip, { path: name, raw, src: src === null ? '' : src, name })
		}
		// text 块 → 节点序列：普通文本 run + @路径（图片→输入框同款 chip / 文件→refChip）
		function projectUserText(text) {
			if (typeof text !== 'string' || text === '') return null
			const tokens = scanRefTokens(text)
			if (tokens.length === 0) return react.createElement('span', null, text)
			const parts = []
			let cursor = 0
			for (const tk of tokens) {
				if (tk.start > cursor) parts.push(react.createElement('span', { key: 't' + cursor }, text.slice(cursor, tk.start)))
				if (isImagePath(tk.path)) parts.push(react.createElement('span', { key: 'i' + tk.start }, react.createElement(FaChatImageChip, { path: tk.path, raw: tk.raw })))
				else parts.push(react.createElement('span', { key: 'r' + tk.start }, renderRefChip(tk.raw, tk.path)))
				cursor = tk.end
			}
			if (cursor < text.length) parts.push(react.createElement('span', { key: 't' + cursor }, text.slice(cursor)))
			return react.createElement(react.Fragment, null, parts)
		}
		// 聊天区文件附件块 → 文件卡片（名 + 扩展名/大小 meta；无预览）
		function renderFileCard(file, key) {
			const ext = (file && typeof file.name === 'string' ? file.name.lastIndexOf('.') : -1) > 0
				? String(file.name.slice(file.name.lastIndexOf('.') + 1)).toUpperCase().slice(0, 8)
				: ''
			const meta = [ext, fileSizeText(file && file.bytes)].filter(Boolean).join(' ')
			return react.createElement('span', {
				key, title: file && file.name,
				style: {
					display: 'inline-flex', flex: '0 0 240px', alignItems: 'center', gap: '10px',
					width: '240px', minHeight: '64px', padding: '8px 12px',
					border: '0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
					borderRadius: '16px', background: 'var(--dsw-specific-input-major, transparent)',
					boxSizing: 'border-box',
				},
			},
				react.createElement('span', { style: { display: 'inline-flex', width: '20px', height: '20px', flex: 'none' } },
					fileGlyph(file && file.name ? file.name : 'file')),
				react.createElement('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
					react.createElement('span', { style: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file && file.name),
					react.createElement('span', { style: { fontSize: '11px', opacity: 0.7 } }, meta),
				),
			)
		}
		// 聊天区用户消息渲染器：气泡 + @图片缩略图预览 / @文件 chip；附件块尽力渲染
		function FaUserMessage(props) {
			const node = props && props.node
			const data = node ? node.data : null
			const content = data ? data.content : []
			// 宿主 chat.node 注入：loadImage(attachment) → Promise<url>（带 peek 同步缓存）
			const loadImage = props && props.loadImage
			const { text, attachments, rest } = contentParts(content)
			// 图片/文件引用与文字统一在气泡内渲染（图片=输入框同款 chip + hover 放大预览）
			const inline = projectUserText(text)
			const showBubble = inline !== null || rest.length > 0
			const [copied, setCopied] = react.useState(false)
			const copyTimer = react.useRef(null)
			react.useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
			function onCopy() {
				const doReset = () => { setCopied(false); copyTimer.current = setTimeout(() => setCopied(false), 1000) }
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(doReset).catch(() => {
						const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
						document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); doReset()
					})
				} else {
					const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
					document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); doReset()
				}
			}
			const rows = []
			// 附件块（image → 原生缩略图画廊 / file → 文件卡片）
			for (let i = 0; i < attachments.length; i++) {
				const a = attachments[i]
				if (a.type === 'image') {
					// 原生 image 附件块：与 @路径图片同一套 chip（悬停放大预览 + 点击 Lightbox）
					rows.push(react.createElement(FaNativeImageChip, { key: 'image:' + i, attachment: a.image, loadImage }))
				} else {
					rows.push(renderFileCard(a.file, 'file:' + i))
				}
			}
			// 气泡（text + rest）
			if (showBubble) {
				rows.push(react.createElement('div', {
					key: 'bubble',
					style: {
						maxWidth: '100%', background: 'var(--dsw-specific-bubble)', borderRadius: '22px',
						padding: '10px 16px', fontSize: 'var(--dsh-content-font-size, 14px)',
						lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
						whiteSpace: 'pre-wrap', wordBreak: 'break-word',
					},
				},
					inline,
					rest.map((block, i) => {
						let label = ''
						try { label = JSON.stringify(block) } catch (err) { label = String(block) }
						if (label.length > 200) label = label.slice(0, 200) + '…'
						return react.createElement('div', { key: 'rest' + i, style: { fontSize: '12px', opacity: 0.75, marginTop: '4px' } }, label)
					}),
				))
			}
			if (rows.length === 0) return null
			// actions 行（时间 + 复制按钮），与原生 MessageIconActions 对齐
			const timeStr = data && data.time ? new Date(data.time).toLocaleTimeString() : ''
			const actionsRow = react.createElement('div', {
				key: 'actions',
				style: { display: 'flex', alignItems: 'center', gap: '8px', height: 'calc(28px + var(--dsh-content-font-delta, 0px))' },
			},
				timeStr && react.createElement('span', { style: { fontSize: 'var(--dsh-content-font-size-secondary, 13px)', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', paddingRight: '12px' } }, timeStr),
				react.createElement('button', {
					type: 'button', onClick: onCopy, title: copied ? '已复制' : '复制',
					style: {
						width: 'calc(28px + var(--dsh-content-font-delta, 0px))', height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
						borderRadius: 'var(--dsw-radius-sm)', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
						background: '0 0', border: 'none', display: 'inline-flex', justifyContent: 'center', alignItems: 'center', padding: '6px',
					},
				},
					copied
						? react.createElement('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, react.createElement('path', { d: 'M20 6 9 17l-5-5' }))
						: react.createElement('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [react.createElement('rect', { key: 'r', x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }), react.createElement('path', { key: 'p', d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })])
				),
			)
			return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', width: '100%' } },
				react.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', minWidth: 0, maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)' } }, rows),
				actionsRow,
			)
		}

		// 设置页：配置多模态识别参数（模型从 harness 模型目录下拉选取）与会话清理联动，
		// 保存写 ~/.dsh/file-attachment.json
		function FaSettingsPage() {
			const [saved, setSaved] = react.useState(false)
			const [saving, setSaving] = react.useState(false)
			const [cleanupEnabled, setCleanupEnabled] = react.useState(false)
			const [vlmBaseURL, setVlmBaseURL] = react.useState('')
			const [vlmApiKey, setVlmApiKey] = react.useState('')
			const [vlmProvider, setVlmProvider] = react.useState('')
			const [vlmModel, setVlmModel] = react.useState('')
			const [vlmThinking, setVlmThinking] = react.useState(false)
			const [vlmTimeout, setVlmTimeout] = react.useState('60')
			const [testError, setTestError] = react.useState('')
			// harness 模型目录：{ providers: [{ id, name, models: [{ id, name }] }] }
			const [catalog, setCatalog] = react.useState(null)
			const [catalogFailed, setCatalogFailed] = react.useState(false)
			// 目录不可用（请求失败 / 拿不到任何模型）时退回手填，保证任何环境都还能配置
			const [manualModel, setManualModel] = react.useState(false)
			react.useEffect(() => {
				// 挂载时载入持久化配置到编辑副本（幂等，复用 loadConfig Promise）
				let live = true
				loadConfig().then(() => {
					if (!live) return
					setCleanupEnabled(cleanup.enabled === true)
					setVlmBaseURL(vlmCfg.baseURL)
					setVlmApiKey(vlmCfg.apiKey)
					setVlmProvider(vlmCfg.provider)
					setVlmModel(vlmCfg.model)
					setVlmThinking(vlmCfg.thinkingType === 'enabled')
					setVlmTimeout(String(vlmCfg.timeout || 60))
				})
				// 拉 harness 模型目录（失败静默降级为手填）
				fetch('/dsh-file-attachment/models').then((r) => r.json()).then((env) => {
					if (!live) return
					const providers = env && env.ok === true && env.value && Array.isArray(env.value.providers) ? env.value.providers : null
					if (providers === null) { setCatalogFailed(true); setManualModel(true); return }
					setCatalog(providers)
					const total = providers.reduce((n, p) => n + (Array.isArray(p.models) ? p.models.length : 0), 0)
					if (total === 0) { setCatalogFailed(true); setManualModel(true) }
				}).catch(() => { if (live) { setCatalogFailed(true); setManualModel(true) } })
				return () => { live = false }
			}, [])
			function t(key) {
				if (ctxRef !== null && ctxRef.locale !== void 0 && typeof ctxRef.locale.bind === 'function') {
					try { return ctxRef.locale.bind('dsh-file-attachment')(key) } catch (err) { /* 回退 key */ }
				}
				return key
			}
			// 下拉选项值编码：provider\u0000model（provider 可为空 = 兼容旧配置/手填）
			const selectedValue = vlmProvider === '' && vlmModel !== '' ? '\u0000' + vlmModel : vlmProvider + '\u0000' + vlmModel
			function onPickModel(e) {
				const raw = e.target.value
				if (raw === '') { setVlmProvider(''); setVlmModel(''); return }
				const at = raw.indexOf('\u0000')
				setVlmProvider(at >= 0 ? raw.slice(0, at) : '')
				setVlmModel(at >= 0 ? raw.slice(at + 1) : raw)
			}
			// 已保存的模型不在目录里（旧配置手填过 / 服务商改名）→ 追加一项「已保存」，不丢配置
			const knownPairs = new Set()
			if (catalog !== null) {
				for (const p of catalog) for (const m of (Array.isArray(p.models) ? p.models : [])) knownPairs.add(p.id + '\u0000' + m.id)
			}
			const savedMissing = vlmModel !== '' && !knownPairs.has(vlmProvider + '\u0000' + vlmModel)
			async function save() {
				setSaving(true); setSaved(false); setTestError('')
				const vlmForm = {
					baseURL: String(vlmBaseURL).trim(),
					apiKey: String(vlmApiKey).trim(),
					provider: String(vlmProvider).trim(),
					model: String(vlmModel).trim(),
					thinkingType: vlmThinking ? 'enabled' : 'disabled',
					timeout: Math.min(600, Math.max(1, Math.floor(Number(vlmTimeout) || 60))),
				}
				// 模型为空 = 不使用多模态识别（只用文件上传功能）→ 跳过校验直接保存
				try {
					if (vlmForm.model !== '') {
						// 校验视觉模型配置（不落盘）：不可达时中止保存并内联展示原因
						const tr = await fetch('/dsh-file-attachment/test', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ vlm: vlmForm }),
						})
						const tenv = await tr.json().catch(() => null)
						if (!tenv || tenv.ok !== true) {
							setTestError((tenv && tenv.error) || '视觉模型校验失败，未保存')
							return
						}
					}
					const body = { vlm: vlmForm, cleanup: { enabled: cleanupEnabled } }
					const r = await fetch('/dsh-file-attachment/config', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
					})
					const env = await r.json()
					if (env && env.ok === true) {
						applyConfig(body) // 立即生效：更新多模态参数与会话清理联动配置
						setSaved(true)
						setTimeout(() => setSaved(false), 2000)
					} else { announce('保存失败') }
				} catch (err) {
					setTestError('视觉模型校验请求失败，未保存')
				} finally { setSaving(false) }
			}
			const inputStyle = { padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))', background: 'transparent', color: 'inherit', fontSize: '12px' }
			const selectStyle = { ...inputStyle, cursor: 'pointer' }
			// 模型下拉：按服务商分组 <optgroup>
			const modelSelect = react.createElement('select', { value: selectedValue, onChange: onPickModel, style: selectStyle },
				react.createElement('option', { value: '' }, t('vlm.modelNone')),
				savedMissing ? react.createElement('option', { value: selectedValue }, t('vlm.modelSaved') + '：' + (vlmProvider !== '' ? vlmProvider + ' / ' : '') + vlmModel) : null,
				catalog !== null ? catalog.map((p) => react.createElement('optgroup', { key: p.id, label: p.name },
					(Array.isArray(p.models) ? p.models : []).map((m) => react.createElement('option', { key: m.id, value: p.id + '\u0000' + m.id }, m.name)),
				)) : null,
			)
			// 手填输入：目录不可用 / 用户主动切到自定义时使用
			const modelInput = react.createElement('input', { value: vlmModel, onChange: (e) => setVlmModel(e.target.value), placeholder: 'mimo-v2.5', style: inputStyle })
			return react.createElement('div', { style: { padding: '16px', maxWidth: '680px' } },
				react.createElement('div', { style: { marginBottom: '16px', fontSize: '13px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.95))' } }, t('settings.hint')),
				react.createElement('div', { style: { margin: '16px 0', padding: '14px 16px', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14))' } },
					react.createElement('div', { style: { marginBottom: '8px', fontSize: '13px', fontWeight: '600', color: 'var(--dsw-alias-label-primary, inherit)' } }, t('vlm.title')),
					react.createElement('div', { style: { marginBottom: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' } }, t('vlm.hint')),
					react.createElement('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 10px', alignItems: 'center' } },
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.model')),
						react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
							manualModel ? modelInput : modelSelect,
							catalog !== null && !catalogFailed ? react.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' } },
								react.createElement('input', { type: 'checkbox', checked: manualModel, onChange: (e) => setManualModel(e.target.checked) }),
								t('vlm.modelManual'),
							) : null,
						),
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.baseURL')),
						react.createElement('input', { value: vlmBaseURL, onChange: (e) => setVlmBaseURL(e.target.value), placeholder: t('vlm.baseURLPlaceholder'), style: inputStyle }),
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.apiKey')),
						react.createElement('input', { value: vlmApiKey, onChange: (e) => setVlmApiKey(e.target.value), type: 'password', placeholder: t('vlm.apiKeyPlaceholder'), style: inputStyle }),
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.timeout')),
						react.createElement('input', { value: vlmTimeout, onChange: (e) => setVlmTimeout(e.target.value), placeholder: '60', title: t('vlm.timeoutHint'), style: inputStyle }),
						react.createElement('span', { style: { fontSize: '12px' } }),
						react.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
							react.createElement('input', { type: 'checkbox', checked: vlmThinking, onChange: (e) => setVlmThinking(e.target.checked) }),
							t('vlm.thinking'),
						),
					),
					catalogFailed ? react.createElement('div', { style: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' } }, t('vlm.modelCatalogFailed')) : null,
				),
				react.createElement('div', { style: { margin: '16px 0', padding: '14px 16px', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14))' } },
					react.createElement('div', { style: { marginBottom: '8px', fontSize: '13px', fontWeight: '600', color: 'var(--dsw-alias-label-primary, inherit)' } }, t('cleanup.title')),
					react.createElement('div', { style: { marginBottom: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' } }, t('cleanup.hint')),
					react.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
						react.createElement('input', { type: 'checkbox', checked: cleanupEnabled, onChange: (e) => { setCleanupEnabled(e.target.checked); cleanup = { enabled: e.target.checked } } }),
						t('cleanup.enable'),
					),
				),
				react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
					react.createElement('button', {
						type: 'button', onClick: save, disabled: saving,
						style: {
							padding: '8px 20px', borderRadius: '8px', border: 'none',
							background: 'rgba(80,120,220,0.9)', color: '#fff',
							cursor: saving ? 'default' : 'pointer', fontSize: '13px', opacity: saving ? 0.6 : 1,
						},
					}, saving ? t('saving') : t('save')),
					saved ? react.createElement('span', { style: { fontSize: '13px', color: 'rgba(80,160,120,0.95)' } }, t('saved')) : null,
					testError !== '' ? react.createElement('span', { style: { fontSize: '12px', color: 'rgba(220,100,90,0.95)', maxWidth: '420px', wordBreak: 'break-all' } }, testError) : null,
				)
			)
		}

		// 插件配置 tab 卡片：自渲染标题 + 描述 + 展开/收起，展开后承载原有设置表单（FaSettingsPage）。
		// 「插件配置」tab 只派发 settings.plugin.item 槽位，卡片外观完全由插件自绘
		//（与自动继续/插件市场同形）；表单内部仍走 /config 接口读写真实配置。
		function FaSettingsCard() {
			const [open, setOpen] = react.useState(false)
			const [hover, setHover] = react.useState(false)
			const [version, setVersion] = react.useState(null)
			// 【已屏蔽 /version 拉取，保留代码以备后用】
			// react.useEffect(() => {
			// 	fetch('/dsh-file-attachment/version').then(r => r.json()).then(d => {
			// 		if (d.ok && d.version) setVersion(d.version)
			// 	}).catch(() => { /* ignore */ })
			// }, [])
			function t(key) {
				if (ctxRef !== null && ctxRef.locale !== void 0 && typeof ctxRef.locale.bind === 'function') {
					try { return ctxRef.locale.bind('dsh-file-attachment')(key) } catch (err) { /* 回退 key */ }
				}
				return key
			}
			const borderActive = open || hover
			return react.createElement('div', {
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				style: {
					borderRadius: '16px',
					border: `0.5px solid ${borderActive ? 'var(--dsw-alias-label-dimmed, var(--dsw-alias-border-l4))' : 'var(--dsw-alias-border-l4)'}`,
					background: open ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))' : 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.04))',
					overflow: 'hidden',
					transition: 'border-color 0.16s, background 0.16s',
				},
			},
				react.createElement('button', {
					type: 'button',
					'aria-expanded': open,
					onClick: () => setOpen(!open),
					style: {
						display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
						width: '100%', padding: '14px 16px',
						background: 'none', border: 'none', cursor: 'pointer',
						color: 'inherit', textAlign: 'left', boxSizing: 'border-box',
					},
				},
					react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 } },
						react.createElement('div', { style: { fontSize: '15px', fontWeight: 600, lineHeight: '1.4', color: 'var(--dsw-alias-label-primary, inherit)' } },
							t('card.title'),
							version != null ? react.createElement('span', { style: { marginLeft: '1em', fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-quaternary, rgba(128,128,128,0.55))', verticalAlign: 'middle' } }, 'v' + version) : null,
						),
						react.createElement('div', { style: { fontSize: '13px', lineHeight: '1.5', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.85))' } }, t('card.description')),
					),
					react.createElement('span', {
						style: {
							display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
							color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))',
							flex: 'none',
							transition: 'transform 0.16s',
							transform: open ? 'rotate(180deg)' : 'none',
						},
					},
						react.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true },
							react.createElement('path', { d: 'M3.5 5.5l3.5 3.5 3.5-3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })),
					),
				),
				open ? react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.14))', margin: '0 16px', paddingBottom: '8px' } },
					react.createElement(FaSettingsPage, {}),
				) : null,
			)
		}

		function apply(ctx) {
			ctxRef = ctx
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] apply', { hasSlots: ctx.get('slots') !== undefined, hasConversation: ctx.get('conversation') !== undefined })
			// 接入即拉持久化配置（幂等）：让自定义类型每次会话生效，而非仅打开设置页才加载
			void loadConfig()
			// 注册设置页文案（zh/en）
			ctx.effect(() => ctx.locale.register('dsh-file-attachment', {
				zh: {
					'card.title': '文件附件',
					'card.description': '拖拽、粘贴或上传任意类型的文件与图片；图片仅在当前模型支持多模态时可上传。',
					'settings.title': '文件附件',
					'settings.hint': '桌面端拖入的文件一律以 @原路径 引用（零拷贝、不占额外磁盘，文件被移动或删除后引用会提示不存在）；纯浏览器（手机 / 无桌面壳）下走上传，落盘到工作区 .dsh-file-attachment/（50MB 上限、同名追加 -N、同内容自动去重）。',
					'vlm.title': '多模态识别参数',
					'vlm.hint': '模型从 harness 模型目录下拉选取（无需手填）。Base URL 与 API Key 留空 = 走 harness 已配置的模型与凭据；填写 = 走该 OpenAI 兼容端点。会话开始与模型切换时自动检测当前模型能力：不支持图片输入的会话注册 describe_image 识别工具并隐藏原生 read_image（避免必然的报错）；支持图片输入的会话则隐藏 describe_image，模型直接看图。',
					'vlm.model': '模型',
					'vlm.modelNone': '（不使用多模态识别）',
					'vlm.modelSaved': '已保存',
					'vlm.modelManual': '自定义',
					'vlm.modelCatalogFailed': '未能读取 harness 模型目录，已切换为手填模型名。',
					'vlm.baseURL': 'Base URL',
					'vlm.baseURLPlaceholder': '留空 = 用 harness 模型',
					'vlm.apiKey': 'API Key',
					'vlm.apiKeyPlaceholder': '留空 = 用 harness 凭据',
					'vlm.thinking': '启用思考模式（默认禁用）',
					'vlm.timeout': '超时（秒）',
					'vlm.timeoutHint': '图片识别超时时间，默认 60 秒；识别慢或卡顿时可调大',
					'cleanup.title': '会话清理联动',
					'cleanup.hint': '需搭配提供「删除会话」的插件（如 dsh-session-delete）：删除会话时自动清理由该会话上传到 .dsh-file-attachment/ 的文件。按引用计数清理：多个会话共用（同名同大小去重复用）的文件会在最后一个引用它的会话被删除时才清除；启用联动之前上传的旧文件不受影响。可在删除会话前用 GET /dsh-file-attachment/cleanup-status?sessionId=… 查询将回收的文件数与大小。',
					'cleanup.enable': '删除会话时联动清理该会话上传的附件文件',
					'save': '保存',
					'saving': '保存中…',
					'saved': '已保存',
				},
				en: {
					'card.title': 'File Attachments',
					'card.description': 'Drag, paste or upload files and images of any type; images require a multimodal model.',
					'settings.title': 'File Attachments',
					'settings.hint': 'On desktop, dropped files are always referenced by their original @path (zero copy, no extra disk usage; a moved or deleted file makes the reference report "not found"). In a pure browser (mobile / no desktop shell), files upload to .dsh-file-attachment/ in the workspace (50MB cap, -N suffix on name conflicts, same-content dedup).',
					'vlm.title': 'Multimodal Recognition',
					'vlm.hint': 'Pick a model from the harness model catalog (no manual typing). Leave Base URL and API Key empty to use the harness model and credentials; fill them in to use that OpenAI-compatible endpoint. Model capability is checked at session start and on model switch: text-only models get the describe_image tool while the native read_image is hidden; image-capable models hide describe_image and read images directly.',
					'vlm.model': 'Model',
					'vlm.modelNone': '(no multimodal recognition)',
					'vlm.modelSaved': 'Saved',
					'vlm.modelManual': 'Custom',
					'vlm.modelCatalogFailed': 'Could not read the harness model catalog; falling back to a manual model name.',
					'vlm.baseURL': 'Base URL',
					'vlm.baseURLPlaceholder': 'empty = use harness model',
					'vlm.apiKey': 'API Key',
					'vlm.apiKeyPlaceholder': 'empty = use harness credentials',
					'vlm.thinking': 'Enable thinking mode (disabled by default)',
					'vlm.timeout': 'Timeout (s)',
					'vlm.timeoutHint': 'Image recognition timeout, default 60s; increase if recognition is slow or hangs',
					'cleanup.title': 'Session Cleanup Sync',
					'cleanup.hint': 'Works with a session-deletion plugin (e.g. dsh-session-delete): when a session is deleted, files it uploaded to .dsh-file-attachment/ are cleaned up automatically. Reference-counted: files shared by multiple sessions (dedup reuse) are removed only when the last referencing session is deleted; files uploaded before enabling this option are untouched.',
					'cleanup.enable': 'Delete uploaded attachment files when the session is deleted',
					'save': 'Save',
					'saving': 'Saving…',
					'saved': 'Saved',
				},
			}), 'dsh-file-attachment: dictionaries')
			const slots = ctx.get('slots')
			if (slots !== undefined) {
				// input.dock：hero（首轮空白无底部栏）态也渲染；inject 在渲染前经会话作用域直取输入机 shell
				slots.inject('conversation.input.dock', () => slots.register(
					{
						name: 'conversation.input.dock',
						id: 'dsh-file-attachment',
						order: 300,
						inject: (sessionId) => {
							// 只传 sessionId（string 可靠）；shell/addImages 由 FaBridge 组件经 ctxRef 自行计算
							if (sessionId === void 0) return {}
							return { sessionId }
						}
					},
					FaBridge
				))
				// 输入框附件条槽：不接管。引用一律以草稿内的原生 @路径 chip（蓝色）呈现，
				// 避免同一附件在附件条里再出现一颗灰色药丸造成重复；本插件不产生原生附件条目，
				// 故该槽为空。chip 的删除按钮由上面的 chip decorator 提供。
				// 聊天区用户消息：shadow 原生 UserMessageNodeView（keyed 'user'，priority -100 < 0，
				// lowest wins；Reusing a key replaces that node renderer），@图片路径→缩略图预览，
				// @文件路径→chip（无预览）
				slots.inject('conversation.chat.node', () => slots.register(
					{ name: 'conversation.chat.node', key: 'user', priority: -100 },
					FaUserMessage
				))
				slots.inject('shell.overlay', () => slots.register(
					{ name: 'shell.overlay', id: 'dsh-file-attachment-toast', order: 100 },
					FaToast
				))
				// 图片放大预览（Lightbox）：list 槽，与 toast 共存（order 200 渲染在 toast 之上）
				slots.inject('shell.overlay', () => slots.register(
					{ name: 'shell.overlay', id: 'dsh-file-attachment-lightbox', order: 200 },
					FaLightbox
				))
				// 设置左侧独立菜单：settings.section（label 显示在左侧菜单，内容区渲染表单）
				slots.inject('settings.section', () => [
					slots.register({
						name: 'settings.section',
						id: 'dsh-file-attachment-settings',
						order: 120,
						label: () => ctx.locale.bind('dsh-file-attachment')('settings.title'),
					}, () => react.createElement(FaSettingsPage, {})),
				])
			}
			bridge.conversation = ctx.get('conversation')
			// 劫持 dsh 原生📎：让上传入口位于与 dsh 本体一致的位置（hero/composer 两模式同一按钮），
			// 点击改走本插件文件选择器；MutationObserver + 定时重扫随 ctx.effect 生命周期清理
			ctx.effect(() => {
				const h = installNativeAttachHijack()
				return () => {
					if (h !== null && h !== void 0) {
						try { h.mo.disconnect() } catch (err) { /* 忽略 */ }
						try { clearInterval(h.timer) } catch (err) { /* 忽略 */ }
					}
				}
			}, 'dsh-file-attachment: native attach hijack')
			// document 级 capture 监听：dragenter/drop/paste 都先于既有 bubble 监听器；随 Fiber 停止
			ctx.effect(() => {
				document.addEventListener('dragenter', onDragEnterCap, true)
				document.addEventListener('drop', onDrop, true)
				document.addEventListener('paste', onPaste, true)
				return () => {
					document.removeEventListener('dragenter', onDragEnterCap, true)
					document.removeEventListener('drop', onDrop, true)
					document.removeEventListener('paste', onPaste, true)
				}
			}, 'dsh-file-attachment: document dragenter/drop/paste listeners')
			// 草稿 @引用 chip 的删除按钮（×）：MutationObserver 跟随 chip 增删自动挂载
			ctx.effect(() => {
				startChipDecorator()
				return () => {
					if (chipObserver !== null) { chipObserver.disconnect(); chipObserver = null }
					if (typeof document !== 'undefined') {
						const btns = document.querySelectorAll('[data-dsh-fa-chip-x]')
						for (let i = 0; i < btns.length; i++) {
							const par = btns[i].parentNode
							if (par !== null) par.removeChild(btns[i])
						}
					}
				}
			}, 'dsh-file-attachment: composer chip decorator')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	}
})