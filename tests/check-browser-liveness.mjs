import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 0.5.1 回归：浏览器关闭判据（R7 勘误 2026-10-23）。
 *
 * 事故：Windows 上 msedge 的 launcher 交棒后自然退出，旧判据
 * `child.exitCode !== null || child.killed` 在真浏览器仍开着时直接报
 * browser-closed（现场：browser-profile 进程活着、CDP 端口正常响应）。
 *
 * 反向验证：把实现改回旧判据，本用例必须红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-liveness-'))
process.env.DSH_HOME = tempHome

try {
  const { isBrowserGone } = await import('../lib/transport/vendor/browser-login.js')

  // 1) launcher 自然退出：killed=false，CDP 正常 → 不能判为关闭
  assert.equal(
    isBrowserGone({ killed: false, cdpMisses: 0, missLimit: 8 }),
    false,
    'launcher 自然退出被误判为浏览器关闭（旧缺陷复发）',
  )
  // 2) 显式 kill → 立即判定关闭
  assert.equal(isBrowserGone({ killed: true, cdpMisses: 0, missLimit: 8 }), true, '显式 kill 应判定关闭')
  // 3) CDP 连续失联达上限 → 判定关闭
  assert.equal(
    isBrowserGone({ killed: false, cdpMisses: 8, missLimit: 8 }),
    true,
    'CDP 连续失联达上限应判定关闭',
  )
  // 4) 失联未达上限 → 仍在等待（页面跳转期的短暂失败不能提前放弃）
  assert.equal(
    isBrowserGone({ killed: false, cdpMisses: 7, missLimit: 8 }),
    false,
    'CDP 失联未达上限不应提前放弃',
  )

  // 5) 反向验证：剥掉注释后，源码里不得再有「子进程退出即关闭」的旧判据
  //（注释里提到旧写法是允许的，判据只看真实代码）
  const src = readFileSync(path.join(here, '..', 'src', 'transport', 'vendor', 'browser-login.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(
    code.includes('child.exitCode !== null'),
    false,
    '旧判据残留：launcher 退出会被误判为浏览器关闭',
  )
  assert.equal(code.includes('isBrowserGone('), true, '新判据 isBrowserGone 未接线')

  console.log('check-browser-liveness: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}