import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-keepalive-'))
process.env.DSH_HOME = tempHome

try {
  const { createTransportKeepAlive, judgeKeepAlive, jitterInterval, DEFAULT_KEEPALIVE_INTERVAL_MS } =
    await import('../lib/transport/keep-alive.js')

  const ORIGIN = 'https://chat.deepseek.com'

  // 1) 判据：活着 / 被导航走 / 页面登出 / 探测失败（含达到阈值才判死）
  assert.equal(judgeKeepAlive({ url: `${ORIGIN}/a/chat`, readyState: 'complete', userToken: 'tok-123456789' }, ORIGIN, 0, 3).state, 'alive')
  assert.equal(judgeKeepAlive({ url: 'https://example.com/', readyState: 'complete', userToken: 'tok' }, ORIGIN, 0, 3).state, 'off-origin')
  assert.equal(judgeKeepAlive({ url: `${ORIGIN}/sign_in`, readyState: 'complete', userToken: '' }, ORIGIN, 0, 3).state, 'logged-out')
  const firstFail = judgeKeepAlive(null, ORIGIN, 0, 3)
  assert.equal(firstFail.state, 'dead')
  assert.equal(firstFail.fatal, false, 'single probe failure must not be fatal')
  const thirdFail = judgeKeepAlive(null, ORIGIN, 2, 3)
  assert.equal(thirdFail.state, 'dead')
  assert.equal(thirdFail.fatal, true, 'after N failures it becomes fatal (restart)')

  // 2) 域名边界：前缀相同但不是同站，不能判 alive
  assert.equal(judgeKeepAlive({ url: 'https://chat.deepseek.com.evil.example/', readyState: 'complete', userToken: 't' }, ORIGIN, 0, 3).state, 'off-origin')

  // 3) 抖动间隔：非固定周期，且夹在合理范围
  assert.ok(jitterInterval(DEFAULT_KEEPALIVE_INTERVAL_MS, () => 0) >= 1_000)
  const low = jitterInterval(DEFAULT_KEEPALIVE_INTERVAL_MS, () => 0)
  const high = jitterInterval(DEFAULT_KEEPALIVE_INTERVAL_MS, () => 1)
  assert.notEqual(low, high, 'interval must not be constant')
  assert.ok(low < DEFAULT_KEEPALIVE_INTERVAL_MS && high > DEFAULT_KEEPALIVE_INTERVAL_MS)

  // 4) 页面被导航走 → 触发导航回站点（且不重启浏览器）
  {
    let navigated = 0
    let invalidated = 0
    const ka = createTransportKeepAlive({
      probe: async () => ({ url: 'https://example.com/', readyState: 'complete', userToken: 'x' }),
      browserAvailable: () => true,
      ensureStarted: async () => {},
      navigateToSite: async () => {
        navigated += 1
        return true
      },
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {
        invalidated += 1
      },
    })
    const snap = await ka.beatOnce()
    assert.equal(snap.state, 'off-origin')
    assert.equal(navigated, 1)
    assert.equal(invalidated, 0)
    ka.stop()
  }

  // 5) 页面丢登录态 → 作废安装签名（让下次请求重装），不重启浏览器
  {
    let stale = 0
    let invalidated = 0
    const ka = createTransportKeepAlive({
      probe: async () => ({ url: `${ORIGIN}/`, readyState: 'complete', userToken: '' }),
      browserAvailable: () => true,
      ensureStarted: async () => {},
      navigateToSite: async () => false,
      markPageSessionStale: () => {
        stale += 1
      },
      requestsInFlight: () => 0,
      invalidateSession: () => {
        invalidated += 1
      },
    })
    await ka.beatOnce()
    assert.equal(stale, 1)
    assert.equal(invalidated, 0)
    ka.stop()
  }

  // 6) 【关键】浏览器被误关（连续探测失败达阈值）→ 自动重新拉起，这就是"防误触"的兜底
  {
    let invalidated = 0
    let restarts = 0
    let failures = 0
    const ka = createTransportKeepAlive({
      // 前两次探测失败，第三次也失败 → 达到 stopAfterFailures=3 判定为真死
      probe: async () => {
        failures += 1
        return null
      },
      browserAvailable: () => true,
      ensureStarted: async () => {
        restarts += 1
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {
        invalidated += 1
      },
      stopAfterFailures: 3,
    })
    const a = await ka.beatOnce()
    assert.equal(a.state, 'dead')
    assert.equal(restarts, 0, 'must not restart on the first failure')
    const b = await ka.beatOnce()
    assert.equal(b.state, 'dead')
    assert.equal(restarts, 0, 'must not restart on the second failure')
    const c = await ka.beatOnce()
    assert.equal(invalidated, 1, 'session must be invalidated before restart')
    assert.equal(restarts, 1, 'browser must be restarted automatically after N failures')
    assert.equal(c.restarts, 1)
    ka.stop()
  }

  // 7) 没有可用浏览器 → 不尝试重启（避免无意义的报错循环）
  {
    let restarts = 0
    const ka = createTransportKeepAlive({
      probe: async () => null,
      browserAvailable: () => false,
      ensureStarted: async () => {
        restarts += 1
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
    })
    for (let i = 0; i < 5; i += 1) await ka.beatOnce()
    assert.equal(restarts, 0)
    ka.stop()
  }

  // 8) 重启失败不抛（不能把守护本身打挂），但会记录
  {
    const logs = []
    const ka = createTransportKeepAlive({
      probe: async () => null,
      browserAvailable: () => true,
      ensureStarted: async () => {
        throw new Error('spawn failed')
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
      stopAfterFailures: 1,
      logger: { warn: (m) => logs.push(m) },
    })
    const snap = await ka.beatOnce()
    assert.ok(snap, 'beatOnce must resolve even when restart fails')
    assert.ok(logs.some((m) => /restart failed/.test(m)), 'restart failure must be logged')
    ka.stop()
  }

  // 9) 常驻 profile 复用：存在可用的 Local State + Default 时不得被清空（S2.1 反向验证）
  const transport = await import('../lib/transport/vendor/browser-transport.js')
  const profile = path.join(tempHome, 'freetoken', 'transport-profile')
  mkdirSync(path.join(profile, 'Default'), { recursive: true })
  writeFileSync(path.join(profile, 'Local State'), '{"marker":"keep-me"}', 'utf8')
  writeFileSync(path.join(profile, 'Default', 'Cookies'), 'cookie-db', 'utf8')
  // 旧句柄文件（复用 profile 时必须清掉，否则会连到死端口/被误判单实例）
  writeFileSync(path.join(profile, 'DevToolsActivePort'), '49480\n/devtools/browser/dead\n', 'utf8')
  writeFileSync(path.join(profile, 'lockfile'), '', 'utf8')
  writeFileSync(path.join(profile, 'SingletonLock'), 'stale', 'utf8')

  const before = path.join(profile, 'Local State')
  assert.equal(transport.currentTransportUserAgent(), undefined)
  // 该文件必须仍在（说明没有任何代码在 import 时就重建 profile）
  const { existsSync, readFileSync } = await import('node:fs')
  assert.equal(existsSync(before), true)
  assert.match(readFileSync(before, 'utf8'), /keep-me/)

  // 复用后仍保留登录态数据（cookies 文件不能被删）——这是"会话常驻"的物理前提
  assert.equal(existsSync(path.join(profile, 'Default', 'Cookies')), true)

  // 复用分支必须清掉旧句柄文件（否则会连到已退出的浏览器 / 被判定"已有实例"）
  // 通过导出函数验证：调用一次"准备 profile"的等价入口（不 spawn 浏览器）。
  const { prepareTransportProfileForTest } = transport
  if (typeof prepareTransportProfileForTest === 'function') {
    await prepareTransportProfileForTest(profile, async () => {})
    assert.equal(existsSync(path.join(profile, 'DevToolsActivePort')), false, 'stale DevToolsActivePort must be removed')
    assert.equal(existsSync(path.join(profile, 'lockfile')), false, 'stale lockfile must be removed')
    assert.equal(existsSync(path.join(profile, 'SingletonLock')), false, 'stale SingletonLock must be removed')
    // 登录态数据必须还在（复用不等于清空）
    assert.equal(existsSync(before), true)
    assert.equal(existsSync(path.join(profile, 'Default', 'Cookies')), true)
  }

  // 10) 【P0-2 反向验证】有在飞请求时，即使判死也**绝不能**杀浏览器/重启
  {
    let invalidated = 0
    let restarts = 0
    const ka = createTransportKeepAlive({
      probe: async () => null,
      browserAvailable: () => true,
      ensureStarted: async () => {
        restarts += 1
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      // 关键：模拟"正在跑一个流式请求"
      requestsInFlight: () => 2,
      invalidateSession: () => {
        invalidated += 1
      },
      stopAfterFailures: 1,
    })
    for (let i = 0; i < 4; i += 1) await ka.beatOnce()
    assert.equal(invalidated, 0, 'must NOT kill the browser while requests are in flight')
    assert.equal(restarts, 0, 'must NOT restart while requests are in flight')
    assert.match(String(ka.snapshot().lastReason), /在飞/, 'reason must explain why it waited')
    ka.stop()
  }

  // 11) 【P1-1 反向验证】恢复动作只在状态**变化**时做（否则每拍都整页导航/作废）
  {
    let navigated = 0
    const ka = createTransportKeepAlive({
      probe: async () => ({ url: 'https://example.com/', readyState: 'complete', userToken: 'x' }),
      browserAvailable: () => true,
      ensureStarted: async () => {},
      navigateToSite: async () => {
        navigated += 1
        return true
      },
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
    })
    for (let i = 0; i < 5; i += 1) await ka.beatOnce()
    assert.ok(navigated <= 2, `off-origin navigation must not happen every beat (got ${navigated})`)
    ka.stop()
  }

  // 12) 【P1-2 反向验证】重启失败必须进退避，不能每拍都 spawn
  {
    let attempts = 0
    const ka = createTransportKeepAlive({
      probe: async () => null,
      browserAvailable: () => true,
      ensureStarted: async () => {
        attempts += 1
        throw new Error('spawn failed')
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
      stopAfterFailures: 1,
      logger: { warn: () => {} },
    })
    for (let i = 0; i < 6; i += 1) await ka.beatOnce()
    assert.ok(attempts <= 2, `restart attempts must back off, got ${attempts} over 6 beats`)
    ka.stop()
  }

  // 13) 【P2 反向验证】stop() 之后在飞的 beat 不得再拉起浏览器（避免孤儿进程占 profile）
  {
    let spawns = 0
    let releaseProbe
    const gate = new Promise((resolve) => {
      releaseProbe = resolve
    })
    const ka = createTransportKeepAlive({
      probe: async () => {
        await gate
        return null
      },
      browserAvailable: () => true,
      ensureStarted: async () => {
        spawns += 1
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
      stopAfterFailures: 1,
      logger: { warn: () => {} },
    })
    const pending = ka.beatOnce()
    ka.stop() // 在探测挂住期间停表
    releaseProbe()
    await pending
    assert.equal(spawns, 0, 'stopped keep-alive must not spawn a browser')
  }

  // 14) start()/stop() 生命周期：排程可停可重开（面板/重新登录后要能恢复守护）
  {
    const timers = []
    let cleared = 0
    const ka = createTransportKeepAlive({
      probe: async () => ({ url: 'https://chat.deepseek.com/', readyState: 'complete', userToken: 'tok' }),
      browserAvailable: () => true,
      ensureStarted: async () => {},
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return { id: timers.length }
      },
      clearTimer: () => {
        cleared += 1
      },
    })
    assert.equal(ka.running(), false)
    ka.start()
    assert.equal(ka.running(), true)
    assert.equal(timers.length, 1)
    const firstDelay = timers[0].ms
    ka.stop()
    assert.equal(ka.running(), false)
    assert.equal(cleared, 1, 'stop() must clear the timer')
    // stop() 后可以重新 arm（例如重新登录后恢复守护）
    ka.start()
    assert.equal(ka.running(), true)
    ka.stop()
    // 巡检间隔带抖动（不是固定周期）
    const delays = new Set()
    for (let i = 0; i < 20; i += 1) delays.add(jitterInterval(firstDelay, Math.random))
    assert.ok(delays.size > 1, 'keep-alive interval must be jittered, not constant')
  }

  // 15) 【P1-5 反向验证】状态变化必须上报（否则面板永远显示 idle）
  {
    const seen = []
    const ka = createTransportKeepAlive({
      probe: async () => ({ url: 'https://chat.deepseek.com/', readyState: 'complete', userToken: 'tok' }),
      browserAvailable: () => true,
      ensureStarted: async () => {},
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
      onState: (s) => seen.push(s.state),
    })
    await ka.beatOnce()
    assert.deepEqual(seen, ['alive'], 'keep-alive must report state changes to the host')
    ka.stop()
  }

  // 16) 【P1-4 反向验证】损坏的 profile 不得被判"可复用"（必须走重建）
  {
    const transport = await import('../lib/transport/vendor/browser-transport.js')
    const brokenRoot = path.join(tempHome, 'broken')
    mkdirSync(path.join(brokenRoot, 'Default'), { recursive: true })
    // 半截/非法 JSON 的 Local State：只看"文件存在"会误判可复用
    writeFileSync(path.join(brokenRoot, 'Local State'), '{"broken": ', 'utf8')
    writeFileSync(path.join(brokenRoot, 'Default', 'Cookies'), 'x', 'utf8')
    const marker = path.join(brokenRoot, 'Local State')
    await transport.prepareTransportProfileForTest(brokenRoot, async () => {})
    // 走重建分支 ⇒ 旧目录被改名/删除，全新的 Local State 不存在（空 profile）
    const after = existsSync(marker) ? readFileSync(marker, 'utf8') : ''
    assert.notEqual(after, '{"broken": ', 'corrupted profile must be rebuilt, not reused')

    // 只有 Default、没有 Local State 的目录同样不可复用
    const halfRoot = path.join(tempHome, 'half')
    mkdirSync(path.join(halfRoot, 'Default'), { recursive: true })
    await transport.prepareTransportProfileForTest(halfRoot, async () => {})
    assert.equal(existsSync(path.join(halfRoot, 'Local State')), false, 'rebuild must not fabricate Local State')
  }

  // 17) 【P0-1 反向验证】预检阈值必须可配置（0 = 关闭），且默认为 90 分钟
  {
    const { normalizeConfig } = await import('../lib/config.js')
    const cfg = normalizeConfig({ enabled: true })
    assert.equal(cfg.session.credentialRefreshAgeMs, 90 * 60 * 1000, 'default precheck threshold')
    assert.equal(
      normalizeConfig({ enabled: true, session: { credentialRefreshAgeMs: 0 } }).session
        .credentialRefreshAgeMs,
      0,
      'precheck must be switchable off',
    )
    // 越界被夹取（不允许超过 6 小时，也不允许负数）
    assert.equal(
      normalizeConfig({ enabled: true, session: { credentialRefreshAgeMs: -5 } }).session
        .credentialRefreshAgeMs,
      0,
    )
    assert.ok(
      normalizeConfig({ enabled: true, session: { credentialRefreshAgeMs: 99 * 3600 * 1000 } }).session
        .credentialRefreshAgeMs <= 6 * 3600 * 1000,
    )
  }

  // 18) 【致命复位 反向验证】重启失败后退避结束必须还能再试（否则浏览器永远起不来）
  {
    let attempts = 0
    let failedOnce = false
    let clock = 1_000_000
    const ka = createTransportKeepAlive({
      probe: async () => null,
      browserAvailable: () => true,
      ensureStarted: async () => {
        attempts += 1
        if (!failedOnce) {
          failedOnce = true
          throw new Error('spawn failed once')
        }
      },
      navigateToSite: async () => false,
      markPageSessionStale: () => {},
      requestsInFlight: () => 0,
      invalidateSession: () => {},
      stopAfterFailures: 1,
      now: () => clock,
      logger: { warn: () => {} },
    })
    await ka.beatOnce() // 第一次：尝试重启但失败 ⇒ 进入退避
    assert.equal(attempts, 1)
    await ka.beatOnce() // 退避期内：不再尝试
    assert.equal(attempts, 1, 'must stay in backoff')
    // 推进时钟越过退避窗口（60s）
    clock += 61_000
    await ka.beatOnce() // 退避结束：必须再试一次（这正是 previousFatal 未复位会挂掉的地方）
    assert.equal(attempts, 2, 'must retry after the backoff window expires')
    assert.equal(ka.snapshot().restarts, 1, 'successful restart must be counted')
    ka.stop()
  }

  console.log('check-keep-alive: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}