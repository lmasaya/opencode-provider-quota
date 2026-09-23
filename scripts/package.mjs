// Builds the release artifact that chezmoi installs: only the runtime files
// OpenCode loads, plus a checksum to pin in the deployment script.
//
// @opentui/* and solid-js are deliberately excluded. They are provided by the
// OpenCode runtime, so the deployed plugin needs no node_modules at all.
//
// The archive is built deterministically: fixed timestamps, fixed ownership,
// and a stable file order. Rebuilding the same commit reproduces the same
// digest, so a published artifact can be verified against its source.
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm, mkdtemp, mkdir, copyFile, utimes } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const archive = `opencode-quota-v${version}.tar.gz`

// Fixed timestamp keeps the archive byte-identical across rebuilds.
const EPOCH = new Date(0)
const entries = ['package.json', 'dist/index.js', 'dist/tui.js']

const staging = await mkdtemp(join(tmpdir(), 'opencode-quota-pkg-'))
await mkdir(join(staging, 'dist'))
for (const entry of entries) {
  await copyFile(entry, join(staging, entry))
  await utimes(join(staging, entry), EPOCH, EPOCH)
}
await utimes(join(staging, 'dist'), EPOCH, EPOCH)

await rm(archive, { force: true })

// COPYFILE_DISABLE stops macOS tar from embedding ._ AppleDouble entries.
// gzip -n omits the timestamp from the gzip header.
const tarball = execFileSync(
  'tar',
  ['--no-xattrs', '--uid', '0', '--gid', '0', '--uname', '', '--gname', '', '-cf', '-', ...entries],
  { cwd: staging, env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 64 * 1024 * 1024 },
)
const gzipped = execFileSync('gzip', ['-n', '-9', '-c'], { input: tarball, maxBuffer: 64 * 1024 * 1024 })
await writeFile(archive, gzipped)
await rm(staging, { recursive: true, force: true })

const digest = createHash('sha256').update(gzipped).digest('hex')
await writeFile(`${archive}.sha256`, `${digest}  ${archive}\n`)

console.log(`${archive}\nsha256: ${digest}`)
