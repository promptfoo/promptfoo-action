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
  PromptfooActionError,
  formatErrorMessage,
} from './utils/errors';

const gitInterface = simpleGit();

function validateGitRef(ref: string): void {
  const gitRefRegex = /^[\w\-/.]+$/; // Allow alphanumerics, underscores, hyphens, slashes, and dots
  // Reject refs starting with "--" to prevent malicious options
  if (ref.startsWith('--') || !gitRefRegex.test(ref)) {
    throw new PromptfooActionError(
      `Invalid Git ref: ${ref}`,
      ErrorCodes.INVALID_GIT_REF,
      'Git refs should only contain alphanumerics, underscores, hyphens, slashes, and dots',
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

    // Validate fail-on-threshold input
    if (
      failOnThreshold !== undefined &&
      (Number.isNaN(failOnThreshold) || failOnThreshold < 0 || failOnThreshold > 100)
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
    if (event !== 'pull_request') {
      core.warning(
        `This action is designed to run on pull request events only, but a "${event}" event was received.`,
      );
    }

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new PromptfooActionError(
        'No pull request found',
        ErrorCodes.NO_PULL_REQUEST,
        'This action must be run in the context of a pull request event',
      );
    }

    // Get list of changed files in PR
    const baseRef = pullRequest.base.ref;
    const headRef = pullRequest.head.ref;

    // Validate baseRef and headRef to prevent command injection
    validateGitRef(baseRef);
    validateGitRef(headRef);

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
        (file) => file !== configPath && changedFiles.includes(file),
      );
      promptFiles.push(...changedMatches);
    }

    const configChanged = changedFiles.includes(configPath);
    if (promptFiles.length < 1 && !configChanged) {
      // Run promptfoo evaluation only when files change.
      core.info('No LLM prompt or config files were modified.');
      return;
    }

    const outputFile = path.join(workingDirectory, 'output.json');
    let promptfooArgs = ['eval', '-c', configPath, '-o', outputFile];
    if (!useConfigPrompts) {
      promptfooArgs = promptfooArgs.concat(['--prompts', ...promptFiles]);
    }
    if (!noShare) {
      promptfooArgs.push('--share');
    }
    if (maxConcurrency !== undefined) {
      promptfooArgs.push('--max-concurrency', maxConcurrency.toString());
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

    // Comment PR
    const octokit = github.getOctokit(githubToken);
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
    const modifiedFiles = promptFiles.join(', ');
    let body = `⚠️ LLM prompt was modified in these files: ${modifiedFiles}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${output.results.stats.failures}       |

`;
    if (output.shareableUrl) {
      body = body.concat(`**» [View eval results](${output.shareableUrl}) «**`);
    } else {
      body = body.concat('**» View eval results in CI console «**');
    }
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: pullRequest.number,
      body,
    });

    // Check if we should fail based on threshold
    if (failOnThreshold !== undefined) {
      const successRate =
        (output.results.stats.successes /
          (output.results.stats.successes + output.results.stats.failures)) *
        100;
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
