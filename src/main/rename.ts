// v0.2.0 renamed CharacterBot to PixelBot, and PixelBot became OCTO CREW. These
// move an older install over once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const LEGACY_NAME = 'CharacterBot';
// Older names, newest first.
export const LEGACY_NAMES = ['PixelBot', LEGACY_NAME];

// Claude Code keeps sessions under ~/.claude/projects/<cwd with every
// non-alphanumeric character turned into "-">.
const projectKey = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-');

// Moves `from` to `to` when `to` has no state.json yet, rewrites the absolute paths in
// state.json and moves the bots' Claude sessions so conversations resume.
// Returns true when it moved something.
export function moveDataDir(from: string, to: string, claudeProjects = path.join(os.homedir(), '.claude', 'projects')): boolean {
  if (fs.existsSync(path.join(to, 'state.json')) || !fs.existsSync(from)) return false;
  // Chromium can create the new folder (caches only) before this runs.
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  const stateFile = path.join(to, 'state.json');
  if (fs.existsSync(stateFile)) {
    const esc = (p: string) => JSON.stringify(p).slice(1, -1);
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').split(esc(from) + esc(path.sep)).join(esc(to) + esc(path.sep)));
  }
  const oldKey = `${projectKey(from)}-workspaces-`;
  const newKey = `${projectKey(to)}-workspaces-`;
  try {
    for (const name of fs.readdirSync(claudeProjects)) {
      const dest = path.join(claudeProjects, newKey + name.slice(oldKey.length));
      if (name.startsWith(oldKey) && !fs.existsSync(dest)) fs.renameSync(path.join(claudeProjects, name), dest);
    }
  } catch {}
  return true;
}

// v0.4.6 moved Bot workspaces out of the data folder (<data>/workspaces/<bot>)
// into a folder of their own, so nothing secret sits above a Bot's working
// directory. Moves each Bot's folder, rewrites the paths in state.json and moves
// the Claude sessions keyed by the old working directory. Returns true when it moved something.
export function moveWorkspaces(dataDir: string, to: string, claudeProjects = path.join(os.homedir(), '.claude', 'projects')): boolean {
  const from = path.join(dataDir, 'workspaces');
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // nothing to move
    throw err; // unreadable: stop before the app starts using an empty new folder
  }
  fs.mkdirSync(to, { recursive: true });
  const moved: string[] = [];
  for (const name of names) {
    const src = path.join(from, name), dest = path.join(to, name);
    if (!fs.existsSync(dest)) fs.renameSync(src, dest);
    else if (fs.statSync(src).isDirectory()) {
      // An earlier run (or an older app) already made this Bot's new folder: merge,
      // keeping what's there, and leave any clash in the old folder.
      for (const entry of fs.readdirSync(src)) if (!fs.existsSync(path.join(dest, entry))) fs.renameSync(path.join(src, entry), path.join(dest, entry));
      try { fs.rmdirSync(src); } catch {}
    }
    if (!fs.existsSync(src)) moved.push(name);
  }
  try { fs.rmdirSync(from); } catch {} // left in place if anything couldn't move
  // Only Bots whose folder fully moved point at the new place.
  const stateFile = path.join(dataDir, 'state.json');
  if (fs.existsSync(stateFile)) {
    const esc = (p: string) => JSON.stringify(p).slice(1, -1);
    let text = fs.readFileSync(stateFile, 'utf8');
    for (const name of moved) {
      for (const tail of [esc(path.sep), '"']) text = text.split(esc(path.join(from, name)) + tail).join(esc(path.join(to, name)) + tail);
    }
    fs.writeFileSync(stateFile, text);
  }
  const oldKey = `${projectKey(from)}-`;
  const newKey = `${projectKey(to)}-`;
  try {
    for (const name of fs.readdirSync(claudeProjects)) {
      if (!name.startsWith(oldKey)) continue;
      const src = path.join(claudeProjects, name);
      const dest = path.join(claudeProjects, newKey + name.slice(oldKey.length));
      // The keys can differ only in case (…-workspaces- vs …-Workspaces-), which
      // the default macOS volume sees as the same folder: rename it anyway.
      if (!fs.existsSync(dest) || src.toLowerCase() === dest.toLowerCase()) fs.renameSync(src, dest);
    }
  } catch {}
  return true;
}

// Decrypts a safeStorage blob written under the old app name. On macOS the key
// is the "<name> Safe Storage" Keychain password (Chromium's v10 format:
// AES-128-CBC, PBKDF2-SHA1 with salt "saltysalt", 1003 rounds, IV of spaces).
export function decryptLegacy(blob: Buffer, password: string | null): string | null {
  if (!password || blob.subarray(0, 3).toString() !== 'v10') return null;
  try {
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    return Buffer.concat([d.update(blob.subarray(3)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Reads an old Keychain password without blocking the app; macOS asks the user
// once to let OCTO CREW read the PixelBot (or CharacterBot) item. Null when there
// is no such item (exit 44). Any other failure (Deny, timeout) rejects, so a
// refusal doesn't open the next item's prompt right after; 다시 시도 asks again.
export function legacyPassword(name = LEGACY_NAME): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-w', '-s', `${name} Safe Storage`], { timeout: 120000 }, (err, out) => {
      try { resolve(keychainResult(err, out)); } catch (e) { reject(e); }
    });
  });
}

// `security` exits 44 when the item doesn't exist; anything else (Deny, timeout) throws.
export function keychainResult(err: (Error & { code?: unknown }) | null, out: unknown): string | null {
  if (!err) return String(out).trim();
  if (err.code === 44) return null;
  throw err;
}
