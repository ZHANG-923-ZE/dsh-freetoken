// @ts-nocheck (vendored from cv-superding/dsh-deepseek-web-login@cfd684d; see vendor/NOTICE.md)
/**
 * Vendored path shim: base modules expect `webLoginDir()`; dsh-Freetoken keeps
 * its own state under `<DSH_HOME>/freetoken/`.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function webLoginDir(): string {
  return join(resolveDshHome(), 'freetoken')
}

export function legacyAuthFilePath(): string {
  return join(webLoginDir(), 'auth.json')
}

