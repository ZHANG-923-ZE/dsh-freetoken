import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { silenceDuration } from '../lib/rhythm/silence.js'

const config = normalizeConfig({ enabled: true })
const at = (value) => () => value

// 无请求：落在基础区间
assert.equal(silenceDuration({ config, todayRequests: 0, random: at(0) }), 30000)
assert.equal(silenceDuration({ config, todayRequests: 0, random: at(1) }), 60000)
const mid = silenceDuration({ config, todayRequests: 0, random: at(0.5) })
assert.ok(mid >= 30000 && mid <= 60000)

// 今日 40 次（perRequests=10）：3 步 × 120s = +360s
assert.equal(silenceDuration({ config, todayRequests: 40, random: at(0) }), 510000)
assert.equal(silenceDuration({ config, todayRequests: 40, random: at(1) }), 540000)

// 封顶 capMs（600s）：1000 次请求也最多 +600s
assert.equal(silenceDuration({ config, todayRequests: 1000, random: at(0) }), 30000 + 600000)

// 负值按 0 处理
assert.equal(silenceDuration({ config, todayRequests: -10, random: at(0) }), 30000)

// 自定义区间与缩放
const custom = normalizeConfig({
  enabled: true,
  rhythm: {
    silenceMs: { min: 10000, max: 10000 },
    silenceScale: { perRequests: 10, stepMs: 5000, capMs: 12000 },
  },
})
assert.equal(silenceDuration({ config: custom, todayRequests: 0, random: at(0.5) }), 10000)
assert.equal(silenceDuration({ config: custom, todayRequests: 50, random: at(0.5) }), 10000 + 12000)

console.log('check-silence: PASS')

