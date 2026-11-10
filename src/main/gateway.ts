// Every tool call passes through decide() before it runs (a PreToolUse hook)
// and is audited after, mirroring OpenBot's gateway: deny beats allow, and
// anything unmatched falls back to the tool's default effect.

// Bots have full permissions by default, except that a connected (external) app
// asks before anything that isn't a read. The user's rules and per-tool settings
// (e.g. Bash under settings › 컴퓨터) come first.
import fs from 'node:fs';
import path from 'node:path';
import type { Effect, Initiator, Rule } from '../shared/types';

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
const APP_READ = /(^|[_-])(list|get|search|read|fetch|query|find|view|describe|lookup|check|status|whoami|me|info|retrieve|download|resolve|suggest)([_-]|$)/i;
function defaultEffect(call: Call, overrides: Record<string, Effect>): Effect {
  if (overrides[call.name]) return overrides[call.name];
  if (call.name.startsWith('mcp__') && !call.name.startsWith('mcp__characterbot__')) {
    return APP_READ.test(call.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')) ? 'allow' : 'ask';
  }
  return 'allow';
}

// A write to an app tied to the user's own account: claude.ai connectors and
// remote (URL/OAuth) servers. remote: tool-name slugs of remote servers.
function accountWrite(name: string, remote: string[] = []): boolean {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m || m[1] === 'characterbot' || APP_READ.test(m[2])) return false;
  return m[1].startsWith('claude_ai_') || remote.includes(m[1]);
}

// Credentials and private data a Bot never needs for normal work. Any built-in
// tool call (Bash, Read, Write, Grep…) that names one asks first, even with full
// computer access, so a prompt injection can't quietly read keys.
const SENSITIVE = [
  /(^|[\s"'/=~])\.ssh(\/|\b)/, /\.gnupg\b/, /\.aws\/(credentials|config)\b/, /\.netrc\b/, /\.npmrc\b/, /\.pypirc\b/, /\.docker\/config\.json/,
  /\.kube\/config\b/, /\.config\/(gh|gcloud|characterbot)\b/, /\.claude\.json\b/, /\.codex\/auth\.json/, /codex\/auth\.json/,
  /Library\/Keychains\b/, /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export|unlock-keychain)\b/, /Library\/Cookies\b/,
  /Library\/Application Support\/(Google\/Chrome|BraveSoftware|Microsoft Edge|Arc|Firefox|Vivaldi|com\.operasoftware)/, /Library\/Safari\b/, /Library\/Messages\b/, /Library\/Mail\b/,
  /\bsecrets\.bin\b/, /Application Support\/(OCTO CREW|PixelBot|CharacterBot)( Dev)?\/state\.json/,
];
// Where the Bot runs: its workspace sits inside the app's data folder, so a
// relative path (../../state.json) reaches the app's own files.
export interface Where { cwd: string; dataDir: string; home: string }
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
  const args = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(call.name) ? { path: call.args?.file_path ?? call.args?.notebook_path } : call.args || {};
  // Shell-escaped spaces (Application\ Support) count as spaces.
  let text = JSON.stringify(args).replace(/\\\//g, '/').replace(/\\\\ /g, ' ');
  if (where) {
    const data = real(where.dataDir);
    // Bots may read each other's workspaces (team members share files); the rest of the data folder is the app's.
    const shared = path.join(data, 'workspaces');
    text = text.replace(/(^|[\s"'=:])(~|\$HOME|\$\{HOME\})(?=\/|[\s"']|$)/g, `$1${where.home}`);
    const paths = ['path', 'file_path', 'notebook_path'].map((k) => (args as Record<string, unknown>)[k]).filter((v): v is string => typeof v === 'string' && v !== '')
      .map((v) => real(path.resolve(where.cwd, v.replace(/^~(?=\/|$)/, where.home))));
    text += JSON.stringify(paths);
    // The app's data folder (state.json, secrets.bin, codex/, bin/stt) outside the Bot workspaces.
    const under = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
    if (paths.some((p) => under(p, data) && !under(p, shared))) return true;
    const lower = text.toLowerCase();
    if ([data, where.dataDir.toLowerCase()].some((d) => lower.split(path.join(d, 'workspaces')).join('').includes(d))) return true;
    // Paths are resolved above; in a command or pattern any step up leaves the workspace (it sits in the data folder).
    if (Object.entries(args).some(([k, v]) => typeof v === 'string' && !/^(content|new_string|old_string|description|prompt|path|file_path|notebook_path)$/.test(k) && /(^|[\s"'=/:;|&(])\.\.(\/|[\s"';|&)]|$)/.test(v))) return true;
    // Globs that spell a hidden folder in the home directory (~/.ss?/id_*).
    if (text.includes(`${where.home}/.`) && new RegExp(`${where.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.[^/\\s"]*[?*[]`).test(text)) return true;
  }
  return SENSITIVE.some((re) => new RegExp(re.source, 'i').test(text));
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

// Nobody is watching a scheduled run, so "ask" fails closed.
function finalize(effect: Effect, rule: Rule | null, call: Call): Decision {
  if (effect === 'ask' && (call.initiator === 'routine' || call.initiator === 'routine-bot')) {
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

export { accountWrite, sensitive, decide, finalize, combine, maskSecrets, globToRegExp };
