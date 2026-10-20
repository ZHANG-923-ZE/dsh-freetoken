import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '..', 'src')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(srcRoot).filter((file) => file.endsWith('.ts'))
assert.ok(files.length >= 10, 'expected source files')

// 1) 动态 import() 只允许出现在 src/lazy/
for (const file of files) {
  const rel = path.relative(srcRoot, file).replaceAll('\\', '/')
  const text = readFileSync(file, 'utf8')
  const dynamic = /(^|[^.\w])import\s*\(/g.test(text)
  if (dynamic) {
    assert.ok(rel.startsWith('lazy/'), `dynamic import() must live in src/lazy (found in ${rel})`)
  }
}

// 2) 轻模块不得静态引用重模块（懒加载边界）
const heavyPatterns = [
  /from\s+['"][^'"]*transport\/(browser|webapi|pow|sse)\.js['"]/,
  /from\s+['"][^'"]*protocol\//,
  /from\s+['"][^'"]*rhythm\//,
  /from\s+['"][^'"]*session\/(cleanup|journal)\.js['"]/,
  /from\s+['"][^'"]*narration\//,
]
for (const rel of ['index.ts', 'config.ts', 'status.ts', 'commands.ts', 'lifecycle.ts']) {
  const text = readFileSync(path.join(srcRoot, rel), 'utf8')
  for (const pattern of heavyPatterns) {
    assert.equal(pattern.test(text), false, `${rel} must not statically import heavy modules`)
  }
}

// 3) 懒加载清单存在且是唯一入口
const lazy = readFileSync(path.join(srcRoot, 'lazy', 'load.ts'), 'utf8')
assert.ok(lazy.includes('MANIFEST'), 'lazy/load.ts must own the load manifest')
assert.ok(lazy.includes('loadedKeys'), 'lazy/load.ts must record loaded modules')

console.log('check-lazy-import: PASS')
