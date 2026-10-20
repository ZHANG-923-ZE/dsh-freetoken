/**
 * 构建：tsc 逐文件输出 ESM 到 lib/，保留模块边界（懒加载依赖真实 import()）。
 * 用法：node scripts/build.mjs [--no-emit]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const noEmit = process.argv.includes('--no-emit')

if (!existsSync(tsc)) {
  console.error('freetoken: typescript is not installed; run `npm install` first')
  process.exit(2)
}

if (!noEmit) rmSync(path.join(root, 'lib'), { recursive: true, force: true })

const result = spawnSync(
  process.execPath,
  [tsc, '-p', path.join(root, 'tsconfig.json'), ...(noEmit ? ['--noEmit'] : [])],
  { stdio: 'inherit', cwd: root },
)

if (result.error) {
  console.error(`freetoken: tsc failed to start: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
