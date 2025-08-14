import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import type { OutputFile } from 'promptfoo';
import { simpleGit } from 'simple-git';
import {
  ErrorCodes,
  formatErrorMessage,
  PromptfooActionError,
} from './utils/errors';
import { extractFileDependencies } from './utils/config';

const gitInterface = simpleGit();

/**
 * Validates git refs to prevent command injection attacks.
 * This is a critical security function that must be called before using any
 * user-provided input in git commands.
 *
 * Security considerations:
 * - Refs starting with "--" could be interpreted as command options
 * - Spaces could allow command chaining
 * - Special characters could enable various injection attacks
 * - Even with validation, we use "--" separator in git commands for defense in depth
 */
function validateGitRef(ref: string): void {
  // Strict validation: only allow safe characters for git refs
  const gitRefRegex = /^[\w\-/.]+$/; // Allow alphanumerics, underscores, hyphens, slashes, and dots

  // Security check: prevent option injection
  if (ref.startsWith('--') || ref.startsWith('-')) {
    throw new PromptfooActionError(
      `Invalid Git ref "${ref}": refs cannot start with "-" or "--" (this could be interpreted as a command option)`,
      ErrorCodes.INVALID_GIT_REF,
      'Git refs should not start with dashes to prevent command injection',
    );
  }

  // Security check: prevent command chaining
  if (
    ref.includes(' ') ||
    ref.includes('\t') ||
    ref.includes('\n') ||
    ref.includes('\r')
  ) {
    throw new PromptfooActionError(
      `Invalid Git ref "${ref}": refs cannot contain whitespace characters`,
      ErrorCodes.INVALID_GIT_REF,
      'Git refs should not contain spaces or other whitespace',
    );
  }

  // Security check: prevent special shell characters
  const dangerousChars = [
    '$',
    '`',
    '\\',
    '!',
    '&',
    '|',
    ';',
    '(',
    ')',
    '<',
    '>',
    '"',
    "'",
    '*',
    '?',
    '[',
    ']',
    '{',
    '}',
  ];
  for (const char of dangerousChars) {
    if (ref.includes(char)) {
      throw new PromptfooActionError(
        `Invalid Git ref "${ref}": refs cannot contain special character "${char}"`,
        ErrorCodes.INVALID_GIT_REF,
        'Git refs should only contain alphanumerics, underscores, hyphens, slashes, and dots',
      );
    }
  }

  // Final check: ensure ref matches allowed pattern
  if (!gitRefRegex.test(ref)) {
    throw new PromptfooActionError(
      `Invalid Git ref "${ref}": refs can only contain letters, numbers, underscores, hyphens, slashes, and dots`,
      ErrorCodes.INVALID_GIT_REF,
      'Please use a valid git reference format',
    );
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
    const cohereApiKey: string = core.getInput('cohere-api-key', {
      required: false,
    });
    const mistralApiKey: string = core.getInput('mistral-api-key', {
      required: false,
    });
    const groqApiKey: string = core.getInput('groq-api-key', {
      required: false,
    });
    const githubToken: string = core.getInput('github-token', {
      required: true,
    });
    const promptsInput = core.getInput('prompts', { required: false });
    const promptFilesGlobs: string[] = promptsInput
      ? promptsInput.split('\n').filter((line) => line.trim())
      : [];
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
    const failOnThresholdInput: string = core.getInput('fail-on-threshold', {
      required: false,
    });
    const failOnThreshold: number | undefined = failOnThresholdInput
      ? parseFloat(failOnThresholdInput)
      : undefined;
    const maxConcurrencyInput: string = core.getInput('max-concurrency', {
      required: false,
    });
    const maxConcurrency: number | undefined = maxConcurrencyInput
      ? parseInt(maxConcurrencyInput, 10)
      : undefined;
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
    const forceRun: boolean = core.getBooleanInput('force-run', {
      required: false,
    });

    // Validate fail-on-threshold input
    if (
      failOnThreshold !== undefined &&
      (Number.isNaN(failOnThreshold) ||
        failOnThreshold < 0 ||
        failOnThreshold > 100)
    ) {
      throw new PromptfooActionError(
        'fail-on-threshold must be a number between 0 and 100',
        ErrorCodes.INVALID_THRESHOLD,
        'Please provide a valid percentage value, e.g., 80 for 80% success rate',
      );
    }

    // Validate max-concurrency input
    if (
      maxConcurrency !== undefined &&
      (Number.isNaN(maxConcurrency) || maxConcurrency < 1)
    ) {
      throw new PromptfooActionError(
        'max-concurrency must be a positive integer',
        ErrorCodes.INVALID_CONFIGURATION,
        'Please provide a valid concurrency value, e.g., 10 for 10 concurrent requests',
      );
    }

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
            throw new PromptfooActionError(
              `Failed to load ${envFilePath}: ${result.error.message}`,
              ErrorCodes.ENV_FILE_LOAD_ERROR,
              `Check that the file exists and has valid .env format`,
            );
          } else {
            core.info(`Successfully loaded ${envFilePath}`);
          }
        } else {
          throw new PromptfooActionError(
            `Environment file ${envFilePath} not found`,
            ErrorCodes.ENV_FILE_NOT_FOUND,
            `Make sure the file path is correct relative to ${workingDirectory}`,
          );
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
      cohereApiKey,
      mistralApiKey,
      groqApiKey,
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

      await exec.exec('git', ['fetch', '--', 'origin', baseRef]);
      const baseFetchHead = (
        await gitInterface.revparse(['FETCH_HEAD'])
      ).trim();

      await exec.exec('git', ['fetch', '--', 'origin', headRef]);
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
      const compareBase =
        workflowBase || github.context.payload.inputs?.base || 'HEAD~1';

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

    // Extract dependencies from config file
    let dependencyChanged = false;
    if (changedFilesList.length > 0) {
      const dependencies = extractFileDependencies(configPath);
      if (dependencies.length > 0) {
        core.debug(
          `Found ${dependencies.length} file dependencies in config: ${dependencies.join(', ')}`,
        );

        // Check if any changed file matches the dependencies
        dependencyChanged = dependencies.some((dep) => {
          // Direct file match
          if (changedFilesList.includes(dep)) {
            return true;
          }

          // Check if the dependency is a directory and any changed file is within it
          if (
            dep.endsWith('/') ||
            (fs.existsSync(dep) && fs.statSync(dep).isDirectory())
          ) {
            const depDir = dep.endsWith('/') ? dep : `${dep}/`;
            return changedFilesList.some((changedFile) =>
              changedFile.startsWith(depDir),
            );
          }

          return false;
        });

        if (dependencyChanged) {
          core.info('Detected changes in config file dependencies');
        }
      }
    }

    if (
      !forceRun &&
      promptFiles.length < 1 &&
      !configChanged &&
      !dependencyChanged &&
      changedFilesList.length > 0 &&
      promptFilesGlobs.length > 0
    ) {
      // We have changed files info but no prompt files were modified
      // Only skip if prompts were actually specified
      core.info('No LLM prompt, config files, or dependencies were modified.');
      return;
    }

    if (forceRun) {
      core.info('Force run enabled - running evaluation regardless of changes');
    }

    if (changedFilesList.length === 0) {
      core.info(
        `Processing all matching prompt files: ${promptFiles.join(', ')}`,
      );
    }

    const outputFile = path.join(workingDirectory, 'output.json');
    let promptfooArgs = ['eval', '-c', configPath, '-o', outputFile];
    if (!useConfigPrompts && promptFiles.length > 0) {
      promptfooArgs = promptfooArgs.concat(['--prompts', ...promptFiles]);
    }
    // Check if sharing is enabled and authentication is available
    if (!noShare) {
      const hasPromptfooApiKey = process.env.PROMPTFOO_API_KEY || false;
      const hasRemoteConfig =
        process.env.PROMPTFOO_REMOTE_API_BASE_URL || false;

      if (hasPromptfooApiKey || hasRemoteConfig) {
        promptfooArgs.push('--share');
      } else {
        core.info(
          'Sharing is enabled but no authentication found (PROMPTFOO_API_KEY or PROMPTFOO_REMOTE_API_BASE_URL). ' +
            'Skipping share step. To enable sharing, set PROMPTFOO_API_KEY as an environment variable.',
        );
      }
    }
    if (maxConcurrency !== undefined) {
      promptfooArgs.push('--max-concurrency', maxConcurrency.toString());
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
      ...(cohereApiKey ? { COHERE_API_KEY: cohereApiKey } : {}),
      ...(mistralApiKey ? { MISTRAL_API_KEY: mistralApiKey } : {}),
      ...(groqApiKey ? { GROQ_API_KEY: groqApiKey } : {}),
      ...(cachePath ? { PROMPTFOO_CACHE_PATH: cachePath } : {}),
    };
    let errorToThrow: Error | undefined;
    try {
      await exec.exec(`npx promptfoo@${version}`, promptfooArgs, {
        env,
        cwd: workingDirectory,
      });
    } catch (error) {
      // Wrap the error with more context
      errorToThrow = new PromptfooActionError(
        `Promptfoo evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCodes.PROMPTFOO_EXECUTION_FAILED,
        'Check that your promptfoo configuration is valid and all required API keys are set',
      );
    }

    // Read output file
    let output: OutputFile;
    try {
      const outputContent = fs.readFileSync(outputFile, 'utf8');
      output = JSON.parse(outputContent) as OutputFile;
    } catch (error) {
      throw new PromptfooActionError(
        `Failed to read or parse output file: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCodes.INVALID_OUTPUT_FILE,
        'This usually happens when promptfoo fails to generate valid output. Check the logs above for more details',
      );
    }

    // Comment on PR or output results
    if (isPullRequest && pullRequestNumber && !disableComment) {
      const octokit = github.getOctokit(githubToken);
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

    // Check if we should fail based on threshold
    if (failOnThreshold !== undefined) {
      const totalTests =
        output.results.stats.successes + output.results.stats.failures;

      // If no tests were run, fail the threshold check
      if (totalTests === 0) {
        throw new PromptfooActionError(
          `No tests were run - cannot calculate success rate`,
          ErrorCodes.THRESHOLD_NOT_MET,
          `Ensure your configuration includes valid tests to run`,
        );
      }

      const successRate = (output.results.stats.successes / totalTests) * 100;

      if (successRate < failOnThreshold) {
        throw new PromptfooActionError(
          `Evaluation success rate (${successRate.toFixed(
            2,
          )}%) is below the required threshold (${failOnThreshold}%)`,
          ErrorCodes.THRESHOLD_NOT_MET,
          `Consider adjusting your prompts or lowering the threshold`,
        );
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
  core.setFailed(formatErrorMessage(error));
}

if (require.main === module) {
  run();
}
