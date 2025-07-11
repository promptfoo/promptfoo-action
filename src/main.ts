import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import type { OutputFile } from 'promptfoo';
import { simpleGit } from 'simple-git';
import { processApiKeys, API_KEY_CONFIGS } from './utils/security';

const gitInterface = simpleGit();

function validateGitRef(ref: string): void {
  const gitRefRegex = /^[\w\-/.]+$/; // Allow alphanumerics, underscores, hyphens, slashes, and dots
  // Reject refs starting with "--" to prevent malicious options
  if (ref.startsWith('--') || !gitRefRegex.test(ref)) {
    throw new Error(`Invalid Git ref: ${ref}`);
  }
}

export async function run(): Promise<void> {
  try {
    // Collect all API key inputs
    const apiKeyInputs: Record<string, string> = {};
    for (const config of Object.values(API_KEY_CONFIGS)) {
      const value = core.getInput(config.inputName, { required: false });
      if (value) {
        apiKeyInputs[config.inputName] = value;
      }
    }

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

    // Process and validate all API keys
    const secureApiKeys = processApiKeys(apiKeyInputs);
    
    // Mask GitHub token
    core.setSecret(githubToken);
    
    // Log security audit summary
    const configuredProviders = Object.keys(secureApiKeys)
      .map(envVar => {
        const config = Object.values(API_KEY_CONFIGS).find(c => c.envVarName === envVar);
        return config?.inputName || envVar;
      });
    if (configuredProviders.length > 0) {
      core.info(`Configured API keys for: ${configuredProviders.join(', ')}`);
    }

    const event = github.context.eventName;
    if (event !== 'pull_request') {
      core.warning(
        `This action is designed to run on pull request events only, but a "${event}" event was received.`,
      );
    }

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('No pull request found.');
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

    const env = {
      ...process.env,
      ...secureApiKeys,
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
      body = body.concat(`**» [View eval results](${output.shareableUrl}) «**`);
    } else {
      body = body.concat('**» View eval results in CI console «**');
    }
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: pullRequest.number,
      body,
    });

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
