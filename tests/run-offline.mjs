#!/usr/bin/env node
/**
 * 离线用例总入口：逐个执行 tests/check-*.mjs，任一失败即非零退出。
 * 工作流要求：每条关键判据都要有反向验证（改坏实现时该用例必须红）。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((name) => /^check-.*\.mjs$/.test(name))
  .sort()

if (files.length === 0) {
  console.error('freetoken: no check-*.mjs tests found')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  const ms = Date.now() - started
  if (result.status !== 0) {
    failed += 1
    console.error(`FAIL ${file} (${ms}ms)`)
  } else {
    console.log(`PASS ${file} (${ms}ms)`)
  }
}

console.log(`\n${files.length - failed}/${files.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
