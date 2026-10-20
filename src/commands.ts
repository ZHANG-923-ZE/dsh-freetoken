/**
 * `/freetoken` 命令：状态 / 登录 / 登出 / 探活。
 *
 * 关闭态也允许注册只读命令（受 `statusCommand` 控制）；写操作（login/logout/probe）
 * 只在启用运行时可用，且 login 需要显式 token（浏览器捕获在后续阶段接入）。
 */

import type { FreetokenConfig } from './config.js'
import type { StatusSnapshot } from './status.js'

export interface FreetokenOps {
  login(token: string): Promise<{ ok: boolean; message: string }>
  logout(): Promise<{ ok: boolean; message: string }>
  probe(): Promise<{ ok: boolean; message: string }>
}

function age(ms: number | null): string {
  if (ms === null) return 'n/a'
  const seconds = Math.round(ms / 1000)
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

function renderStatus(snapshot: StatusSnapshot, config: FreetokenConfig): string {
  return [
    `dsh-Freetoken ${snapshot.enabled ? 'ENABLED' : 'DISABLED'}`,
    `started: ${snapshot.started} | phase: ${snapshot.phase} | backend: ${snapshot.identity.backend}`,
    `login: ${snapshot.login.loggedIn ? 'logged-in' : 'not-logged-in'}${
      snapshot.login.lastError ? ` (${snapshot.login.lastError})` : ''
    }` + ` | credential-age: ${age(snapshot.login.credentialAgeMs ?? null)}`,
    `session: mode=${snapshot.session.contextMode}` +
      `${snapshot.session.persistent ? ' (persistent: 1 DSH session = 1 web session)' : ' (rotates)'}` +
      ` | keep-alive=${snapshot.session.keepAliveState}` +
      `${snapshot.session.keepAliveRestarts > 0 ? ` | restarts=${snapshot.session.keepAliveRestarts}` : ''}`,
    `identity: device=${snapshot.identity.deviceId ?? 'n/a'} | singleInstance=${snapshot.identity.singleInstance}`,
    `browser: ${snapshot.browser.running ? `running pid=${snapshot.browser.pid ?? '?'}` : 'stopped'}`,
    `lock: ${snapshot.lock.held ? `held ${snapshot.lock.heldMs}ms` : 'free'}` +
      ` | queue: ${snapshot.queue.pending}/${snapshot.queue.maxPending}`,
    `rhythm: ${snapshot.rhythm.silent ? 'silent' : 'active'}` +
      ` | today=${snapshot.rhythm.todayRequests}` +
      `${snapshot.rhythm.dailyBudget > 0 ? `/${snapshot.rhythm.dailyBudget}` : ''}` +
      `${snapshot.rhythm.silent ? ` | remaining=${Math.ceil(snapshot.rhythm.silenceRemainingMs / 1000)}s` : ''}`,
    `last-request: ${age(snapshot.rhythm.msSinceLastRequest)} ago` +
      ` | last-block: ${
        snapshot.rhythm.lastBlock
          ? `${snapshot.rhythm.lastBlock.reason} @ ${new Date(snapshot.rhythm.lastBlock.at).toISOString()}`
          : 'none'
      }`,
    `retry: attempts=${snapshot.retry.attempts} next=${snapshot.retry.nextDelayMs}ms`,
    `safety: testAccountOnly=${snapshot.safety.testAccountOnly}` +
      `${snapshot.safety.halted ? ` | HALTED: ${snapshot.safety.haltReason ?? 'unknown'}` : ''}` +
      `${snapshot.safety.mutedUntil ? ` | muted-until=${new Date(snapshot.safety.mutedUntil).toISOString()}` : ''}`,
    `last-failure: ${
      snapshot.lastFailure ? `${snapshot.lastFailure.code}: ${snapshot.lastFailure.message}` : 'none'
    }`,
    `narration: model=${snapshot.narration.model ? 'yes' : 'no'}` +
      ` | local=${snapshot.narration.local ? 'yes' : 'no'}` +
      ` | dedupe-suppressed=${snapshot.narration.dedupeSuppressed}`,
    `transport: ${config.transport} | narration: ${config.narration.enabled ? 'on' : 'off'}` +
      ` | localTitle: ${config.localTitle.enabled ? 'on' : 'off'}`,
    `lazy-loaded: ${snapshot.lazyLoaded.length > 0 ? snapshot.lazyLoaded.join(', ') : 'none'}`,
  ].join('\n')
}

const HELP = [
  'usage: /freetoken <subcommand>',
  '  status            show plugin status (default)',
  '  login <token>     save a chat.deepseek.com bearer token and probe it',
  '  logout            clear stored credentials',
  '  probe             read-only login probe',
  '  help              this help',
  '',
  'browser-window login (Edge CDP) lands in the next phase; for now paste a token.',
].join('\n')

/**
 * 注册命令；服务不可用（无 UI 的组合）时静默跳过。
 */
export function registerFreetokenCommands(
  ctx: any,
  getStatus: () => StatusSnapshot,
  getConfig: () => FreetokenConfig,
  getOps?: () => FreetokenOps | undefined,
): void {
  const install = (scope: any): void => {
    const commands = scope?.commands ?? scope?.get?.('commands')
    if (!commands || typeof commands.register !== 'function') return
    const register = (): (() => void) =>
      commands.register({
        name: 'freetoken',
        description: 'dsh-Freetoken: status / login / logout / probe',
        // 必须声明 input：宿主只给“声明了输入”的命令认领参数；
        // 否则 `/freetoken login` 会被当成普通聊天文本（历史故障）。
        input: { hint: 'status | login [token] | logout | probe', attachments: false },
        handler: async (invocation: any) => {
          try {
            const raw = String(invocation?.rawInput ?? '').trim()
            const [action = 'status', ...rest] = raw.length > 0 ? raw.split(/\s+/) : ['status']
            const ops = getOps?.()
            if (action === 'status' || action === '') {
              return { kind: 'success' as const, text: renderStatus(getStatus(), getConfig()) }
            }
            if (action === 'help') return { kind: 'success' as const, text: HELP }
            if (!ops) {
              return {
                kind: 'error' as const,
                text: `freetoken: ${action} needs the plugin enabled (set freetoken.enabled=true and restart).`,
              }
            }
            if (action === 'login') {
              const token = rest.join(' ').trim()
              const result = await ops.login(token)
              return { kind: result.ok ? ('success' as const) : ('error' as const), text: result.message }
            }
            if (action === 'logout') {
              const result = await ops.logout()
              return { kind: 'success' as const, text: result.message }
            }
            if (action === 'probe') {
              const result = await ops.probe()
              return { kind: result.ok ? ('success' as const) : ('error' as const), text: result.message }
            }
            return { kind: 'error' as const, text: `freetoken: unknown subcommand "${action}"\n${HELP}` }
          } catch (error: any) {
            // 诊断：把堆栈原样回给调用方（不含凭证），避免只剩一句无上下文的 TypeError。
            const stack = String(error?.stack ?? error ?? 'unknown error')
            return { kind: 'error' as const, text: `freetoken: internal error\n${stack.slice(0, 2000)}` }
          }
        },
      })
    if (typeof ctx.effect === 'function') ctx.effect(() => register(), 'freetoken.commands')
    else register()
  }

  if (typeof ctx.inject === 'function') ctx.inject(['commands'], install)
  else install(ctx)
}
