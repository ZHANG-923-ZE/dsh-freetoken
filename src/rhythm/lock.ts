/**
 * 全局串行锁（M11 / 唯一出口）：同一时刻只放行一个网页请求。
 * FIFO；等待可被 AbortSignal 取消；release 幂等。
 */

export interface LockStats {
  held: boolean
  pending: number
}

export class SerialLock {
  private tail: Promise<void> = Promise.resolve()
  private held = false
  private pending = 0

  /** 获取许可；返回释放函数（重复调用安全）。 */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    this.pending += 1
    let releaseMine!: () => void
    const mine = new Promise<void>((resolve) => {
      releaseMine = resolve
    })
    const waitFor = this.tail.then(
      () => undefined,
      () => undefined,
    )
    this.tail = waitFor.then(() => mine)

    try {
      await this.wait(waitFor, signal)
    } catch (error) {
      this.pending -= 1
      releaseMine()
      throw error
    }

    this.pending -= 1
    this.held = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.held = false
      releaseMine()
    }
  }

  private wait(inner: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    if (!signal) return inner.then(() => undefined)
    if (signal.aborted) return Promise.reject(this.aborted())
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        reject(this.aborted())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      inner.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private aborted(): Error {
    const error = new Error('freetoken: serial lock wait aborted')
    error.name = 'AbortError'
    return error
  }

  stats(): LockStats {
    return { held: this.held, pending: this.pending }
  }
}
