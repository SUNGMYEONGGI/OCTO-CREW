// Every tool call passes through decide() before it runs (a PreToolUse hook)
// and is audited after, mirroring OpenBot's gateway: deny beats allow, and
// anything unmatched falls back to the tool's default effect.

// Built-in tools run by default (Bash follows 설정 › 컴퓨터, 먼저 묻기 by default), and a connected (external) app
// asks before anything that isn't a read. The user's rules and per-tool settings
// (e.g. Bash under settings › 컴퓨터) come first.
import fs from 'node:fs';
import path from 'node:path';
import { APP_SERVER, APP_TOOLS, UNATTENDED, UNTRUSTED, type Effect, type Initiator, type Rule } from '../shared/types';

export interface Call {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  botId?: string;
  initiator?: Initiator;
}
export interface Decision {
  effect: Effect;
  rule?: Rule | null;
  reason?: string;
}
// An MCP tool counts as a read only when its verb is a read verb and no word in
// its name is a write verb: notion-create-view, download_and_share and
// get_or_create are writes. The service's own name (slack_, notion-) is skipped.
// Anything unknown counts as a write.
const READ_VERBS = new Set(['list', 'get', 'search', 'read', 'fetch', 'query', 'find', 'view', 'describe', 'lookup', 'retrieve', 'download', 'whoami', 'suggest', 'show', 'count', 'export']);
const WRITE_WORDS = new Set(['create', 'update', 'delete', 'remove', 'send', 'share', 'post', 'add', 'set', 'write', 'edit', 'move', 'upload',
  'archive', 'reply', 'respond', 'schedule', 'invite', 'publish', 'trash', 'copy', 'cancel', 'resolve', 'mark', 'react', 'modify', 'rename',
  'insert', 'append', 'patch', 'put', 'submit', 'approve', 'merge', 'close', 'assign', 'draft', 'save', 'star', 'label', 'restore', 'duplicate',
  'complete', 'unarchive', 'join', 'leave', 'kick', 'pin', 'unpin', 'forward', 'accept', 'decline', 'comment', 'transfer', 'pay', 'order', 'book']);
function isRead(name: string): boolean {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return false;
  const service = m[1].replace(/^claude_ai_/, '').toLowerCase().split(/[_-]/);
  const words = m[2].toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const verbs = words.filter((w) => !service.includes(w));
  return READ_VERBS.has(verbs[0]) && !words.some((w) => WRITE_WORDS.has(w));
}

function defaultEffect(call: Call, overrides: Record<string, Effect>): Effect {
  if (overrides[call.name]) return overrides[call.name];
  if (call.name.startsWith('mcp__') && !call.name.startsWith(APP_TOOLS)) return isRead(call.name) ? 'allow' : 'ask';
  return 'allow';
}

// A write to an app tied to the user's own account: claude.ai connectors and
// servers signed in as the user (remote/OAuth, or given a token in env, headers
// or args). accounts: tool-name slugs of those servers.
function accountWrite(name: string, accounts: string[] = []): boolean {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m || m[1] === APP_SERVER || isRead(name)) return false;
  return m[1].startsWith('claude_ai_') || accounts.includes(m[1]);
}

// A shell command that writes to an account outside the Mac: driving Mail,
// Messages or another app through AppleScript, gh commands that change GitHub,
// and curl/wget calls that send data (POST/PUT/PATCH/DELETE, -d, -F, --json).
// ponytail: a small shell reader, not a full parser. It follows quotes, every
// command separator, $(…)/`…`, sh -c, eval and xargs; anything stranger (aliases,
// scripts written to disk first) gets past it. The real fence is 먼저 묻기.

// Splits a command line into simple commands, each a list of unquoted words.
function shellCommands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [], word = '', inWord = false, quote = '';
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < line.length) { word += line[++i]; inWord = true; continue; }
    if (/\s/.test(c) && c !== '\n') { endWord(); continue; }
    if (';&|\n()`'.includes(c) || (c === '$' && line[i + 1] === '(')) { endCmd(); if (c === '$') i++; continue; }
    word += c; inWord = true;
  }
  endCmd();
  // $(…) and `…` inside double quotes still run.
  for (const m of line.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) if (m[0] !== line) out.push(...shellCommands(m[1] ?? m[2]));
  return out;
}

const PREFIX = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'caffeinate', 'xargs', 'env', 'builtin', 'doas']);
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
// The value of -X/--request/--method, whether written -X POST, -XPOST or --method=POST.
function methodOf(args: string[], short: string, long: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === short || long.includes(a)) return args[i + 1] ?? null;
    if (a.startsWith(short) && !a.startsWith('--')) return a.slice(short.length);
    const eq = long.find((l) => a.startsWith(`${l}=`));
    if (eq) return a.slice(eq.length + 1);
  }
  return null;
}
const GH_GROUPS = new Set(['pr', 'issue', 'repo', 'run', 'release', 'workflow', 'gist', 'label', 'project', 'secret', 'variable', 'cache', 'ruleset', 'codespace', 'org', 'ssh-key', 'gpg-key']);
const GH_READS = new Set(['list', 'view', 'status', 'diff', 'checks', 'watch', 'download']);
function ghWrites(args: string[]): boolean {
  const [sub, action] = args;
  if (['status', 'browse', 'search', 'help', 'version', '--version', '--help'].includes(sub)) return false;
  if (sub === 'auth') return action !== 'status' && action !== 'token';
  if (GH_GROUPS.has(sub)) return !GH_READS.has(action);
  if (sub === 'api') {
    const method = methodOf(args, '-X', ['--method']);
    if (method && !/^GET$/i.test(method)) return true;
    return args.some((a) => /^(-[fF]|--field|--raw-field|--input)/.test(a));
  }
  return true; // anything else (extensions, aliases) may write
}
function curlSends(name: string, args: string[]): boolean {
  if (name === 'http' || name === 'https' || name === 'xh') {
    return args.some((a) => WRITE_METHOD.test(a) || /^[^-=:][^=:@]*(:=|=(?!=)|@)/.test(a) && !/^https?:\/\//.test(a));
  }
  const method = methodOf(args, '-X', ['--request', '--method']);
  if (method && WRITE_METHOD.test(method)) return true;
  return args.some((a) => /^--(data|form|json|upload-file|post-data|post-file)/.test(a)
    || (name === 'curl' && /^-[a-zA-Z]*[dFT]/.test(a) && !a.startsWith('--')));
}

// A server argument that passes a credential: a ${SECRET} reference, a
// --token/--api-key style flag, or a value shaped like a key.
function tokenArg(arg: string): boolean {
  return arg.includes('${') || /^--?[\w-]*(token|key|secret|password|passwd|auth|credential|bearer)\b/i.test(arg)
    || /(^|=)(sk-|xox[abpors]-|gh[pousr]_|github_pat_|ntn_|secret_|glpat-|AKIA|ya29\.|AIza)\S{8,}/.test(arg)
    || /(^|=)[A-Za-z0-9_\-]{32,}$/.test(arg) && /\d/.test(arg) && /[A-Za-z]/.test(arg);
}

function accountWriteCommand(command: string): boolean {
  for (let words of shellCommands(command)) {
    // Skip VAR=value, wrappers like sudo/env/xargs and their flags.
    for (;;) {
      while (words.length && /^\w+=/.test(words[0])) words = words.slice(1);
      if (!words.length || !PREFIX.has(path.basename(words[0]))) break;
      words = words.slice(1);
      while (words.length && words[0].startsWith('-')) words = words.slice(1);
    }
    if (!words.length) continue;
    const name = path.basename(words[0]);
    const args = words.slice(1);
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) {
      const c = args.findIndex((a) => /^-\w*c$/.test(a));
      if (c >= 0 && args[c + 1] && accountWriteCommand(args[c + 1])) return true;
      continue;
    }
    if (name === 'eval' && accountWriteCommand(args.join(' '))) return true;
    if (['osascript', 'automator', 'shortcuts'].includes(name)) return true;
    if (name === 'gh' && ghWrites(args)) return true;
    if (['curl', 'wget', 'http', 'https', 'xh'].includes(name) && curlSends(name, args)) return true;
  }
  return false;
}

// Credentials and private data a Bot never needs for normal work. Any built-in
// tool call (Bash, Read, Write, Grep…) that names one asks first, even with full
// computer access, so a prompt injection can't quietly read keys.
const SENSITIVE = [
  /(^|[\s"'/=~])\.ssh(\/|\b)/, /\.gnupg\b/, /\.aws\/(credentials|config)\b/, /\.netrc\b/, /\.npmrc\b/, /\.pypirc\b/, /\.docker\/config\.json/,
  /\.kube\/config\b/, /\.config\/(gh|gcloud|octocrew|characterbot)\b/, /\.claude\.json\b/, /\.codex\/auth\.json/, /codex\/auth\.json/,
  /Library\/Keychains\b/, /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export|unlock-keychain)\b/, /Library\/Cookies\b/,
  /Library\/Application Support\/(Google\/Chrome|BraveSoftware|Microsoft Edge|Arc|Firefox|Vivaldi|com\.operasoftware)/, /Library\/Safari\b/, /Library\/Messages\b/, /Library\/Mail\b/,
  /\bsecrets\.bin\b/, /Application Support\/(OCTO CREW|PixelBot|CharacterBot)( Dev)?\/state\.json/,
];
// Files that run something later on their own: shell startup files, login items,
// SSH keys that let someone in, git hooks. A file tool or a shell command that
// names one asks first even with 항상 허용 (#104).
const AUTORUN = [
  /(^|[\s"'/=~])\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|kshrc|inputrc)\b/,
  /\.config\/fish\b/, /Library\/Launch(Agents|Daemons)\b/, /\/etc\/(paths|profile|zshrc|zshenv|bashrc|sudoers|hosts)\b/,
  /\bauthorized_keys\b/, /\.git\/hooks\b/, /\bcore\.hooksPath\b/, /\.(vimrc|gitconfig)\b/,
];
const FILE_WRITE = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
// The same places as absolute paths, for sandboxes that deny reads by path
// (Codex Bots, #105). Keep in step with SENSITIVE.
function secretPaths(home: string, dataDir: string): string[] {
  const lib = path.join(home, 'Library');
  const support = path.join(lib, 'Application Support');
  return [
    ...['.ssh', '.gnupg', '.aws', '.netrc', '.npmrc', '.pypirc', '.docker/config.json', '.kube', '.config/gh', '.config/gcloud',
      '.config/octocrew', '.config/characterbot', '.claude.json', '.codex'].map((p) => path.join(home, p)),
    ...['Keychains', 'Cookies', 'Safari', 'Messages', 'Mail'].map((p) => path.join(lib, p)),
    ...['Google/Chrome', 'BraveSoftware', 'Microsoft Edge', 'Arc', 'Firefox', 'Vivaldi', 'com.operasoftware.Opera'].map((p) => path.join(support, p)),
    '/Library/Keychains', dataDir, // the app's own state.json, secrets.bin, Codex login
  ];
}

// Where the Bot runs. Since v0.4.6 workspaces live in their own folder next to
// the app's data folder; older layouts kept them inside it, where a relative
// path (../../state.json) reached the app's own files.
export interface Where { cwd: string; dataDir: string; home: string; workspaces?: string }
// Real path of the closest existing parent plus the rest, lower-cased: the
// default macOS volume ignores case, so State.JSON is state.json.
function real(p: string): string {
  let head = path.resolve(p), rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync(head), rest).toLowerCase(); } catch {}
    const up = path.dirname(head);
    if (up === head) return path.resolve(p).toLowerCase();
    rest = path.join(path.basename(head), rest);
    head = up;
  }
}
function sensitive(call: Call, where?: Where): boolean {
  if (call.name.startsWith('mcp__')) return false;
  // What a file tool writes is content, not a target: only its path counts.
  const args = FILE_WRITE.test(call.name) ? { path: call.args?.file_path ?? call.args?.notebook_path } : call.args || {};
  // Shell-escaped spaces (Application\ Support) count as spaces.
  let text = JSON.stringify(args).replace(/\\\//g, '/').replace(/\\\\ /g, ' ');
  if (where) {
    const data = real(where.dataDir);
    // Bots may read each other's workspaces (team members share files); the rest of the data folder is the app's.
    const shared = real(where.workspaces || path.join(where.dataDir, 'workspaces'));
    text = text.replace(/(^|[\s"'=:])(~|\$HOME|\$\{HOME\})(?=\/|[\s"']|$)/g, `$1${where.home}`);
    const paths = ['path', 'file_path', 'notebook_path'].map((k) => (args as Record<string, unknown>)[k]).filter((v): v is string => typeof v === 'string' && v !== '')
      .map((v) => real(path.resolve(where.cwd, v.replace(/^~(?=\/|$)/, where.home))));
    text += JSON.stringify(paths);
    // The app's data folder (state.json, secrets.bin, codex/, bin/stt) outside the Bot workspaces.
    const under = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
    if (paths.some((p) => under(p, data) && !under(p, shared))) return true;
    const lower = text.toLowerCase();
    // Workspace paths are fine even when they share a prefix with the data folder ("OCTO CREW Workspaces").
    const rest = [shared, (where.workspaces || path.join(where.dataDir, 'workspaces')).toLowerCase()].reduce((t, w) => t.split(w).join(''), lower);
    if ([data, where.dataDir.toLowerCase()].some((d) => rest.includes(d))) return true;
    // Paths are resolved above; in a command or pattern any step up leaves the workspace.
    if (Object.entries(args).some(([k, v]) => typeof v === 'string' && !/^(content|new_string|old_string|description|prompt|path|file_path|notebook_path)$/.test(k) && /(^|[\s"'=/:;|&(])\.\.(\/|[\s"';|&)]|$)/.test(v))) return true;
    // Globs that spell a hidden folder in the home directory (~/.ss?/id_*).
    if (text.includes(`${where.home}/.`) && new RegExp(`${where.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.[^/\\s"]*[?*[]`).test(text)) return true;
  }
  // Reading a startup file is harmless; writing or running through one isn't.
  const list = call.name === 'Read' || call.name === 'Grep' || call.name === 'Glob' ? SENSITIVE : [...SENSITIVE, ...AUTORUN];
  return list.some((re) => new RegExp(re.source, 'i').test(text));
}

// A file tool writing outside the Bot workspaces (its own and its teammates').
function writesOutside(call: Call, where?: Where): boolean {
  if (!where || !FILE_WRITE.test(call.name)) return false;
  const p = call.args?.file_path ?? call.args?.notebook_path;
  if (typeof p !== 'string' || !p) return true;
  const target = real(path.resolve(where.cwd, p.replace(/^~(?=\/|$)/, where.home)));
  const dir = real(where.workspaces || path.join(where.dataDir, 'workspaces'));
  return !(target === dir || target.startsWith(dir + path.sep));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matches(rule: Rule, call: Call): boolean {
  if (rule.botId && rule.botId !== call.botId) return false;
  if (!globToRegExp(rule.tool || '*').test(call.name)) return false;
  if (rule.match) {
    try {
      if (!new RegExp(rule.match, 'i').test(JSON.stringify(call.args))) return false;
    } catch {
      return false; // A broken pattern never widens access.
    }
  }
  return true;
}

// overrides: per-tool default effects from settings, e.g. { Bash: 'allow' }.
function decide(call: Call, rules: Rule[] = [], overrides: Record<string, Effect> = {}): Decision {
  for (const effect of ['deny', 'allow', 'ask'] as const) {
    const rule = rules.find((r) => r.effect === effect && matches(r, call));
    if (rule) return finalize(effect, rule, call);
  }
  return finalize(defaultEffect(call, overrides), null, call);
}

// Combines the effects of natural-language rules that matched; on conflict
// "ask first" wins.
function combine(effects: Effect[]): Effect | null {
  if (!effects.length) return null;
  return new Set(effects).size > 1 ? 'ask' : effects[0];
}

// A shell command in a run started by outside text (webhook, folder, PR).
function untrustedShell(call: Call): boolean {
  return call.name === 'Bash' && Boolean(call.initiator && UNTRUSTED.includes(call.initiator));
}

// Nobody is watching a scheduled run, so "ask" fails closed.
function finalize(effect: Effect, rule: Rule | null, call: Call): Decision {
  if (effect === 'ask' && call.initiator && UNATTENDED.includes(call.initiator)) {
    return { effect: 'deny', rule, reason: '루틴 실행 중에는 승인이 필요한 작업을 할 수 없습니다' };
  }
  return { effect, rule };
}

function maskSecrets(text: unknown, secretValues: string[]): string {
  let out = String(text ?? '');
  for (const value of secretValues) {
    if (value && value.length >= 4) out = out.split(value).join('••••');
  }
  return out;
}

export { untrustedShell, accountWrite, accountWriteCommand, tokenArg, isRead, sensitive, secretPaths, writesOutside, decide, finalize, combine, maskSecrets, globToRegExp };
