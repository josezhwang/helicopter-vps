import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const node = process.execPath

const initial = spawnSync(node, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' })
if (initial.status !== 0) process.exit(initial.status ?? 1)

const children = [
  spawn(node, [tsc, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(node, ['--watch', '--enable-source-maps', 'dist/main.js'], { stdio: 'inherit' }),
]

const stop = () => { for (const child of children) child.kill(); process.exit() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', (code) => { if (code) stop() })
