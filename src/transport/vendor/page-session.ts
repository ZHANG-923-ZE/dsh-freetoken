// @ts-nocheck (vendored from cv-superding/dsh-deepseek-web-login@cfd684d; see vendor/NOTICE.md)
/**
 * 把「登录态」装进传输层浏览器的**页面里**（localStorage）。
 *
 * ## 为什么必须有这个
 *
 * 传输层的请求确实是**真浏览器页面**发出的（见 `browser-transport.ts`：
 * `Runtime.evaluate` 里跑 `fetch`，响应用 `Runtime.addBinding` 分块回传）——
 * 也就是说 TLS/JA3、HTTP2、`Sec-Fetch-*`、`Origin`、cookie 罐、`x-device-id`
 * 全都是那个浏览器的，这一层没问题。
 *
 * 问题在**页面自己的状态**：我们此前只装了 cookie（`Network.setCookie`），
 * 而网页端的登录态读的是 `localStorage.userToken`。于是出现一个真人身上
 * 不可能出现的组合：
 *
 *   - 页面站在 `chat.deepseek.com` 上，站点 JS 认为**未登录**（渲染登录页）；
 *   - 而我们发出的请求带着合法的 `Authorization: Bearer …`。
 *
 * 站点自己的 JS 从来没跑起来过 ⇒ 没有会话列表轮询、没有长连接、没有任何
 * 由页面自发产生的活动。它只是一个"只等我们下命令"的空壳页。
 *
 * 把 `userToken` 写回页面 ⇒ 站点自己的应用真的跑起来，由它自己产生心跳。
 * 这才是"一直像真人开着的标签页"，而不是我们**自己造**一个定时 ping
 * （定时 ping 的固定周期本身就是一种模式，见 MEMORY 里"别自己造模式"那条）。
 *
 * ## 边界（重要）
 *
 * 只写**有来源**的键：
 *   - `userToken`          ← 请求头 `Authorization`（剥掉 `Bearer `，按网页端格式包一层）
 *   - `hif_leim_cached`    ← 请求头 `x-hif-leim`
 *
 * 🔴 `__appKit_userInfo` **没有来源**（用户 id/名字不在任何请求头里）⇒ **不编造**。
 * 宁可少写一个键，也不要写一个形态猜错的键 —— 猜错的形态会让站点 JS
 * 走到我们没验证过的分支上，比不写更危险。
 *
 * 🔴 `hifDliq` 同理：它只以请求头 `x-hif-dliq` 的形态存在（见 `webapi.ts`），
 * **不存在对应的 localStorage 键**（已核：全仓 `localStorage.*Item` 只出现
 * `userToken` / `__appKit_userInfo` / `hif_leim_cached` 三个键）⇒ 不写。
 */

/** 一条要写进页面的 localStorage 记录。 */
export interface PageSessionWrite {
  key: string
  value: string
}

/**
 * CDP 客户端的最小结构类型。
 *
 * 故意**不** import `browser-transport.ts` 的 `CdpClient`：那个模块要 import 本模块，
 * 反向 import 会形成循环。结构类型只需要一个 `send`。
 */
export interface CdpSender {
  send(method: string, params?: Record<string, unknown>): Promise<any>
}

/** 大小写不敏感地取一个头（请求头的键大小写在真实链路里不保证）。 */
function headerValue(rawHeaders: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key.toLowerCase() === wanted) return String(value ?? '')
  }
  return ''
}

/**
 * 按网页端自己的格式包装 token。
 *
 * 依据 `browser-login.ts` 写回页面时用的就是这一层包装（`{"value":…,"__version":"0"}`），
 * 而 `login.ts` 读的时候也解这一层 —— 两边必须一致，否则页面读出来是空串。
 */
export function wrapUserToken(token: string): string {
  return JSON.stringify({ value: token, __version: '0' })
}

/**
 * 从一次真实请求的头里抽出可以写回页面的会话值。
 *
 * **纯函数** —— 用例直接断言产物，不去断源码位置。
 * 没有任何可写的值 ⇒ 返回空数组（调用方据此跳过安装，不发多余的 CDP 调用）。
 */
export function pageSessionFromHeaders(rawHeaders: Record<string, string>): PageSessionWrite[] {
  const writes: PageSessionWrite[] = []

  const authorization = headerValue(rawHeaders, 'authorization')
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const token = bearer ? bearer[1].trim() : ''
  if (token) writes.push({ key: 'userToken', value: wrapUserToken(token) })

  const hifLeim = headerValue(rawHeaders, 'x-hif-leim').trim()
  // 页面读这个键时会判断首字符是不是引号（`hif_leim_cached` 存的是 JSON 串），
  // 所以按 JSON 串写；这样与站点自己写的形态一致，读回来仍是同一个字符串。
  if (hifLeim) writes.push({ key: 'hif_leim_cached', value: JSON.stringify(hifLeim) })

  return writes
}

/**
 * 生成页面内执行的安装脚本（**纯函数产物**）。
 *
 * 三件事，缺一不可：
 * 1. 逐个写（单个键失败不能拖垮其余的）；
 * 2. **读回来核对** —— 写进去不等于真的生效（隐私设置/存储被禁用时会静默丢弃）；
 * 3. 把结果 JSON 化返回，让 Node 侧能按 `verified` 判断，而不是假定成功。
 *
 * ⚠️ 返回的字符串里**不含反引号**：它会被嵌进 `browser-transport.ts` 的模板字符串里，
 * 一个反引号就会提前终止外层字符串（那边已有同类注释踩过这个坑）。
 */
export function buildSessionInstallExpression(writes: PageSessionWrite[], cookies: string[] = []): string {
  return (
    '(function(){' +
    /**
     * 🔴 源检查（dsh-webin 实测的坑）：`about:blank` 是 opaque origin，
     * storage 按源隔离 —— 在错的源上写**等于白写**（它那边就是因为这个才发现
     * "每次重启 DSH 都要重新登录"）。所以这里显式报出 origin，不静默吞掉。
     */
    'var origin="";try{origin=String(location.origin);}catch(e){}' +
    'var wrongOrigin=(!origin||origin==="null"||origin==="about:blank");' +
    'var writes=' + JSON.stringify(writes) + ';' +
    'var cookies=' + JSON.stringify(cookies) + ';' +
    'var written=[],failed=[],cookiesWritten=0;' +
    /**
     * cookie 也要回写（webin：快照里存了 cookie 却不写回 = 白存）。
     * ⚠️ httpOnly cookie 用 JS 既读不到也写不了（浏览器安全模型，不是实现问题）。
     */
    'if(!wrongOrigin){for(var c=0;c<cookies.length;c++){' +
    'try{document.cookie=cookies[c]+"; path=/";cookiesWritten++;}catch(e){}}}' +
    'for(var i=0;i<writes.length;i++){' +
    'try{localStorage.setItem(writes[i].key,writes[i].value);written.push(writes[i].key);}' +
    'catch(e){failed.push(writes[i].key);}' +
    '}' +
    'var verified={};' +
    'for(var j=0;j<written.length;j++){try{verified[written[j]]=localStorage.getItem(written[j]);}catch(e){verified[written[j]]=null;}}' +
    'return JSON.stringify({written:written,failed:failed,verified:verified,' +
    'origin:origin,wrongOrigin:wrongOrigin,cookiesWritten:cookiesWritten,cookiesTotal:cookies.length});' +
    '})()'
  )
}

/** 页面脚本**自己**能报回来的事实（它不知道"期望值"，只知道写没写、读回什么）。 */
export interface PageSessionReport {
  /** 真的写进去的键。 */
  written: string[]
  /** 写入抛错的键。 */
  failed: string[]
  /** 读回来核对的结果：键 → 读到的值（读不到为 null）。 */
  verified: Record<string, string | null>
}

/** 上面那份报告 + Node 侧按原值比对出的差异。 */
export interface PageSessionInstallResult extends PageSessionReport {
  /** 写进去但读回来对不上原值的键 —— 真正的"静默失败"。 */
  mismatched: string[]
}

/**
 * 解析页面脚本的返回值。
 *
 * 🔴 解析失败**不抛错**，而是返回一个 empty 结果：调用方（传输层）在请求路径上，
 * 一个诊断性质的安装失败不该让整次请求挂掉。但 `written` 为空 + `failed` 为空
 * 这种"什么都没发生"的形态必须能被调用方看见（否则又是一次静默失败）。
 */
export function parseSessionInstallResult(raw: unknown): PageSessionReport {
  const empty: PageSessionReport = { written: [], failed: [], verified: {} }
  if (typeof raw !== 'string' || !raw) return empty
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object') return empty

  const written = Array.isArray(parsed.written) ? parsed.written.map(String) : []
  const failed = Array.isArray(parsed.failed) ? parsed.failed.map(String) : []
  const verified: Record<string, string | null> =
    parsed.verified && typeof parsed.verified === 'object' ? parsed.verified : {}

  return { written, failed, verified }
}

/**
 * 按原值核对一次（独立出来是为了让 `mismatched` 一定有值可判，
 * 而不是解析时拿不到原值就只能空着）。
 */
export function diffSessionWrites(report: PageSessionReport, writes: PageSessionWrite[]): string[] {
  const mismatched: string[] = []
  for (const write of writes) {
    if (!report.written.includes(write.key)) continue
    const readBack = report.verified[write.key]
    if (readBack !== write.value) mismatched.push(write.key)
  }
  return mismatched
}

/** 传输层会话里记登录态的两个槽位（结构类型，避免 import browser-transport）。 */
export interface PageSessionSlot {
  /** 上一次**真的装成功**的签名。 */
  signature?: string
  /** 正在装（**不代表成功**）。 */
  installing?: string
}

/**
 * 这次请求该不该把登录态装进页面？**纯函数** —— 把"瞬时失败后必须重试"这条语义
 * 固定下来，而不是留在调用点的 if 条件里（那块代码已经因此错过一次）。

 * 判据：
 * - `writes` 为空 ⇒ 不装（这条请求压根没有可写的值，比如不带 `Authorization` 的内部请求）；
 * - 与上次**成功**的签名相同 ⇒ 不装（幂等，别每次请求都重载页面）；
 * - 正在装同一个签名 ⇒ 不装（挡并发重复安装/重载）；
 * - 其余 ⇒ 装。
 *
 * 🔴 关键点：签名只在**成功**后写入 ⇒ 上次失败（比如页面没停在站点 origin、
 * localStorage 是 opaque origin）这次仍会重试。若把"尝试中"与"装成了"混成一个槽，
 * 一次瞬时失败就会变成这条浏览器会话**永远不再重试**。
 */
export function shouldInstallPageSession(
  slot: PageSessionSlot,
  signature: string,
  writeCount: number,
): boolean {
  if (writeCount === 0) return false
  if (slot.signature === signature) return false
  if (slot.installing === signature) return false
  return true
}

/**
 * 安装过程的副作用。真实实现走 CDP；用例传假的 ⇒ 整条流程可以在**同一进程内**验证。
 */
export interface PageSessionEffects {
  install: (writes: PageSessionWrite[]) => Promise<PageSessionInstallResult>
  /** 装成功后：重载页面 + 重装绑定通道；返回绑定是否就绪。 */
  afterInstall: () => Promise<boolean>
  warn: (message: string) => void
}

/** 一次安装尝试的结果。 */
export interface PageSessionOutcome {
  /** 这次到底有没有发起安装。 */
  attempted: boolean
  /** 登录态是否真的落进页面。 */
  installed: boolean
}

/**
 * 完整流程：该不该装 → 装 → 读回来核对 → 重载 + 重装绑定。
 *
 * 🔴 `slot.signature` **只在装成功后**写入 ⇒ 一次瞬时失败下次仍会重试。
 * 这条语义**由本函数持有**，调用点不再自己拼 if 条件与置位顺序。
 *
 * 0.9.1 的教训：当时是在调用点"**尝试前先置位**"，于是一次 `ensureSiteOrigin`
 * 超时（页面没停在站点 origin ⇒ localStorage 是 opaque origin、一条都写不进去）
 * 就让整条浏览器会话**永远不再重试** —— 又是一次静默失败。
 * 把顺序从调用点搬进这个被测函数，才不会下次又被写回去。
 */
export async function runPageSessionInstall(
  slot: PageSessionSlot,
  writes: PageSessionWrite[],
  effects: PageSessionEffects,
): Promise<PageSessionOutcome> {
  const signature = JSON.stringify(writes)
  if (!shouldInstallPageSession(slot, signature, writes.length)) {
    return { attempted: false, installed: false }
  }
  slot.installing = signature
  try {
    const applied = await effects.install(writes)
    if (applied.written.length === 0) {
      effects.warn(
        '登录态一条都没写进传输层页面 —— 页面会显示未登录、站点自己的心跳起不来' +
        '（本次请求本身不受影响，下次请求会重试）',
      )
    }
    for (const key of applied.mismatched) {
      effects.warn(`登录态 ${key} 写进去后读回来不一致（被静默丢弃了）`)
    }
    if (applied.written.length === 0) return { attempted: true, installed: false }

    // 🔴 成功之后才记签名 —— 这两行的顺序不能反（反了就是上面那条教训）。
    slot.signature = signature
    const bindingsOk = await effects.afterInstall()
    if (!bindingsOk) {
      effects.warn('重载后回调通道没能重新建立 —— 本次请求可能会失败（这不是凭证问题）')
    }
    return { attempted: true, installed: true }
  } catch (error: any) {
    effects.warn(`装载页面登录态失败：${error?.message ?? error}`)
    return { attempted: true, installed: false }
  } finally {
    slot.installing = undefined
  }
}

/**
 * 把会话装进传输层页面的 localStorage。
 *
 * `Runtime.evaluate` 用 `returnByValue: true` 拿回脚本的返回值。
 * 装完**必须重载页面**（由调用方做）—— 站点 JS 是在启动时读 `userToken` 的，
 * 不重载它不会发现自己"已登录"，装进去也白装。
 */
export async function installPageSessionViaCdp(
  cdp: CdpSender,
  writes: PageSessionWrite[],
): Promise<PageSessionInstallResult> {
  if (writes.length === 0) return { written: [], failed: [], verified: {}, mismatched: [] }

  const result: any = await cdp.send('Runtime.evaluate', {
    expression: buildSessionInstallExpression(writes),
    returnByValue: true,
  })
  const report = parseSessionInstallResult(result?.result?.value)
  return { ...report, mismatched: diffSessionWrites(report, writes) }
}

