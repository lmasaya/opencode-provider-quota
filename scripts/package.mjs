// Builds the release artifact that chezmoi installs: only the runtime files
// OpenCode loads, plus a checksum to pin in the deployment script.
//
// @opentui/* and solid-js are deliberately excluded. They are provided by the
// OpenCode runtime, so the deployed plugin needs no node_modules at all.
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const archive = `opencode-quota-v${version}.tar.gz`

await rm(archive, { force: true })

// COPYFILE_DISABLE stops macOS tar from embedding ._ AppleDouble entries.
execFileSync('tar', ['--no-xattrs', '-czf', archive, 'package.json', 'dist'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
  stdio: 'inherit',
})

const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${digest}  ${archive}\n`)

console.log(`${archive}\nsha256: ${digest}`)
