// Verifies that the package about to be published actually contains the build output.
// Runs `npm pack --dry-run --json` and checks the resulting file list, so it inspects
// exactly what `npm publish` would upload. Exits non-zero on any problem.
//
// Context: 5.0.240 was published with only package.json in the tarball (fileCount=1),
// healthy releases ship ~90-130 files under build/.

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT_DIR = path.join(__dirname, '..')
const REQUIRED_FILES = ['build/index.js', 'build/index.d.ts', 'build/providers.json']
const MIN_FILE_COUNT = +(process.env.SDK_PUBLISH_MIN_FILES || 50)
const MIN_UNPACKED_BYTES = +(process.env.SDK_PUBLISH_MIN_BYTES || 300_000)
// src/providers.json in git only has ~160 chains (59 with rpcs); `npm run update-providers` expands it to ~1800.
// A low count here means the publish script skipped the provider update.
const MIN_CHAINS_WITH_RPC = +(process.env.SDK_PUBLISH_MIN_CHAINS || 1000)

function fail(msg) {
  console.error(`\n[verify-package] FAILED: ${msg}\n`)
  process.exit(1)
}

// 1. build output must exist on disk
for (const f of REQUIRED_FILES) {
  const p = path.join(ROOT_DIR, f)
  if (!fs.existsSync(p)) fail(`${f} is missing on disk, run "npm run build" first`)
  if (fs.statSync(p).size === 0) fail(`${f} is empty`)
}

// 2. providers.json must be a sane, non-empty chain list
const providers = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'build/providers.json'), 'utf8'))
const chainCount = Object.keys(providers).length
const chainsWithRpc = Object.values(providers).filter((i) => Array.isArray(i?.rpc) && i.rpc.length).length
if (chainsWithRpc < MIN_CHAINS_WITH_RPC)
  fail(`build/providers.json only has ${chainsWithRpc} chains with at least one rpc (expected at least ${MIN_CHAINS_WITH_RPC}), was "npm run update-providers" run?`)

// 3. inspect the tarball npm would actually upload
let packOutput
try {
  packOutput = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
} catch (e) {
  fail(`npm pack --dry-run failed: ${e.message}`)
}
const pack = JSON.parse(packOutput)[0]
const files = new Set(pack.files.map((f) => f.path))

for (const f of REQUIRED_FILES) {
  if (!files.has(f)) fail(`${f} is not included in the npm tarball (check "files" in package.json)`)
}
if (!files.has('package.json')) fail('package.json is not included in the npm tarball')

const buildFiles = [...files].filter((f) => f.startsWith('build/'))
if (buildFiles.length < MIN_FILE_COUNT)
  fail(`tarball only has ${buildFiles.length} files under build/ (expected at least ${MIN_FILE_COUNT})`)
if (pack.unpackedSize < MIN_UNPACKED_BYTES)
  fail(`tarball unpacked size is ${pack.unpackedSize} bytes (expected at least ${MIN_UNPACKED_BYTES})`)

const leaked = [...files].filter((f) => /\.test\.(js|d\.ts|js\.map)$/.test(f) || /build\/abi\/largeMulticall\.(js|d\.ts)$/.test(f))
if (leaked.length) fail(`files that should be excluded are in the tarball:\n  ${leaked.join('\n  ')}`)

// 4. the compiled entrypoint must be loadable
try {
  const sdk = require(path.join(ROOT_DIR, 'build/index.js'))
  if (!sdk.api || !sdk.ChainApi) fail('build/index.js loaded but does not export api/ChainApi')
} catch (e) {
  fail(`build/index.js could not be required: ${e.message}`)
}

console.log(`[verify-package] OK: ${pack.name}@${pack.version}, ${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked, ${chainsWithRpc}/${chainCount} chains with rpcs in providers.json`)
