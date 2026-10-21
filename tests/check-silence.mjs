import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { silenceDuration } from '../lib/rhythm/silence.js'

const config = normalizeConfig({ enabled: true })
const at = (value) => () => value

// D34（2026-10-21 用户裁决）：基础静默改为 60–120s，缩放改为每 5 次一档
// 无请求：落在基础区间
assert.equal(silenceDuration({ config, todayRequests: 0, random: at(0) }), 60000)
assert.equal(silenceDuration({ config, todayRequests: 0, random: at(1) }), 120000)
const mid = silenceDuration({ config, todayRequests: 0, random: at(0.5) })
assert.ok(mid >= 60000 && mid <= 120000)

// 今日 20 次（perRequests=5）：4 步 × 120s = +480s
assert.equal(silenceDuration({ config, todayRequests: 20, random: at(0) }), 60000 + 480000)
assert.equal(silenceDuration({ config, todayRequests: 20, random: at(1) }), 120000 + 480000)

// 封顶 capMs（600s）：1000 次请求也最多 +600s
assert.equal(silenceDuration({ config, todayRequests: 1000, random: at(0) }), 60000 + 600000)

// 负值按 0 处理
assert.equal(silenceDuration({ config, todayRequests: -10, random: at(0) }), 60000)

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

// 反向验证：perRequests 变小 ⇒ 同样请求数下静默更长（这是"更早开始冷静"的判据）
const strict = normalizeConfig({ enabled: true, rhythm: { silenceScale: { perRequests: 1 } } })
assert.ok(
  silenceDuration({ config: strict, todayRequests: 20, random: at(0) }) >
    silenceDuration({ config, todayRequests: 20, random: at(0) }),
  'smaller perRequests must start increasing silence earlier',
)

console.log('check-silence: PASS')
