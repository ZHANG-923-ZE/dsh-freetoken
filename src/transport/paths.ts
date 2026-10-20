/**
 * 路径解析：所有本地状态都在 `${DSH_HOME:-~/.dsh}/freetoken/` 下。
 * 纯函数 + os/path，不读写文件。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim()
  return raw && raw.length > 0 ? raw : join(homedir(), '.dsh')
}

export function freetokenDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'freetoken')
}

export function freetokenPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(freetokenDir(env), name)
}
