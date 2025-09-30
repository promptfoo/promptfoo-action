const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const branch = context.payload.pull_request.head.ref;
  const distDir = path.join(process.cwd(), 'dist');
  const files = fs.readdirSync(distDir);
  let hasChanges = false;

  for (const file of files) {
    const repoPath = `dist/${file}`;
    const content = fs.readFileSync(path.join(distDir, file), {
      encoding: 'base64',
    });
    let sha = undefined;
    let existingContent = undefined;

    try {
      const { data } = await github.rest.repos.getContent({
        owner,
        repo,
        path: repoPath,
        ref: branch,
      });
      if (!Array.isArray(data)) {
        sha = data.sha;
        existingContent = data.content;
      }
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    if (existingContent !== content) {
      hasChanges = true;
      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: repoPath,
        message: 'chore(dist): rebuild for dependabot update',
        content,
        branch,
        sha,
      });
    }
  }

  if (!hasChanges) {
    console.log('No changes detected in dist files, skipping commit');
  }
};