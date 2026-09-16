#!/usr/bin/env node
// D-654 SHIP 3 — capture build SHA + timestamp into src/build-info.json.
//
// Resolve hash from (in order):
//  1) VERCEL_GIT_COMMIT_SHA (set by Vercel for git-integration deploys)
//  2) `git rev-parse --short HEAD` (works locally; works on Vercel CI when
//     the worktree is a real checkout)
//  3) PRESERVE the committed src/build-info.json hash (this is the case
//     for `vercel deploy` from a CLI upload — Vercel runs `npm run build`
//     in a clean sandbox without the git CLI, but src/build-info.json was
//     committed locally with the right SHA already).
//
// Always overwrite `time` + `env` (those should reflect the build runtime).
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'src', 'build-info.json')

function fromVercelEnv() {
  const vc = process.env.VERCEL_GIT_COMMIT_SHA
  return vc && vc.length >= 7 ? vc.slice(0, 7) : null
}
function fromGitCli() {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return null }
}
function fromCommittedFile() {
  if (!existsSync(OUT)) return null
  try { return JSON.parse(readFileSync(OUT, 'utf8')).hash || null }
  catch { return null }
}

// CRITICAL: if neither Vercel env nor git is available, PRESERVE the committed
// file's hash + time (only update env). Otherwise we'd overwrite the locally-
// committed real SHA with "unknown" during Vercel CI builds.
const liveHash = fromVercelEnv() || fromGitCli()
let committed = null
try { committed = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null }
catch { committed = null }

let info
if (liveHash) {
  info = {
    hash: liveHash,
    time: new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z',
    env: process.env.VERCEL_ENV || 'local',
  }
} else if (committed && committed.hash && committed.hash !== 'unknown') {
  // Preserve committed values; only refresh env (so a Vercel deploy of a
  // locally-built file still shows env=production).
  info = {
    hash: committed.hash,
    time: committed.time ?? '',
    env: process.env.VERCEL_ENV || committed.env || 'local',
  }
} else {
  info = {
    hash: 'unknown',
    time: new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z',
    env: process.env.VERCEL_ENV || 'local',
  }
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(info, null, 2) + '\n')
console.log(`[build-info] ${OUT} → ${JSON.stringify(info)}`)
