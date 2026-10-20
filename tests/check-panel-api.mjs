/**
 * 面板 API 离线验收（M15 / M17 / M27 / P5.2 / P5.5）。
 *
 * 覆盖：
 *  - GET /status -> 200 + JSON 快照；GET /narration -> 200 + 三字段；
 *  - 404 / 405 / 500 分支；查询串与宿主前缀透传容忍；
 *  - 全响应递归扫描，确认没有 token / cookie / credential 一类键；
 *  - 静态检查 client.ts 的模块加载器格式、槽位、接口路径与禁用基座字样；
 *  - 静态检查 status-api.ts 只含 type-only 导入（轻模块）。
 * 全部使用 mock req/res，不发真实网络请求。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../lib/config.js'
import { disabledSnapshot } from '../lib/status.js'
import { JsonResponse, createStatusApiHandler } from '../lib/panel/status-api.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const srcRoot = path.join(root, 'src')
const libRoot = path.join(root, 'lib')

/** 极简 res mock：记录状态码 / 头 / 响应体，不触网、不落盘。 */
function createResponse() {
  const headers = new Map()
  return {
    statusCode: 0,
    headers,
    body: '',
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value))
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

function invoke(handler, req) {
  const res = createResponse()
  const returned = handler(req, res)
  return { res, returned }
}

function json(res) {
  assert.ok(res.body, 'response body must be non-empty JSON')
  return JSON.parse(res.body)
}

/** 完整快照夹具：覆盖面板要展示的全部字段与风险指标。 */
function buildSnapshot() {
  const snapshot = disabledSnapshot(normalizeConfig({ enabled: true }))
  snapshot.enabled = true
  snapshot.started = true
  snapshot.phase = 'silence'
  snapshot.login = { loggedIn: true, lastVerifiedAt: 1700000000000, lastError: null }
  snapshot.identity = { deviceId: 'device-0123456789abcdef', backend: 'cdp', singleInstance: true }
  snapshot.browser = { running: true, pid: 4321 }
  snapshot.lock = { held: true, heldBy: 'turn-1', heldMs: 1500 }
  snapshot.queue = { pending: 2, maxPending: 8 }
  snapshot.rhythm = {
    silent: true,
    silenceRemainingMs: 42000,
    todayRequests: 3,
    dailyBudget: 50,
    lastRequestAt: 1700000000000,
    msSinceLastRequest: 5000,
    lastBlock: { reason: 'silence', at: 1700000000000, until: 1700000042000 },
  }
  snapshot.retry = { attempts: 1, nextDelayMs: 5000 }
  snapshot.safety = { testAccountOnly: true, mutedUntil: 1700000100000, halted: false, haltReason: null }
  snapshot.lastFailure = { at: 1700000000000, code: 'PROBE', message: 'probe failed (401)' }
  snapshot.narration = { model: 'narration-v1', local: '本地模板', dedupeSuppressed: 2 }
  snapshot.metrics = {
    requests: 7,
    titleSaved: 5,
    coalesced: 1,
    batchSplit: 0,
    partialFailure: 0,
    requestsPerTurnMedian: 1.5,
  }
  snapshot.lazyLoaded = ['transport/real-backend', 'protocol/narration']
  snapshot.updatedAt = 1700000000000
  return snapshot
}

// 0) JsonResponse：纯数据载体；handler 必须返回 void
assert.equal(new JsonResponse(418, { ok: false }).statusCode, 418)
assert.deepEqual(new JsonResponse(418, { ok: false }).body, { ok: false })

const snapshot = buildSnapshot()
const handler = createStatusApiHandler(() => structuredClone(snapshot))

// 1) GET /status -> 200 + 快照 JSON + 正确响应头
{
  const { res, returned } = invoke(handler, { method: 'GET', url: '/status' })
  assert.equal(returned, undefined, 'handler must return void')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = json(res)
  assert.deepEqual(body, snapshot)
  // M15 / M27：风险指标必须在线上如实出现
  assert.equal(body.rhythm.silent, true)
  assert.equal(body.rhythm.silenceRemainingMs, 42000)
  assert.equal(body.rhythm.todayRequests, 3)
  assert.equal(body.rhythm.dailyBudget, 50)
  assert.equal(body.rhythm.lastRequestAt, 1700000000000)
  assert.equal(body.rhythm.msSinceLastRequest, 5000)
  assert.equal(body.rhythm.lastBlock.reason, 'silence')
  assert.equal(body.safety.halted, false)
  assert.equal(body.lastFailure.code, 'PROBE')
}

// 2) 查询串 / 末尾斜杠 / 宿主透传完整前缀均容忍（P5.5 诚实关闭态的前提）
for (const url of ['/status?x=1&y=2', '/status/', '/freetoken/api/status?t=1700000000000']) {
  const { res } = invoke(handler, { method: 'GET', url })
  assert.equal(res.statusCode, 200, `status route must tolerate ${url}`)
  assert.deepEqual(json(res), snapshot, `status body must not change for ${url}`)
}

// 3) GET /narration -> 200 + 恰好三字段（不外泄其它状态）
{
  const { res } = invoke(handler, { method: 'GET', url: '/narration?x=1' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = json(res)
  assert.deepEqual(body, { model: 'narration-v1', local: '本地模板', suppressed: 2 })
  assert.deepEqual(Object.keys(body).sort(), ['local', 'model', 'suppressed'])
}

// 4) 未知路由 -> 404 {ok:false}
for (const url of ['/unknown', '/unknown?x=1', '/']) {
  const { res } = invoke(handler, { method: 'GET', url })
  assert.equal(res.statusCode, 404, `unknown route must be 404: ${url}`)
  assert.equal(json(res).ok, false)
  assert.equal(res.headers.get('cache-control'), 'no-store')
}

// 5) 非 GET -> 405 {ok:false}；method 缺失同样按非 GET 拒绝
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const { res } = invoke(handler, { method, url: '/status' })
  assert.equal(res.statusCode, 405, `${method} /status must be 405`)
  assert.equal(json(res).ok, false)
}
{
  const { res } = invoke(handler, { url: '/status' })
  assert.equal(res.statusCode, 405, 'missing method must be rejected as non-GET')
}

// 6) 快照抛错 / 快照缺失 -> 500 {ok:false}（异常绝不冒泡进宿主）
for (const url of ['/status', '/narration']) {
  const failing = createStatusApiHandler(() => {
    throw new Error('snapshot boom')
  })
  const { res } = invoke(failing, { method: 'GET', url })
  assert.equal(res.statusCode, 500, `snapshot failure must be 500: ${url}`)
  assert.equal(json(res).ok, false)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
}
{
  const missing = createStatusApiHandler(() => undefined)
  assert.equal(invoke(missing, { method: 'GET', url: '/status' }).res.statusCode, 500)
}

// 7) 响应对象本身写失败时 handler 也不抛
{
  const fragile = createStatusApiHandler(() => structuredClone(snapshot))
  assert.doesNotThrow(() =>
    fragile(
      { method: 'GET', url: '/status' },
      {
        statusCode: 0,
        setHeader() {
          throw new Error('socket closed')
        },
        end() {},
      },
    ),
  )
}

// 8) 无凭证键：全响应递归扫描 key（M15 凭证红线的机器兜底）
const FORBIDDEN_KEY = /token|cookie|authorization|credential|password|secret|api[_-]?key|hifdliq/i
function walkKeys(value, trail, hits) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, `${trail}[${index}]`, hits))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) hits.push(`${trail}.${key}`)
    walkKeys(child, `${trail}.${key}`, hits)
  }
}
for (const url of ['/status', '/narration']) {
  const hits = []
  walkKeys(json(invoke(handler, { method: 'GET', url }).res), url, hits)
  assert.deepEqual(hits, [], `credential-looking keys are forbidden in ${url} response`)
}

// 9) client.ts 静态契约：模块加载器格式 / 槽位 / 接口路径 / 无基座字样
const clientSource = readFileSync(path.join(srcRoot, 'client.ts'), 'utf8')
assert.ok(clientSource.startsWith('// @ts-nocheck'), 'client.ts must start with @ts-nocheck')
for (const marker of [
  'window.__ModuleLoader__.load',
  'settings.section',
  '/freetoken/api/status',
  'dsh-freetoken',
  'exports.apply',
  'exports.inject',
  'ctx.slots.register',
  'window.setInterval',
  'window.clearInterval',
  'react.useEffect',
  '已关闭（未启用）',
  'silenceRemainingMs',
  'lastRequestAt',
  'msSinceLastRequest',
  'lastBlock',
  'dailyBudget',
  'lazyLoaded',
]) {
  assert.ok(clientSource.includes(marker), `client.ts must contain ${marker}`)
}
for (const forbidden of ['dsh-deepseek-web-login', 'deepseek-web-login']) {
  assert.equal(clientSource.includes(forbidden), false, `client.ts must not reference ${forbidden}`)
}
assert.equal(/^(?:import|export)\b/m.test(clientSource), false, 'client.ts must stay a loader script (no top-level import/export)')

// 10) status-api.ts 轻模块：只有 type-only 导入、无 fetch、无 Node 内建
const apiSource = readFileSync(path.join(srcRoot, 'panel', 'status-api.ts'), 'utf8')
const apiImports = apiSource.match(/^import\b[^\n]*/gm) ?? []
assert.ok(apiImports.length >= 1, 'status-api.ts must import the snapshot type')
for (const line of apiImports) {
  assert.match(line, /^import\s+type\b/, `status-api.ts must use type-only imports: ${line}`)
  assert.equal(/node:/.test(line), false, `status-api.ts must not import node builtins: ${line}`)
}
assert.equal(/\bfetch\s*\(/.test(apiSource), false, 'status-api.ts must not fetch')
assert.ok(apiSource.includes('createStatusApiHandler'), 'status-api.ts must export createStatusApiHandler')

// 11) 构建产物：tsc 必须把 client.ts 原样发到 lib/client.js，且宿主入口不 import 它
const clientLibPath = path.join(libRoot, 'client.js')
assert.ok(existsSync(clientLibPath), 'tsc must emit lib/client.js')
const clientLib = readFileSync(clientLibPath, 'utf8')
for (const marker of ['window.__ModuleLoader__.load', 'settings.section', '/freetoken/api/status']) {
  assert.ok(clientLib.includes(marker), `lib/client.js must contain ${marker}`)
}
assert.equal(clientLib.includes('dsh-deepseek-web-login'), false, 'lib/client.js must not reference the base plugin')
// DSH 用 classic script 注入插件 bundle（client-modules 的 defaultLoadBundle：
// document.createElement('script') + el.src），所以产物必须是纯脚本。
// tsc 在 NodeNext + package.type=module 下会自动追加 `export {};` —— 那会让整个
// bundle 触发 SyntaxError，面板一个组件都注册不上，必须剥掉。
assert.equal(
  /^(?:import|export)\b/m.test(clientLib),
  false,
  "lib/client.js must stay a classic script: no top-level import/export (strip tsc's `export {};` marker)",
)
const hostEntry = readFileSync(path.join(libRoot, 'index.js'), 'utf8')
assert.equal(
  /(?:from|require\s*\()\s*['"][^'"]*client\.js/.test(hostEntry),
  false,
  'host entry must never import the browser bundle',
)

console.log('check-panel-api: PASS')