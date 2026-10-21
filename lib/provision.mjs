#!/usr/bin/env node
// Cấp phát cấu hình riêng cho từng bot: tools/moonlight-throne/bots/<bot>/env (chmod 600).
//   provision create <bot> [--workdir D] [--from-env] [--force]
//   provision list | show <bot> | remove <bot>
// Launcher đọc file này qua CODER_ENV_FILE=<path>. Không bao giờ in giá trị key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOTS_DIR = path.join(CODER_DIR, 'bots');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEYS = ['COMMANDCODE_API_KEY', 'XAI_API_KEY'];

const die = (m, c = 1) => { console.error('provision: ' + m); process.exit(c); };

function botsRoot(create) {
  if (create) { fs.mkdirSync(BOTS_DIR, { recursive: true, mode: 0o700 }); try { fs.chmodSync(BOTS_DIR, 0o700); } catch {} }
  else if (!fs.existsSync(BOTS_DIR)) return null;
  const st = fs.lstatSync(BOTS_DIR);
  if (st.isSymbolicLink() || !st.isDirectory()) die('bots/ không phải thư mục thật');
  return fs.realpathSync(BOTS_DIR);
}
function checkName(n) {
  if (typeof n !== 'string' || !NAME_RE.test(n)) die(`tên bot không hợp lệ (cần ${NAME_RE})`);
  return n;
}
// Trả về đường dẫn thư mục bot đã kiểm tra nằm trong bots/ (resolve thật nếu đã tồn tại).
function botDir(root, name) {
  const d = path.join(root, name);
  if (path.dirname(d) !== root) die('đường dẫn ra ngoài bots/');
  if (fs.existsSync(d) || isLink(d)) {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) die(`bots/${name} không phải thư mục thật`);
    const real = fs.realpathSync(d);
    if (real !== d) die('đường dẫn resolve ra ngoài bots/');
  }
  return d;
}
function isLink(p) { try { fs.lstatSync(p); return true; } catch { return false; } }

function parseEnv(text) {
  const o = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
const isSet = v => v !== undefined && v.trim() !== '' && v.trim() !== '""' && v.trim() !== "''";

function cmdCreate(args) {
  let name, workdir, fromEnv = false, force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workdir') { workdir = args[++i]; if (!workdir) die('--workdir cần giá trị'); }
    else if (a.startsWith('--workdir=')) workdir = a.slice(10);
    else if (a === '--from-env') fromEnv = true;
    else if (a === '--force') force = true;
    else if (a.startsWith('-')) die('cờ lạ: ' + a);
    else if (name === undefined) name = a;
    else die('thừa đối số: ' + a);
  }
  checkName(name);
  if (workdir !== undefined) {
    if (/[\r\n\0]/.test(workdir)) die('--workdir chứa ký tự không hợp lệ');
    workdir = path.resolve(workdir);
  }
  const root = botsRoot(true);
  const dir = botDir(root, name);
  const file = path.join(dir, 'env');
  if (isLink(dir) && !force) die(`bot "${name}" đã tồn tại (dùng --force để ghi đè)`);
  if (isLink(file) && !force) die(`bot "${name}" đã tồn tại (dùng --force để ghi đè)`);
  let src = {};
  if (fromEnv) {
    const f = path.join(CODER_DIR, '.env');
    if (!fs.existsSync(f)) die('--from-env: không có tools/moonlight-throne/.env');
    src = parseEnv(fs.readFileSync(f, 'utf8'));
  }
  const lines = [
    `# Cấu hình riêng của bot "${name}" (tạo bởi provision). KHÔNG commit. Dùng: CODER_ENV_FILE=<file này> mth-sandbox ...`,
    ...KEYS.map(k => `${k}=${fromEnv && isSet(src[k]) ? src[k] : ''}`),
    `CODER_JOB_NAMESPACE=${name}`,
  ];
  if (workdir !== undefined) lines.push(`CODER_WORKDIR=${workdir}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (botDir(root, name) !== dir) die('đường dẫn không hợp lệ');
  // ghi qua file tạm 600 rồi rename để không có khoảnh khắc quyền rộng
  const tmp = path.join(dir, `.env.tmp.${process.pid}`);
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  console.log(`Đã tạo ${file} (600)`);
  const empty = KEYS.filter(k => !(fromEnv && isSet(src[k])));
  if (empty.length) console.log('Cần điền: ' + empty.join(', '));
  console.log('Chạy:');
  console.log(`  CODER_ENV_FILE=${file} ${path.join(CODER_DIR, 'mth-sandbox')} -p --model <tên> "việc cần làm"`);
}

function listBots(root) {
  if (!root) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && NAME_RE.test(e.name)).map(e => e.name).sort();
}
function cmdList() {
  const names = listBots(botsRoot(false));
  if (!names.length) { console.log('(chưa có bot nào)'); return; }
  for (const n of names) console.log(n);
}
function cmdShow(args) {
  if (args.length !== 1) die('cú pháp: show <bot>');
  const name = checkName(args[0]);
  const root = botsRoot(false);
  if (!root) die(`không có bot "${name}"`);
  const dir = botDir(root, name);
  const file = path.join(dir, 'env');
  if (!fs.existsSync(file)) die(`không có bot "${name}"`);
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  console.log(`bot: ${name}`);
  console.log(`file: ${file}`);
  console.log(`mode: ${(fs.statSync(file).mode & 0o777).toString(8)}`);
  for (const k of KEYS) console.log(`${k}: ${isSet(env[k]) ? 'đã đặt' : 'chưa đặt'}`);
  console.log(`CODER_JOB_NAMESPACE: ${env.CODER_JOB_NAMESPACE ?? '(không có)'}`);
  console.log(`CODER_WORKDIR: ${env.CODER_WORKDIR ?? '(không có)'}`);
}
function cmdRemove(args) {
  if (args.length !== 1) die('cú pháp: remove <bot>');
  const name = checkName(args[0]);
  const root = botsRoot(false);
  const d = root && path.join(root, name);
  if (!d || !isLink(d)) die(`không có bot "${name}"`);
  const dir = botDir(root, name);
  if (path.dirname(dir) !== root || !dir.startsWith(root + path.sep)) die('đường dẫn ngoài bots/');
  fs.rmSync(dir, { recursive: true, force: false });
  console.log(`Đã xóa bot "${name}"`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'create': cmdCreate(rest); break;
  case 'list': cmdList(); break;
  case 'show': cmdShow(rest); break;
  case 'remove': cmdRemove(rest); break;
  default: console.error('Cú pháp: provision create <bot> [--workdir D] [--from-env] [--force] | list | show <bot> | remove <bot>'); process.exit(cmd ? 2 : 0);
}
