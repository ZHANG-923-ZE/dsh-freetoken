import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// 源码与装配文件里不得残留基座身份（provider id `deepseek-web` 与许可文本除外）
const forbidden = [
  'dsh-deepseek-web-login',
  'deepseek-web-login',
  '/deepseek-web-login/api',
  'DSW_PLUGIN_ID',
  'deepseek-web:',
]

const scanned = [
  ...walk(path.join(root, 'src'))
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !file.includes(`${path.sep}vendor${path.sep}`)),
  path.join(root, 'package.json'),
  path.join(root, 'cordis.patch.yml'),
]

// vendored code is explicitly attributed, not silently renamed
const vendorNotice = readFileSync(path.join(root, 'src', 'transport', 'vendor', 'NOTICE.md'), 'utf8')
assert.ok(vendorNotice.includes('cv-superding/dsh-deepseek-web-login'))
assert.ok(vendorNotice.includes('cfd684d'))
assert.ok(vendorNotice.includes('Apache-2.0'))

for (const file of scanned) {
  const text = readFileSync(file, 'utf8')
  for (const marker of forbidden) {
    assert.equal(
      text.includes(marker),
      false,
      `${path.relative(root, file)} must not contain base marker "${marker}"`,
    )
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-freetoken')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(pkg.license, 'Apache-2.0')

const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
assert.ok(patch.includes('id: freetoken'), 'bundle patch must self-register id freetoken')
assert.ok(patch.includes('enabled: false'), 'shipped default must be disabled')

console.log('check-naming: PASS')
