/**
 * Dynamic Expo config — spreads app.json and stamps the git SHA so Profile
 * can link the installed build to a public commit (same idea as Orbcast web).
 *
 * EAS sets EAS_BUILD_GIT_COMMIT_HASH. Local `expo start` falls back to HEAD.
 */
const { execSync } = require('child_process');

function resolveGitCommit() {
  const fromEnv = (
    process.env.EAS_BUILD_GIT_COMMIT_HASH ||
    process.env.EXPO_PUBLIC_GIT_COMMIT_HASH ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ''
  ).trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.toLowerCase();
  } catch {
    // EAS snapshot without git, or config evaluated outside a repo.
  }
  return '';
}

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    gitCommitHash: resolveGitCommit(),
    githubRepoUrl:
      process.env.EXPO_PUBLIC_GITHUB_REPO_URL ||
      config.extra?.githubRepoUrl ||
      'https://github.com/LWL-HyperTrade/hypertrade',
  },
});
