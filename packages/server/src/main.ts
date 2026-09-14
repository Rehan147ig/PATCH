import express from 'express';
import path from 'node:path';
import { createServer } from './index.js';
import type { GitHubAppConfig } from './github.js';

async function main() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const manifestsDir = process.env.APIMIGRATE_MANIFESTS ?? path.resolve('manifests');
  const repoDir = process.env.APIMIGRATE_REPO_DIR;

  if (!appId || !privateKey) {
    console.error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required');
    process.exit(1);
  }

  const config: GitHubAppConfig = { appId, privateKey, webhookSecret };
  const app = createServer(config, manifestsDir, { repoDir });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`apimigrate server listening on :${port}`);
    console.log(`manifests dir: ${manifestsDir}`);
    if (repoDir) console.log(`default repo dir: ${repoDir}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
