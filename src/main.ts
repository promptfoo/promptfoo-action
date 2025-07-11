import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import type { OutputFile } from 'promptfoo';
import { simpleGit } from 'simple-git';

const gitInterface = simpleGit();

function validateGitRef(ref: string): void {
  const gitRefRegex = /^[\w\-/.]+$/; // Allow alphanumerics, underscores, hyphens, slashes, and dots
  
  // Provide specific error messages for different validation failures
  if (ref.startsWith('--')) {
    throw new Error(`Invalid Git ref "${ref}": refs cannot start with "--" (this could be interpreted as a command option)`);
  }
  
  if (ref.includes(' ')) {
    throw new Error(`Invalid Git ref "${ref}": refs cannot contain spaces`);
  }
  
  if (!gitRefRegex.test(ref)) {
    throw new Error(`Invalid Git ref "${ref}": refs can only contain letters, numbers, underscores, hyphens, slashes, and dots`);
  }
}

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
    const githubToken: string = core.getInput('github-token', {
      required: true,
    });
    const promptFilesGlobs: string[] = core
      .getInput('prompts', { required: false })
      .split('\n');
    const configPath: string = core.getInput('config', {
      required: true,
    });
    const cachePath: string = core.getInput('cache-path', { required: false });
    const version: string = core.getInput('promptfoo-version', {
      required: false,
    });
    const workingDirectory: string = path.join(
      process.cwd(),
      core.getInput('working-directory', { required: false }),
    );
    const noShare: boolean = core.getBooleanInput('no-share', {
      required: false,
    });
    const useConfigPrompts: boolean = core.getBooleanInput(
      'use-config-prompts',
      { required: false },
    );
    const envFiles: string = core.getInput('env-files', { required: false });
    const noTable: boolean = core.getBooleanInput('no-table', {
      required: false,
    });
    const noProgressBar: boolean = core.getBooleanInput('no-progress-bar', {
      required: false,
    });
    const disableComment: boolean = core.getBooleanInput('disable-comment', {
      required: false,
    });
    const workflowFiles: string = core.getInput('workflow-files', {
      required: false,
    });
    const workflowBase: string = core.getInput('workflow-base', {
      required: false,
    });

    // Load .env files if specified
    if (envFiles) {
      const envFileList = envFiles.split(',').map((f) => f.trim());
      for (const envFile of envFileList) {
        const envFilePath = path.join(workingDirectory, envFile);
        if (fs.existsSync(envFilePath)) {
          core.info(`Loading environment variables from ${envFilePath}`);
          // Use override: true to allow later files to override earlier ones
          const result = dotenv.config({ path: envFilePath, override: true });
          if (result.error) {
            core.warning(
              `Failed to load ${envFilePath}: ${result.error.message}`,
            );
          } else {
            core.info(`Successfully loaded ${envFilePath}`);
          }
        } else {
          core.warning(`Environment file ${envFilePath} not found`);
        }
      }
    }

    const apiKeys = [
      openaiApiKey,
      azureApiKey,
      anthropicApiKey,
      huggingfaceApiKey,
      awsAccessKeyId,
      awsSecretAccessKey,
      replicateApiKey,
      palmApiKey,
      vertexApiKey,
    ];
    for (const key of apiKeys) {
      if (key) {
        core.setSecret(key);
      }
    }
    core.setSecret(githubToken);

    const event = github.context.eventName;
    let changedFiles = '';
    let baseRef: string | undefined;
    let headRef: string | undefined;
    let isPullRequest = false;
    let pullRequestNumber: number | undefined;

    // Handle different event types
    if (event === 'pull_request' || event === 'pull_request_target') {
      const pullRequest = github.context.payload.pull_request;
      if (!pullRequest) {
        throw new Error('No pull request found in context.');
      }
      isPullRequest = true;
      pullRequestNumber = pullRequest.number;

      // Get list of changed files in PR
      baseRef = pullRequest.base.ref;
      headRef = pullRequest.head.ref;

      if (!baseRef || !headRef) {
        throw new Error(
          'Unable to determine base or head references from pull request',
        );
      }

      // Validate baseRef and headRef to prevent command injection
      validateGitRef(baseRef);
      validateGitRef(headRef);

      await exec.exec('git', ['fetch', 'origin', baseRef]);
      const baseFetchHead = (
        await gitInterface.revparse(['FETCH_HEAD'])
      ).trim();

      await exec.exec('git', ['fetch', 'origin', headRef]);
      const headFetchHead = (
        await gitInterface.revparse(['FETCH_HEAD'])
      ).trim();

      changedFiles = await gitInterface.diff([
        '--name-only',
        baseFetchHead,
        headFetchHead,
      ]);
    } else if (event === 'workflow_dispatch') {
      core.info('Running in workflow_dispatch mode');

      // For workflow_dispatch, we can either:
      // 1. Accept a list of files as input
      // 2. Compare against a base branch/commit
      // 3. Run on all prompt files

      // Priority: action inputs > workflow inputs > defaults
      const filesInput = workflowFiles || github.context.payload.inputs?.files;
      const compareBase = workflowBase || github.context.payload.inputs?.base || 'HEAD~1';

      if (filesInput) {
        // Option 1: Use provided file list
        changedFiles = filesInput;
        core.info(`Using manually specified files: ${changedFiles}`);
      } else {
        // Option 2: Compare against base (default to previous commit)
        try {
          // Validate compareBase to prevent command injection
          validateGitRef(compareBase);

          changedFiles = await gitInterface.diff([
            '--name-only',
            compareBase,
            'HEAD',
          ]);
          core.info(
            `Comparing against ${compareBase}, found changed files: ${changedFiles}`,
          );
        } catch (error) {
          // Option 3: If comparison fails, we'll process all matching prompt files
          core.warning(
            `Could not compare against ${compareBase}: ${error}. Will process all matching prompt files.`,
          );
          changedFiles = '';
        }
      }
    } else if (event === 'push') {
      core.info('Running in push mode');

      // For push events, compare the before and after commits
      const beforeSha = github.context.payload.before;
      const afterSha = github.context.payload.after || github.context.sha;

      if (
        beforeSha &&
        afterSha &&
        beforeSha !== '0000000000000000000000000000000000000000'
      ) {
        try {
          changedFiles = await gitInterface.diff([
            '--name-only',
            beforeSha,
            afterSha,
          ]);
          core.info(
            `Comparing ${beforeSha}..${afterSha}, found changed files: ${changedFiles}`,
          );
        } catch (error) {
          core.warning(
            `Could not compare commits: ${error}. Will process all matching prompt files.`,
          );
          changedFiles = '';
        }
      } else {
        // First commit or unable to get before SHA
        core.info(
          'Unable to determine changed files from push event. Will process all matching prompt files.',
        );
        changedFiles = '';
      }
    } else {
      core.warning(
        `This action is designed to run on pull request, push, or workflow_dispatch events, but a "${event}" event was received. Will process all matching prompt files.`,
      );
    }

    // Resolve glob patterns to file paths
    const promptFiles: string[] = [];
    const changedFilesList = changedFiles.split('\n').filter((f) => f);

    for (const globPattern of promptFilesGlobs) {
      const matches = glob.sync(globPattern);

      if (changedFilesList.length > 0) {
        // Filter to only changed files
        const changedMatches = matches.filter(
          (file) => file !== configPath && changedFilesList.includes(file),
        );
        promptFiles.push(...changedMatches);
      } else {
        // No changed files info available, include all matches
        const allMatches = matches.filter((file) => file !== configPath);
        promptFiles.push(...allMatches);
      }
    }

    const configChanged =
      changedFilesList.length > 0 && changedFilesList.includes(configPath);

    if (
      promptFiles.length < 1 &&
      !configChanged &&
      changedFilesList.length > 0
    ) {
      // We have changed files info but no prompt files were modified
      core.info('No LLM prompt or config files were modified.');
      return;
    }

    if (changedFilesList.length === 0) {
      core.info(
        `Processing all matching prompt files: ${promptFiles.join(', ')}`,
      );
    }

    const outputFile = path.join(workingDirectory, 'output.json');
    let promptfooArgs = ['eval', '-c', configPath, '-o', outputFile];
    if (!useConfigPrompts) {
      promptfooArgs = promptfooArgs.concat(['--prompts', ...promptFiles]);
    }
    if (!noShare) {
      promptfooArgs.push('--share');
    }
    if (noTable) {
      promptfooArgs.push('--no-table');
    }
    if (noProgressBar) {
      promptfooArgs.push('--no-progress-bar');
    }

    const env = {
      ...process.env,
      ...(openaiApiKey ? { OPENAI_API_KEY: openaiApiKey } : {}),
      ...(azureApiKey ? { AZURE_OPENAI_API_KEY: azureApiKey } : {}),
      ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
      ...(huggingfaceApiKey ? { HF_API_TOKEN: huggingfaceApiKey } : {}),
      ...(awsAccessKeyId ? { AWS_ACCESS_KEY_ID: awsAccessKeyId } : {}),
      ...(awsSecretAccessKey
        ? { AWS_SECRET_ACCESS_KEY: awsSecretAccessKey }
        : {}),
      ...(replicateApiKey ? { REPLICATE_API_KEY: replicateApiKey } : {}),
      ...(palmApiKey ? { PALM_API_KEY: palmApiKey } : {}),
      ...(vertexApiKey ? { VERTEX_API_KEY: vertexApiKey } : {}),
      ...(cachePath ? { PROMPTFOO_CACHE_PATH: cachePath } : {}),
    };
    let errorToThrow: Error | undefined;
    try {
      await exec.exec(`npx promptfoo@${version}`, promptfooArgs, {
        env,
        cwd: workingDirectory,
      });
    } catch (error) {
      // Ignore nonzero exit code, but save the error to throw later
      errorToThrow = error as Error;
    }

    // Comment on PR or output results
    if (isPullRequest && pullRequestNumber && !disableComment) {
      // Existing PR comment logic
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
        body = body.concat('**» View eval results in CI console «**');
      }
      await octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: pullRequestNumber,
        body,
      });
    } else if (!isPullRequest) {
      // For non-PR workflows, output results to workflow summary
      const output = JSON.parse(
        fs.readFileSync(outputFile, 'utf8'),
      ) as OutputFile;

      const summary = core.summary
        .addHeading('Promptfoo Evaluation Results')
        .addTable([
          [
            { data: 'Metric', header: true },
            { data: 'Count', header: true },
          ],
          ['Success', output.results.stats.successes.toString()],
          ['Failure', output.results.stats.failures.toString()],
        ]);

      if (promptFiles.length > 0) {
        summary.addHeading('Evaluated Files', 3);
        summary.addList(promptFiles);
      }

      if (output.shareableUrl) {
        summary.addLink('View detailed results', output.shareableUrl);
      } else {
        summary.addRaw('View eval results in CI console');
      }

      await summary.write();

      // Also output to console
      core.info('=== Promptfoo Evaluation Results ===');
      core.info(`Success: ${output.results.stats.successes}`);
      core.info(`Failure: ${output.results.stats.failures}`);
      if (output.shareableUrl) {
        core.info(`View results: ${output.shareableUrl}`);
      }
    }

    if (errorToThrow) {
      throw errorToThrow;
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
