import Constants from 'expo-constants';

const extra =
  ((Constants.expoConfig?.extra as Record<string, unknown> | undefined) ??
    ((Constants as { manifest2?: { extra?: Record<string, unknown> } }).manifest2?.extra) ??
    {}) as Record<string, unknown>;

const DEFAULT_GITHUB_REPO = 'https://github.com/LWL-HyperTrade/hypertrade';

function normalizeSha(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const sha = raw.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** Full SHA baked into the binary (EAS / local HEAD). */
export function getBuildCommitSha(): string | null {
  return normalizeSha(extra.gitCommitHash);
}

export function getBuildCommitShort(): string | null {
  const sha = getBuildCommitSha();
  return sha ? sha.slice(0, 7) : null;
}

/** Public commit URL so anyone can verify this build against source. */
export function getBuildCommitUrl(): string | null {
  const sha = getBuildCommitSha();
  if (!sha) return null;
  const repo =
    (typeof extra.githubRepoUrl === 'string' && extra.githubRepoUrl.trim()) ||
    DEFAULT_GITHUB_REPO;
  return `${repo.replace(/\/$/, '')}/commit/${sha}`;
}
