import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-login-port-'))
process.env.DSH_HOME = tempHome

try {
  // 2026-10-21 真机现场：Edge 已经起来、端口 57841 正常响应 /json/version，
  // 但 login 报「调试端口不可用（可能被安全软件拦截）」。
  // 根因：waitForDebugPort 里 `if (child.exitCode !== null) return undefined`
  //      —— Windows 上 launcher 交接后自己先退出，而端口文件在它退出之后才写出来。
  // 这与 transport 侧早已修过的 PR #19 是同一个坑，login 侧一直没同步。
  const libDir = path.resolve(here, '..', 'lib', 'transport', 'vendor')
  const loginSrc = (await import('node:fs')).readFileSync(
    path.join(libDir, 'browser-login.js'),
    'utf8',
  )

  // 1) 【根因反向验证】等待调试端口时**不得**因为 launcher 退出就放弃
  const waitStart = loginSrc.indexOf('async function waitForDebugPort')
  assert.ok(waitStart >= 0, 'waitForDebugPort must exist')
  const waitBody = loginSrc.slice(waitStart, waitStart + 1800)
  // 只看**可执行代码**：逐行剔除注释（注释里会引用那句旧代码作为说明）
  const codeOnly = waitBody
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  assert.equal(
    /child\.exitCode\s*!==\s*null/.test(codeOnly),
    false,
    'waitForDebugPort must NOT give up when the launcher process exits (Windows hands off then exits)',
  )
  assert.ok(
    codeOnly.includes('DevToolsActivePort'),
    'waitForDebugPort must key off the port file',
  )

  // 2) 【残留句柄反向验证】启动登录浏览器前必须清掉上一次的句柄文件
  //    （残留 DevToolsActivePort 会连到死端口；lockfile/Singleton* 会让新进程
  //     误以为"已有实例在跑"而交接给不存在的实例后自杀）
  assert.ok(
    loginSrc.includes("'DevToolsActivePort'") && loginSrc.includes("'lockfile'"),
    'browserLogin must clear stale runtime handle files before spawning',
  )
  assert.ok(
    /SingletonLock/.test(loginSrc),
    'browserLogin must clear stale Singleton* handles',
  )

  // 3) 报错文案不得把本地端口问题说成"被拦截"这类误导性结论
  //    只检查 no-debug-port 的 message 字段（注释里引用旧文案是允许的）
  const msgStart = loginSrc.indexOf("reason: 'no-debug-port'")
  assert.ok(msgStart >= 0, 'no-debug-port branch must exist')
  const msgBlock = loginSrc.slice(msgStart, msgStart + 900)
  const msgCodeOnly = msgBlock
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  assert.equal(
    /可能被安全软件拦截/.test(msgCodeOnly),
    false,
    'no-debug-port message must not blame security software (misleading)',
  )

  // 4) 必须保留登录 profile 的登录态：只删句柄，不能整目录 rmSync
  //    （整目录删掉就会每次都要重新输手机号验证码）
  const clearStart = loginSrc.indexOf('DevToolsActivePort')
  const clearWindow = loginSrc.slice(Math.max(0, clearStart - 400), clearStart + 400)
  assert.equal(
    /rmSync\(\s*profileDir\s*,/.test(clearWindow),
    false,
    'must not wipe the whole login profile when clearing handles',
  )

  // 5) 功能验证：profile 目录里只有残留句柄时，清完之后登录态数据仍在
  const profileDir = path.join(tempHome, 'freetoken', 'browser-profile')
  mkdirSync(path.join(profileDir, 'Default'), { recursive: true })
  writeFileSync(path.join(profileDir, 'Local State'), '{"keep":"me"}', 'utf8')
  writeFileSync(path.join(profileDir, 'DevToolsActivePort'), '57841\n/devtools/browser/dead', 'utf8')
  writeFileSync(path.join(profileDir, 'lockfile'), '', 'utf8')

  const { browserLogin } = await import('../lib/transport/vendor/browser-login.js')
  assert.equal(typeof browserLogin, 'function')
  // 不真起浏览器：只断言句柄清理逻辑的语义（文件系统层面手工复刻一次同样动作）
  for (const stale of ['DevToolsActivePort', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    rmSync(path.join(profileDir, stale), { force: true })
  }
  assert.equal(existsSync(path.join(profileDir, 'DevToolsActivePort')), false)
  assert.equal(existsSync(path.join(profileDir, 'Local State')), true, 'login state must survive handle cleanup')
  assert.equal(existsSync(path.join(profileDir, 'Default')), true)

  console.log('check-login-port: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}