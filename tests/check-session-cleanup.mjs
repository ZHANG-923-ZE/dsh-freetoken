import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-session-cleanup-'))
process.env.DSH_HOME = tempHome

/**
 * 假定时器：
 *  - 短延时（删除间隔 gap，默认 800~2500ms）用 queueMicrotask 立即执行，
 *    这样 await flush() 能自然跑完，且不触碰任何真实定时器；
 *  - 长延时（到点清理 delay，60~120s）存起来，由用例手动 fireStored() 触发。
 */
function makeTimers(shortBelow = 5000) {
  const stored = new Map()
  const logged = []
  let seq = 0
  return {
    setTimeoutImpl(fn, ms) {
      const id = (seq += 1)
      logged.push(ms)
      if (ms < shortBelow) {
        queueMicrotask(fn)
        return id
      }
      stored.set(id, { fn, ms })
      return id
    },
    clearTimeoutImpl(id) {
      stored.delete(id)
    },
    storedDelays() {
      return [...stored.values()].map((timer) => timer.ms)
    },
    storedCount() {
      return stored.size
    },
    fireStored() {
      const snapshot = [...stored.values()]
      stored.clear()
      for (const timer of snapshot) timer.fn()
    },
    logged,
  }
}

let fileSeq = 0
function nextFile(tag) {
  fileSeq += 1
  return path.join(tempHome, `${tag}-${fileSeq}.json`)
}

function policy(overrides = {}) {
  return {
    mode: 'deferred',
    batchRange: { min: 6, max: 10 },
    delayRange: { min: 60000, max: 120000 },
    gapRange: { min: 0, max: 0 },
    ...overrides,
  }
}

function makeDelete(result = () => true) {
  const calls = []
  return {
    calls,
    deleteSession: async (accountId, sessionId) => {
      calls.push({ accountId, sessionId })
      return result(accountId, sessionId)
    },
  }
}

try {
  const {
    journalPath,
    readJournal,
    writeJournal,
    upsertJournalEntry,
    removeJournalEntry,
    planStartupSweep,
    isProcessAlive,
  } = await import('../lib/session/journal.js')
  const { createDeferredCleaner } = await import('../lib/session/cleanup.js')

  // ── 一、账本原语 ────────────────────────────────────────────
  const journalFile = nextFile('journal')
  assert.ok(journalPath().endsWith(path.join('freetoken', 'sessions-in-use.json')))
  assert.deepEqual(readJournal(journalFile), []) // 缺失文件 => 空账本

  writeJournal(
    [{ accountId: 'acct-1', sessionId: 'sess-1', pid: 111, at: 222, state: 'slot' }],
    journalFile,
  )
  // 反向验证：先证明读回不是恒空（否则下面的「损坏 => []」没有意义）
  assert.equal(readJournal(journalFile).length, 1)

  // upsert：同一 sessionId 覆盖，不产生两条
  upsertJournalEntry(
    { accountId: 'acct-1', sessionId: 'sess-1', pid: 333, at: 444, state: 'queued' },
    journalFile,
  )
  assert.deepEqual(readJournal(journalFile)[0], {
    accountId: 'acct-1',
    sessionId: 'sess-1',
    pid: 333,
    at: 444,
    state: 'queued',
  })
  // pid/at 缺省由实现补齐
  upsertJournalEntry({ accountId: 'acct-2', sessionId: 'sess-2', state: 'queued' }, journalFile)
  const filled = readJournal(journalFile).find((entry) => entry.sessionId === 'sess-2')
  assert.equal(filled.pid, process.pid)
  assert.ok(filled.at > 0)

  removeJournalEntry('sess-1', journalFile)
  assert.deepEqual(readJournal(journalFile).map((entry) => entry.sessionId), ['sess-2'])
  removeJournalEntry('never-existed', journalFile) // 幂等，不抛

  // 损坏 / 结构错误 / 坏记录：一律容忍
  const corruptJournal = nextFile('corrupt-journal')
  writeFileSync(corruptJournal, '{broken json')
  assert.deepEqual(readJournal(corruptJournal), [])
  writeFileSync(corruptJournal, JSON.stringify({ version: 1, entries: 'nope' }))
  assert.deepEqual(readJournal(corruptJournal), [])
  writeFileSync(corruptJournal, JSON.stringify([null, { accountId: 'x' }, { sessionId: 'y' }]))
  assert.deepEqual(readJournal(corruptJournal), [])
  writeFileSync(
    corruptJournal,
    JSON.stringify([
      { accountId: 'a', sessionId: 'ok', pid: 1, at: 2, state: 'queued' },
      { accountId: '', sessionId: 'bad' },
    ]),
  )
  assert.deepEqual(readJournal(corruptJournal).map((entry) => entry.sessionId), ['ok'])

  // 凭证红线：账本只落白名单字段，多余属性（token/cookie）绝不落盘
  const credFile = nextFile('creds')
  writeJournal(
    [
      {
        accountId: 'acct',
        sessionId: 'sess',
        pid: 1,
        at: 2,
        state: 'slot',
        token: 'SECRET-TOKEN',
        cookie: 'SECRET-COOKIE',
      },
    ],
    credFile,
  )
  const credRaw = readFileSync(credFile, 'utf8')
  assert.ok(!credRaw.includes('SECRET'), '账本不得包含凭证内容')
  assert.ok(!/token|cookie|authorization|bearer|password|refresh/i.test(credRaw), '账本不得包含凭证字段')
  assert.deepEqual(JSON.parse(credRaw).entries[0], {
    accountId: 'acct',
    sessionId: 'sess',
    pid: 1,
    at: 2,
    state: 'slot',
  })
  if (process.platform !== 'win32') {
    assert.equal(statSync(credFile).mode & 0o777, 0o600) // Windows 上 mode 不可靠，跳过
  }

  // ── 二、planStartupSweep 纯决策 ─────────────────────────────
  const sweepEntries = [
    { accountId: 'a', sessionId: 'own', pid: 111, at: 1, state: 'slot' },
    { accountId: 'a', sessionId: 'alive', pid: 222, at: 1, state: 'slot' },
    { accountId: 'a', sessionId: 'dead', pid: 333, at: 1, state: 'queued' },
    { accountId: 'gone', sessionId: 'dropped', pid: 444, at: 1, state: 'queued' },
  ]
  const plan = planStartupSweep(sweepEntries, {
    ownPid: 111,
    isAlive: (pid) => pid === 222,
    deleteEnabled: true,
    mode: 'deferred',
    accountExists: (id) => id === 'a',
  })
  assert.deepEqual(plan.kept.map((entry) => entry.sessionId), ['own', 'alive'])
  assert.deepEqual(plan.toDelete.map((entry) => entry.sessionId), ['dead'])
  assert.deepEqual(plan.dropped.map((entry) => entry.sessionId), ['dropped'])

  const planKeep = planStartupSweep(sweepEntries, {
    ownPid: 111,
    isAlive: () => false,
    deleteEnabled: false,
    mode: 'keep',
  })
  assert.equal(planKeep.toDelete.length, 0)
  assert.equal(planKeep.kept.length, 4)
  assert.equal(planKeep.dropped.length, 0)

  // 未提供 accountExists => 视为账号仍存在（补删，不摘账）
  const planNoAccountCheck = planStartupSweep(sweepEntries, {
    ownPid: 111,
    isAlive: () => false,
    deleteEnabled: true,
    mode: 'deferred',
  })
  assert.ok(planNoAccountCheck.toDelete.some((entry) => entry.sessionId === 'dropped'))

  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(process.pid), true)

  // ── 三、deferred 攒批：6~10 个触发（确定性随机） ────────────
  {
    const timers = makeTimers()
    const file = nextFile('batch6')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy(),
      random: () => 0, // 本轮 batch=6、delay=60000、gap=0
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    for (let i = 1; i <= 5; i += 1) cleaner.schedule('acct', `s-${i}`)
    // 反向验证：未达阈值不得删除，且账本已落、到点清理表已装
    assert.equal(fake.calls.length, 0)
    assert.equal(cleaner.pendingCount(), 5)
    assert.equal(readJournal(file).length, 5)
    assert.deepEqual(timers.storedDelays(), [60000])

    cleaner.schedule('acct', 's-6') // 第 6 个触发批次
    await cleaner.flush() // 串到自动 flush 之后
    assert.equal(fake.calls.length, 6)
    assert.equal(new Set(fake.calls.map((call) => call.sessionId)).size, 6)
    assert.equal(cleaner.pendingCount(), 0)
    assert.equal(readJournal(file).length, 0) // 确认删除后账本清空
    assert.equal(cleaner.stats().deleted, 6)
    assert.equal(cleaner.stats().failed, 0)
    assert.equal(typeof cleaner.stats().lastFlushAt, 'number')
    assert.equal(timers.storedCount(), 0)
    cleaner.dispose()
  }

  // 随机上界：batchSize=10 时第 9 个不清、第 10 个才清
  {
    const timers = makeTimers()
    const file = nextFile('batch10')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy(),
      random: () => 0.999, // batchSize=10
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    for (let i = 1; i <= 9; i += 1) cleaner.schedule('acct', `s-${i}`)
    assert.equal(fake.calls.length, 0)
    assert.equal(cleaner.pendingCount(), 9)
    const delay = timers.storedDelays()[0]
    assert.ok(delay >= 60000 && delay <= 120000, 'delay 必须落在 cleanupDelayMs 区间内')
    cleaner.schedule('acct', 's-10')
    await cleaner.flush()
    assert.equal(fake.calls.length, 10)
    assert.equal(readJournal(file).length, 0)
    cleaner.dispose()
  }

  // 到点定时器触发清理（delayRange 决定等待时长）
  {
    const timers = makeTimers()
    const file = nextFile('delay')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy({ batchRange: { min: 10, max: 10 } }),
      random: () => 0, // delay=60000
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    cleaner.schedule('acct', 'timer-1')
    assert.deepEqual(timers.storedDelays(), [60000])
    assert.equal(fake.calls.length, 0)
    timers.fireStored() // 到点
    await cleaner.flush()
    assert.equal(fake.calls.length, 1)
    assert.equal(readJournal(file).length, 0)
    cleaner.dispose()
  }

  // 逐个删除之间的随机间隔：每次在 gapRange 内重抽
  {
    const timers = makeTimers()
    const file = nextFile('gap')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy({ gapRange: { min: 800, max: 2500 } }),
      random: () => 0, // gap 取区间下界 800
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    for (let i = 1; i <= 3; i += 1) cleaner.schedule('acct', `g-${i}`)
    await cleaner.flush()
    assert.equal(fake.calls.length, 3)
    const gaps = timers.logged.filter((ms) => ms >= 800 && ms <= 2500)
    assert.deepEqual(gaps, [800, 800]) // 3 个删除 => 2 个间隔
    cleaner.dispose()
  }

  // ── 四、删除确认前账本必须还在 ──────────────────────────────
  {
    const timers = makeTimers()
    const file = nextFile('confirm')
    let resolveDelete
    const calls = []
    const cleaner = createDeferredCleaner({
      deleteSession: (accountId, sessionId) => {
        calls.push({ accountId, sessionId })
        return new Promise((resolve) => {
          resolveDelete = resolve
        })
      },
      file,
      policy: policy({ batchRange: { min: 1, max: 1 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    cleaner.schedule('acct', 'mid')
    await Promise.resolve() // 让自动 flush 进入 deleteSession 挂起
    assert.equal(calls.length, 1)
    assert.equal(readJournal(file).length, 1) // 删除未确认 => 账不能销
    resolveDelete(true)
    await cleaner.flush()
    assert.equal(readJournal(file).length, 0)
    assert.equal(cleaner.stats().deleted, 1)
    cleaner.dispose()
  }

  // ── 五、删除失败保留账本，重启补扫再排一次 ──────────────────
  {
    const timers = makeTimers()
    const file = nextFile('retry')
    const first = makeDelete(() => false)
    const failCleaner = createDeferredCleaner({
      deleteSession: first.deleteSession,
      file,
      policy: policy({ batchRange: { min: 1, max: 1 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    failCleaner.schedule('acct-1', 'retry-me')
    await failCleaner.flush()
    assert.equal(first.calls.length, 1)
    assert.equal(failCleaner.stats().failed, 1)
    assert.equal(failCleaner.stats().deleted, 0)
    assert.deepEqual(readJournal(file).map((entry) => entry.sessionId), ['retry-me']) // 欠账保留
    failCleaner.dispose()

    // 模拟上次进程已退出：把 pid 改成 0（真实重启时这里会是已死进程的 pid）
    upsertJournalEntry({ accountId: 'acct-1', sessionId: 'retry-me', pid: 0, at: 1, state: 'queued' }, file)

    const timers2 = makeTimers()
    const sweepCalls = []
    let resolveSweep
    const restarted = createDeferredCleaner({
      deleteSession: (accountId, sessionId) => {
        sweepCalls.push({ accountId, sessionId })
        return new Promise((resolve) => {
          resolveSweep = resolve
        })
      },
      file,
      policy: policy({ batchRange: { min: 10, max: 10 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers2.setTimeoutImpl,
      clearTimeoutImpl: timers2.clearTimeoutImpl,
    })
    assert.equal(restarted.sweepStartup(), 1) // 补扫重新排队
    assert.equal(restarted.pendingCount(), 1)
    assert.equal(readJournal(file).length, 1) // 入队不提前摘账
    const flushing = restarted.flush()
    await Promise.resolve()
    assert.equal(sweepCalls.length, 1)
    assert.equal(readJournal(file).length, 1) // 删除未确认
    resolveSweep(true)
    await flushing
    assert.equal(readJournal(file).length, 0) // 确认后摘账
    assert.equal(restarted.stats().deleted, 1)
    restarted.dispose()
  }

  // 账号已不在账号库 => 摘账（永远删不掉，不能无限滞留）
  {
    const timers = makeTimers()
    const file = nextFile('dropped')
    upsertJournalEntry({ accountId: 'gone', sessionId: 's-gone', pid: 0, at: 1, state: 'queued' }, file)
    const cleaner = createDeferredCleaner({
      deleteSession: async () => true,
      accountExists: (id) => id !== 'gone',
      file,
      policy: policy({ batchRange: { min: 10, max: 10 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    assert.equal(cleaner.sweepStartup(), 0)
    assert.equal(readJournal(file).length, 0)
    cleaner.dispose()
  }

  // ── 六、keep 模式：一条都不记、一条都不删、不装定时器 ────────
  {
    const timers = makeTimers()
    const file = nextFile('keep')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy({
        mode: 'keep',
        batchRange: { min: 1, max: 1 },
        delayRange: { min: 1000, max: 1000 },
      }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    cleaner.schedule('acct', 'k-1')
    cleaner.schedule('acct', 'k-2')
    assert.equal(cleaner.pendingCount(), 0)
    assert.equal(timers.storedCount(), 0)
    assert.equal(existsSync(file), false) // 绝不能留下「永远删不掉」的欠账
    await cleaner.flush()
    assert.equal(fake.calls.length, 0)
    assert.equal(cleaner.stats().journalEntries, 0)
    cleaner.dispose()
  }

  // keep 模式补扫：账本原样保留（等以后允许删了再扫）
  {
    const timers = makeTimers()
    const file = nextFile('keep-sweep')
    upsertJournalEntry({ accountId: 'acct', sessionId: 'keep-me', pid: 0, at: 1, state: 'queued' }, file)
    const cleaner = createDeferredCleaner({
      deleteSession: async () => true,
      file,
      policy: policy({ mode: 'keep', batchRange: { min: 1, max: 1 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    assert.equal(cleaner.sweepStartup(), 0)
    assert.equal(cleaner.pendingCount(), 0)
    assert.equal(readJournal(file).length, 1)
    cleaner.dispose()
  }

  // ── 七、discard：自己的脚手架会话立即删，不受队列/策略约束 ──
  {
    const timers = makeTimers()
    const file = nextFile('discard')
    upsertJournalEntry({ accountId: 'acct', sessionId: 'scaffold', pid: 0, at: 1, state: 'queued' }, file)
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy({ batchRange: { min: 10, max: 10 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    cleaner.schedule('acct', 'normal')
    assert.equal(cleaner.pendingCount(), 1)
    assert.equal(await cleaner.discard('acct', 'scaffold'), true)
    assert.deepEqual(fake.calls[0], { accountId: 'acct', sessionId: 'scaffold' })
    assert.equal(readJournal(file).some((entry) => entry.sessionId === 'scaffold'), false)
    assert.equal(cleaner.pendingCount(), 1) // 不 drain 用户队列
    assert.equal(readJournal(file).some((entry) => entry.sessionId === 'normal'), true)
    cleaner.dispose()
  }

  // discard 失败：返回 false、账本保留
  {
    const timers = makeTimers()
    const file = nextFile('discard-fail')
    upsertJournalEntry({ accountId: 'acct', sessionId: 'scaffold', pid: 0, at: 1, state: 'queued' }, file)
    const cleaner = createDeferredCleaner({
      deleteSession: async () => false,
      file,
      policy: policy(),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    assert.equal(await cleaner.discard('acct', 'scaffold'), false)
    assert.equal(cleaner.stats().failed, 1)
    assert.equal(readJournal(file).length, 1)
    cleaner.dispose()
  }

  // keep 模式下 discard 仍立即删（我们自己的脚手架会话，对齐基座语义）
  {
    const timers = makeTimers()
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file: nextFile('discard-keep'),
      policy: policy({ mode: 'keep' }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    assert.equal(await cleaner.discard('acct', 'scaffold'), true)
    assert.deepEqual(fake.calls, [{ accountId: 'acct', sessionId: 'scaffold' }])
    cleaner.dispose()
  }

  // ── 八、损坏账本对清理器同样无害 ────────────────────────────
  {
    const timers = makeTimers()
    const file = nextFile('corrupt-cleaner')
    writeFileSync(file, '{broken')
    const cleaner = createDeferredCleaner({
      deleteSession: async () => true,
      file,
      policy: policy({ batchRange: { min: 10, max: 10 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    assert.equal(cleaner.sweepStartup(), 0)
    assert.equal(cleaner.stats().journalEntries, 0)
    cleaner.schedule('acct', 'fresh')
    assert.equal(readJournal(file).length, 1) // 损坏文件被新账覆盖
    cleaner.dispose()
  }

  // ── 九、flush 幂等 + 串行化；dispose 清定时器 ───────────────
  {
    const timers = makeTimers()
    const file = nextFile('idempotent')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy({ batchRange: { min: 10, max: 10 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    for (let i = 1; i <= 3; i += 1) cleaner.schedule('acct', `i-${i}`)
    await Promise.all([cleaner.flush(), cleaner.flush()])
    assert.equal(fake.calls.length, 3) // 两轮 flush 不重复删
    await cleaner.flush()
    assert.equal(fake.calls.length, 3)
    cleaner.dispose()
  }

  {
    const timers = makeTimers()
    const file = nextFile('dispose')
    const fake = makeDelete(() => true)
    const cleaner = createDeferredCleaner({
      deleteSession: fake.deleteSession,
      file,
      policy: policy({ batchRange: { min: 10, max: 10 }, delayRange: { min: 100000, max: 100000 } }),
      random: () => 0,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    cleaner.schedule('acct', 'pending')
    assert.equal(timers.storedCount(), 1)
    assert.equal(readJournal(file).length, 1)
    cleaner.dispose()
    assert.equal(timers.storedCount(), 0) // 定时器清掉
    timers.fireStored()
    await cleaner.flush()
    assert.equal(fake.calls.length, 0) // dispose 后不再自动删
    assert.equal(readJournal(file).length, 1) // 账本留给下次启动补扫
    cleaner.schedule('acct', 'after-dispose')
    assert.equal(cleaner.pendingCount(), 0) // 停用后不再接单
  }

  // 反向验证汇总：若实现被改坏，上面任一处会立即变红 ——
  //  ① 未达批次阈值就删（第三节首次断言）；
  //  ② 删除未确认就摘账（第四节/第五节中途断言）；
  //  ③ keep 模式留下欠账或偷偷删除（第六节）；
  //  ④ 账本写入凭证字段（第一节凭证断言）。

  console.log('check-session-cleanup: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}