// Push the working tree to GitHub via the Git Data API.
//
// There is no git binary on this machine, so the whole flow is: list remote
// blobs -> hash local files the way git would -> upload only what differs ->
// build a tree on top of the current one -> commit -> fast-forward the branch.
//
// The ignore rules mirror .gitignore by hand. They are load-bearing: `data-local/`
// holds the live SQLite database and `.env.local` holds real credentials, and
// both must never reach a public repo.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] ?? '.';
const REPO = 'cy-2-u/ATRI';
const BRANCH = process.argv[3] ?? 'main';
const MESSAGE_FILE = process.argv[4];
const DRY = process.argv.includes('--dry');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'data',
  'data-local',
  'backups',
  '.git',
  'sandbox',
  '.idea',
  '.vscode',
  '.monkeycode',
]);
const SKIP_DIR_PREFIX = /^atri-sandbox-/;
const SKIP_FILE = [
  /^\.env$/,          // .env.* is skipped below except .env.example
  /^\.env\.(?!example$)/,
  /\.db$/,
  /\.db-shm$/,
  /\.db-wal$/,
  /\.log$/,
  /\.tsbuildinfo$/,
  /^restore\.compose\.yaml$/,
  /^\.commitmsg$/,
  /^push-result\.txt$/,  // written by this script; leaked into a commit once
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
];

function shouldSkipFile(name) {
  return SKIP_FILE.some((re) => re.test(name));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_DIR_PREFIX.test(e.name)) continue;
      walk(join(dir, e.name), out);
    } else {
      if (shouldSkipFile(e.name)) continue;
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const BINARY_EXT = /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|zip|gz|pdf)$/i;
const CRLF_EXT = /\.bat$/i;

/** git normalizes text to LF on commit unless .gitattributes pins the file. */
function storedBytes(full) {
  const raw = readFileSync(full);
  if (CRLF_EXT.test(full) || BINARY_EXT.test(full) || raw.includes(0)) return raw;
  return Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

const blobSha = (bytes) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function gh(args, input) {
  const argv = ['api', ...args];
  if (input !== undefined) argv.push('--input', '-');
  return String(
    execFileSync('gh', argv, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      input: input ?? '',
    }),
  ).trim();
}

const post = (path, body) => JSON.parse(gh([path, '--method', 'POST'], JSON.stringify(body)));

// --- remote state -----------------------------------------------------------
const treeJson = JSON.parse(gh([`repos/${REPO}/git/trees/${BRANCH}?recursive=1`]));
if (treeJson.truncated) throw new Error('remote tree truncated; refusing to continue');
const remote = new Map();
for (const e of treeJson.tree) if (e.type === 'blob') remote.set(e.path, e.sha);

const head = JSON.parse(gh([`repos/${REPO}/git/ref/heads/${BRANCH}`]));
const baseCommit = head.object.sha;
const baseTree = JSON.parse(gh([`repos/${REPO}/git/commits/${baseCommit}`])).tree.sha;

// --- local state ------------------------------------------------------------
const local = new Map(); // path -> { file, bytes, sha }
for (const full of walk(ROOT)) {
  const path = relative(ROOT, full).replaceAll('\\', '/');
  const bytes = storedBytes(full);
  local.set(path, { file: full, bytes, sha: blobSha(bytes) });
}

const added = [];
const modified = [];
const unchanged = [];
for (const [path, info] of local) {
  const sha = remote.get(path);
  if (sha === undefined) added.push(path);
  else if (sha !== info.sha) modified.push(path);
  else unchanged.push(path);
}
const deleted = [...remote.keys()].filter((p) => !local.has(p));

console.log(`remote ${remote.size} files, local ${local.size} files`);
console.log(`added ${added.length}, modified ${modified.length}, deleted ${deleted.length}, unchanged ${unchanged.length}`);
for (const p of added.sort()) console.log('  + ' + p);
for (const p of modified.sort()) console.log('  M ' + p);
for (const p of deleted.sort()) console.log('  - ' + p);

if (DRY) {
  console.log('\n--dry: nothing uploaded');
  process.exit(0);
}
if (!MESSAGE_FILE) throw new Error('usage: push.mjs <root> [branch] <message-file> [--dry]');

// --- upload -----------------------------------------------------------------
const changed = [
  ...[...added, ...modified].sort().map((p) => ({ path: p, ...local.get(p) })),
];

const blobShas = new Map();
let done = 0;
const queue = [...changed];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const res = post(`repos/${REPO}/git/blobs`, {
        content: item.bytes.toString('base64'),
        encoding: 'base64',
      });
      blobShas.set(item.path, res.sha);
      done++;
      if (done % 10 === 0 || done === changed.length) console.log(`  blob ${done}/${changed.length}`);
    }
  }),
);

const tree = [
  ...changed.map((item) => ({
    path: item.path,
    mode: '100644',
    type: 'blob',
    sha: blobShas.get(item.path),
  })),
  // A null sha on an existing path is how the API expresses a deletion.
  ...deleted.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
];

const treeRes = post(`repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
const commit = post(`repos/${REPO}/git/commits`, {
  message: readFileSync(MESSAGE_FILE, 'utf8'),
  tree: treeRes.sha,
  parents: [baseCommit],
});
post(`repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });

writeFileSync('push-result.txt', commit.sha, 'utf8');
console.log(`\ncommit ${commit.sha} -> ${BRANCH}`);
console.log(`https://github.com/${REPO}/commit/${commit.sha}`);
