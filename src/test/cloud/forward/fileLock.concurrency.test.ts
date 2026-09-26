import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { ForwardQueue } from '../../../cloud/forward/queue'

/** Proves the actual bug fileLock.ts closes: several real, separate OS processes calling
 *  `ForwardQueue.enqueue()` on the same shared `~/.traceroost/forward-queue.jsonl` at (as close to)
 *  the same instant as `child_process.spawn` allows, none of them losing another's write. This is
 *  the multi-host scenario in practice -- the editor extension and the standalone server (or two
 *  standalone invocations) racing the same file -- reproduced without needing two actual
 *  TraceRoost hosts running. */
suite('cloud/forward/queue — concurrent multi-process enqueue', () => {
  const realHome = process.env.HOME
  let home: string

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-concurrent-queue-'))
  })

  teardown(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('N concurrent processes enqueuing distinct sessions all land — none lost to the race', async function () {
    this.timeout(20_000)
    const workerPath = path.join(__dirname, 'fixtures', 'concurrentEnqueueWorker.js')
    const N = 8
    const sessionIds = Array.from({ length: N }, (_, i) => `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`)

    await Promise.all(sessionIds.map(id => runWorker(workerPath, id, home)))

    process.env.HOME = home
    const queued = new ForwardQueue().list()
    const queuedIds = queued.map(it => it.payload.session?.session_id).sort()
    assert.strictEqual(queued.length, N, `expected all ${N} concurrent enqueues to land, got ${queued.length}`)
    assert.deepStrictEqual(queuedIds, [...sessionIds].sort())
  })
})

function runWorker(workerPath: string, sessionId: string, home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, sessionId], {
      env: { ...process.env, HOME: home },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`worker for ${sessionId} exited with code ${code}`))
    })
  })
}
