import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import {simpleGit} from 'simple-git';

import type {OutputFile} from 'promptfoo';

const gitInterface = simpleGit();

export async function run(): Promise<void> {
  try {
    const openaiApiKey: string = core.getInput('openai-api-key', {
      required: false,
    });
    const azureApiKey: string = core.getInput('azure-api-key', {
      required: false,
    });
    const anthropicApiKey: string = core.getInput('anthropic-api-key', {
      required: false,
    });
    const huggingfaceApiKey: string = core.getInput('huggingface-api-key', {
      required: false,
    });
    const awsAccessKeyId: string = core.getInput('aws-access-key-id', {
      required: false,
    });
    const awsSecretAccessKey: string = core.getInput('aws-secret-access-key', {
      required: false,
    });
    const replicateApiKey: string = core.getInput('replicate-api-key', {
      required: false,
    });
    const palmApiKey: string = core.getInput('palm-api-key', {
      required: false,
    });
    const vertexApiKey: string = core.getInput('vertex-api-key', {
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
    const version: string = core.getInput('promptfoo-version', {
      required: false,
    });
    const noShare: boolean = core.getBooleanInput('no-share', {
      required: false,
    });

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
      ];
      if (!noShare) {
        promptfooArgs.push('--share');
      }

      const env = {
        ...process.env,
        ...(openaiApiKey ? {OPENAI_API_KEY: openaiApiKey} : {}),
        ...(azureApiKey ? {AZURE_OPENAI_API_KEY: azureApiKey} : {}),
        ...(anthropicApiKey ? {ANTHROPIC_API_KEY: anthropicApiKey} : {}),
        ...(huggingfaceApiKey ? {HF_API_TOKEN: huggingfaceApiKey} : {}),
        ...(awsAccessKeyId ? {AWS_ACCESS_KEY_ID: awsAccessKeyId} : {}),
        ...(awsSecretAccessKey
          ? {AWS_SECRET_ACCESS_KEY: awsSecretAccessKey}
          : {}),
        ...(replicateApiKey ? {REPLICATE_API_KEY: replicateApiKey} : {}),
        ...(palmApiKey ? {PALM_API_KEY: palmApiKey} : {}),
        ...(vertexApiKey ? {VERTEX_API_KEY: vertexApiKey} : {}),
        ...(cachePath ? {PROMPTFOO_CACHE_PATH: cachePath} : {}),
      };
      await exec.exec(`npx promptfoo@${version}`, promptfooArgs, {env});

      // Comment PR
      const octokit = github.getOctokit(githubToken);
      const output = JSON.parse(
        fs.readFileSync(outputFile, 'utf8'),
      ) as OutputFile;
      const modifiedFiles = promptFiles.join(', ');
      let body = `⚠️ LLM prompt was modified in these files: ${modifiedFiles}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${output.results.stats.failures}       |

`;
      if (output.shareableUrl) {
        body = body.concat(
          `**» [View eval results](${output.shareableUrl}) «**`,
        );
      } else {
        body = body.concat('**» View eval results in CI console«**');
      }
      await octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: pullRequest.number,
        body,
      });
    } else {
      core.info('No LLM prompt files were modified.');
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
