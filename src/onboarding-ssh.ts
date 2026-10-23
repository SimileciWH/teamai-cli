import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findOnPath, pathDirs } from './utils/lookpath.js';

export interface SshRemoteResolution {
  remote?: string;
  diagnostic?: string;
}

/** Show matching inputs without URL credentials, query secrets or control characters. */
export function formatOnboardingRemote(remote: string): string {
  let label = remote.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(label)) return '(remote helper address)';
  if (label.includes('://')) {
    try {
      const url = new URL(label);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      label = url.toString();
    } catch { return '(unparseable remote)'; }
  } else {
    label = label.replace(/^[^/@]+@/, '').replace(/[?#].*$/, '');
  }
  return label.split('').filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('');
}

/** Exclude implicit/relative PATH entries and the source tree, including on Windows. */
export function sshSearchDirectories(cwd: string, pathEnv: string, platform = process.platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const inside = (candidate: string) => {
    const relative = paths.relative(cwd, candidate);
    return relative === '' || (!relative.startsWith('..' + paths.sep) && relative !== '..' && !paths.isAbsolute(relative));
  };
  return pathDirs({ pathEnv, delimiter: platform === 'win32' ? ';' : ':' })
    .filter(dir => paths.isAbsolute(dir) && !inside(dir));
}

function sshExecutable(cwd: string): string | undefined {
  const source = fs.realpathSync(cwd);
  for (const dir of sshSearchDirectories(source, process.env.PATH ?? process.env.Path ?? '')) {
    try {
      const realDir = fs.realpathSync(dir);
      if (!sshSearchDirectories(source, realDir).length) continue;
      const found = findOnPath(process.platform === 'win32' ? 'ssh.exe' : 'ssh', { pathEnv: realDir, pathExt: '' });
      if (!found) continue;
      const executable = fs.realpathSync(found);
      if (sshSearchDirectories(source, path.dirname(executable)).length) return executable;
    } catch { /* Ignore unavailable PATH entries. */ }
  }
  return undefined;
}

/** Resolve only onboarding aliases; do not change persistent repository identities. */
export function resolveOnboardingSshRemote(remote: string, cwd: string): SshRemoteResolution {
  let host: string;
  let user = '';
  let port = '';
  let repoPath: string;
  const input = remote.trim();
  if (/^(?:ssh|git\+ssh|ssh\+git):\/\//.test(input)) {
    try {
      const parsed = new URL(input);
      if (parsed.password || parsed.search || parsed.hash) return {};
      host = parsed.hostname.replace(/^\[|\]$/g, '');
      user = decodeURIComponent(parsed.username);
      port = parsed.port;
      repoPath = parsed.pathname;
    } catch { return {}; }
  } else {
    if (input.includes('://') || /^[a-zA-Z]:[\\/]/.test(input)
        || (process.platform === 'win32' && /^[a-zA-Z]:/.test(input))) return {};
    const scp = /^(?:([^/@:]+)@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(input);
    if (!scp) return {};
    user = scp[1] ?? '';
    host = scp[2].replace(/^\[|\]$/g, '');
    repoPath = '/' + scp[3].replace(/^\/+/, '');
  }
  // SSH config can interpolate these values in Match exec; reject shell syntax.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(host)
      || (user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@+-]*$/.test(user))) return {};
  const args = ['-G'];
  if (port) args.push('-p', port);
  if (user) args.push('-l', user);
  args.push('--', host);
  try {
    const executable = sshExecutable(cwd);
    if (!executable) return { diagnostic: 'ssh -G: no SSH executable outside the source checkout was found on PATH' };
    const output = execFileSync(executable, args, {
      cwd, encoding: 'utf8', shell: false, timeout: 3000, maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const hostname = /^hostname\s+(\S+)\s*$/mi.exec(output)?.[1];
    const resolvedPort = /^port\s+(\d+)\s*$/mi.exec(output)?.[1];
    if (!hostname || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(hostname)
        || !resolvedPort || Number(resolvedPort) < 1 || Number(resolvedPort) > 65535) {
      return { diagnostic: `ssh -G ${host}: incomplete or invalid configuration` };
    }
    const authority = hostname.includes(':') ? `[${hostname}]` : hostname;
    return { remote: `ssh://${authority}:${resolvedPort}${repoPath}` };
  } catch {
    return { diagnostic: `ssh -G ${host}: unavailable, failed or timed out` };
  }
}
