import jwt from 'jsonwebtoken';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { branchNameForDigest, LEGACY_BRANCH, resolveFreeBranch } from '@apimigrate/core';

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
 * Find an already-open PR for a head branch (retry reconciliation).
 * Returns the existing PR so retries never open duplicates — including the
 * worker-die-after-PR-create case, where the retry reconciles the single
 * already-created PR instead of opening a second one.
 */
export async function findExistingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<{ url: string; number: number } | null> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${head}`,
    base,
  });
  const pr = data[0];
  return pr ? { url: pr.html_url, number: pr.number } : null;
}

/**
 * Create a migration PR without ever overwriting existing work.
 *
 * FR-10 delivery safety:
 * - When `candidateDigest` is provided and the caller asked for the legacy
 *   shared branch, a candidate-specific branch is used instead.
 * - If an open PR already exists for the branch, it is returned as-is
 *   (`reconciled: true`) — retries do not duplicate PRs.
 * - If the branch ref already exists (user edits, prior run), it is left
 *   untouched; a free suffixed branch is resolved instead. PATCH never
 *   deletes or force-moves a branch.
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
    candidateDigest?: string;
  },
): Promise<{ url: string; number: number; head: string; reconciled?: boolean }> {
  const { base, title, body, changedFiles, candidateDigest } = opts;
  let head = opts.head;
  if (candidateDigest && (head === LEGACY_BRANCH || head === 'apimigrate/auto-migration')) {
    head = branchNameForDigest(candidateDigest);
  }

  const baseSha = (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })).data.object.sha;

  // Idempotent retry: an open PR for this branch is the answer already.
  const existing = await findExistingPr(octokit, owner, repo, head, base);
  if (existing) {
    return { ...existing, head, reconciled: true };
  }

  const branchExists = async (branch: string): Promise<boolean> => {
    try {
      await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  };

  // Never delete or overwrite: resolve a free name when taken.
  let resolved = head;
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${head}`, sha: baseSha });
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    const free = await resolveFreeBranch(head, branchExists);
    resolved = free.branch;
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${resolved}`, sha: baseSha });
  }

  const tree: Array<{ path: string; mode: '100644'; type: 'blob'; content: string }> = [];
  for (const [file, content] of changedFiles) {
    tree.push({ path: file, mode: '100644', type: 'blob', content });
  }
  const { data: createdTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseSha,
    tree,
  });
  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: 'chore(apimigrate): apply API migration',
    tree: createdTree.sha,
    parents: [baseSha],
  });
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${resolved}`,
    sha: commit.sha,
    force: false,
  });

  try {
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      head: resolved,
      base,
      body,
    });
    return { url: pr.html_url, number: pr.number, head: resolved };
  } catch (err) {
    // Lost race with a concurrent creator: reconcile instead of duplicating.
    if ((err as { status?: number }).status !== 422) throw err;
    const raced = await findExistingPr(octokit, owner, repo, resolved, base);
    if (raced) return { ...raced, head: resolved, reconciled: true };
    throw err;
  }
}
