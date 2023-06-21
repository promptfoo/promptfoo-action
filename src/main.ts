// src/main.ts
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import {simpleGit} from 'simple-git';

const gitInterface = simpleGit();

async function run(): Promise<void> {
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
    const changedFiles = await gitInterface.diff([
      '--name-only',
      pullRequest.base.ref,
      pullRequest.head.ref,
    ]);

    // Resolve glob patterns to file paths
    const promptFiles: string[] = [];
    for (const globPattern of promptFilesGlobs) {
      const matches = glob.sync(globPattern);
      const changedMatches = matches.filter(file =>
        changedFiles.includes(file),
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
      await exec.exec('npx promptfoo', promptfooArgs, {
        env: {
          ...process.env,
          OPENAI_API_KEY: openaiApiKey,
          PROMPTFOO_CACHE_PATH: cachePath,
        },
      });

      // Comment PR
      const octokit = github.getOctokit(githubToken);
      const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      const body = `⚠️ LLM prompt was modified.

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${output.results.stats.failures}       |

**» [View eval results](${output.shareableUrl}) «**`;
      await octokit.rest.issues.createComment({
        issue_number: github.context.issue.number,
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        body,
      });
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

run();
