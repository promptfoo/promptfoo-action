import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import {simpleGit} from 'simple-git';

const gitInterface = simpleGit();

export async function run(): Promise<void> {
  try {
    const openaiApiKey: string = core.getInput('openai-api-key', {
      required: false,
    });
    const githubToken: string = core.getInput('github-token', {required: true});
    const promptFilesGlobs: string[] = core
      .getInput('prompts', {required: true})
      .split('\n');
    const configPath: string = core.getInput('config', {
      required: true,
    });
    const cachePath: string = core.getInput('cache-path', {required: false});

    core.setSecret(openaiApiKey);
    core.setSecret(githubToken);

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('No pull request found.');
    }

    // Get list of changed files in PR
    const baseRef = pullRequest.base.ref;
    const headRef = pullRequest.head.ref;

    await exec.exec('git', ['fetch', 'origin', baseRef]);
    const baseFetchHead = (await gitInterface.revparse(['FETCH_HEAD'])).trim();

    await exec.exec('git', ['fetch', 'origin', headRef]);
    const headFetchHead = (await gitInterface.revparse(['FETCH_HEAD'])).trim();

    const changedFiles = await gitInterface.diff([
      '--name-only',
      baseFetchHead,
      headFetchHead,
    ]);

    // Resolve glob patterns to file paths
    const promptFiles: string[] = [];
    for (const globPattern of promptFilesGlobs) {
      const matches = glob.sync(globPattern);
      const changedMatches = matches.filter(
        file => file !== configPath && changedFiles.includes(file),
      );
      promptFiles.push(...changedMatches);
    }

    // Run promptfoo evaluation only for changed files
    if (promptFiles.length > 0) {
      const outputFile = path.join(process.cwd(), 'output.json');
      const promptfooArgs = [
        'eval',
        '-c',
        configPath,
        '--prompts',
        ...promptFiles,
        '-o',
        outputFile,
        '--share',
      ];
      const env = {
        ...process.env,
        ...(openaiApiKey ? {OPENAI_API_KEY: openaiApiKey} : {}),
        ...(cachePath ? {PROMPTFOO_CACHE_PATH: cachePath} : {}),
      };
      await exec.exec('npx promptfoo', promptfooArgs, {env});

      // Comment PR
      const octokit = github.getOctokit(githubToken);
      const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      const modifiedFiles = promptFiles.join(', ');
      const body = `⚠️ LLM prompt was modified in these files: ${modifiedFiles}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${output.results.stats.failures}       |

**» [View eval results](${output.shareableUrl}) «**`;
      await octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: pullRequest.number,
        body,
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      handleError(error);
    } else {
      handleError(new Error(String(error)));
    }
  }
}

export function handleError(error: Error): void {
  core.setFailed(error.message);
}

if (require.main === module) {
  run();
}
