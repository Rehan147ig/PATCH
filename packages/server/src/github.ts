import jwt from 'jsonwebtoken';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  /** Optional webhook secret (if omitted, webhook verification is skipped). */
  webhookSecret?: string;
}

/** Verify the GitHub webhook signature (HMAC SHA-256 of the body with the secret). */
export function verifyWebhookSignature(secret: string, body: string, signatureHeader?: string): boolean {
  if (!signatureHeader) return false;
  const expected = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  const actual = hmac.digest('hex');
  // Constant-time comparison.
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create an Octokit authenticated as the GitHub App installation for a repo.
 * Uses the app's JWT to exchange for an installation access token.
 */
export async function createInstallationOctokit(
  config: GitHubAppConfig,
  owner: string,
  repo: string,
): Promise<Octokit> {
  const appJwt = jwt.sign(
    { iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 60 * 10, iss: config.appId },
    config.privateKey,
    { algorithm: 'RS256' },
  );

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey },
  });

  const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
  const installationId = installation.id;

  const authResult = await appOctokit.auth({
    type: 'installation',
    installationId,
  });
  const token = (authResult as { token: string }).token;

  return new Octokit({ auth: token });
}

/**
 * Create a migration PR: create a branch, write files, commit, push, open PR.
 */
export async function createMigrationPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: {
    base: string;
    head: string;
    title: string;
    body: string;
    changedFiles: Map<string, string>;
  },
): Promise<{ url: string; number: number }> {
  const { base, head, title, body, changedFiles } = opts;
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })).data.object.sha,
    });
  } catch (err) {
    // Branch may already exist; if so, delete and recreate to keep the PR clean.
    const status = (err as { status?: number }).status;
    if (status !== 422) throw err;
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head}` });
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })).data.object.sha,
    });
  }

  const baseCommit = (
    await octokit.rest.git.getRef({ owner, repo, ref: `heads/${head}` })
  ).data.object.sha;
  const tree: Array<{ path: string; mode: '100644'; type: 'blob'; content: string }> = [];
  for (const [file, content] of changedFiles) {
    tree.push({ path: file, mode: '100644', type: 'blob', content });
  }
  const { data: createdTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit,
    tree,
  });
  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: 'chore(apimigrate): apply API migration',
    tree: createdTree.sha,
    parents: [baseCommit],
  });
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${head}`,
    sha: commit.sha,
    force: false,
  });

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    head,
    base,
    body,
  });
  return { url: pr.html_url, number: pr.number };
}
