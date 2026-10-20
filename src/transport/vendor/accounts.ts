// @ts-nocheck (vendored from cv-superding/dsh-deepseek-web-login@cfd684d; see vendor/NOTICE.md)
/**
 * Vendored accounts shim (single-account build): the base browser transport / auth
 * modules expect a multi-account library; dsh-Freetoken is single-account and stores
 * its credential in `<DSH_HOME>/freetoken/auth.json` (see transport/auth.ts).
 *
 * 这里只提供**结构兼容**的空实现：vendor 的 `auth.ts` 会 import 这些名字，
 * 但本插件的真实凭证读写走自己的 `transport/auth.ts`，不会调用账号库。
 * 保留函数是为了让 vendor 模块能正常加载（ESM 命名导出必须在实例化时齐全）。
 */

export interface AccountRecord {
  id: string
  [key: string]: unknown
}

/** 单账号构建：没有“账号库”，当前账号由 transport/auth.ts 持有。 */
export function activeAccount(): AccountRecord | undefined {
  return undefined
}

export function activeAccountId(): string | undefined {
  return undefined
}

export function listAccounts(): AccountRecord[] {
  return []
}

export function readAccount(_id: string): AccountRecord | undefined {
  return undefined
}

export function setActiveAccount(_id: string | undefined): void {
  // 单账号：无账号库可切换
}

export function clearActiveAccount(): void {
  // 单账号：无账号库可清空
}

export function upsertAccount(_record: AccountRecord): void {
  // 单账号：写路径在 transport/auth.ts
}

export function updateAccount(_id: string, _patch: Record<string, unknown>): AccountRecord | undefined {
  return undefined
}

export function removeAccount(_id: string): boolean {
  return false
}