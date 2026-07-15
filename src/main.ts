import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import type { EvaluateResult, OutputFile } from 'promptfoo';
import { simpleGit } from 'simple-git';
import { getApiHost, validatePromptfooApiKey } from './utils/auth';
import {
  cleanupOldCache,
  createCacheManifest,
  logCacheMetrics,
  setupCacheEnvironment,
} from './utils/cache';
import { extractFileDependencies } from './utils/config';
import { loadConfigEnvironmentFiles, loadEnvironmentFile } from './utils/env';
import {
  ErrorCodes,
  formatErrorMessage,
  PromptfooActionError,
} from './utils/errors';
import { isDirectory } from './utils/fs';
import {
  parseOptionalPercentage,
  parseOptionalPositiveInt,
} from './utils/inputs';
import {
  evaluateRepeatThreshold,
  formatRepeatCommentMarkdown,
  formatRepeatFailureMessage,
} from './utils/thresholds';

const gitInterface = simpleGit();
const GITHUB_PULL_REQUEST_FILES_LIMIT = 3000;
const MAX_PROMPT_GLOB_LENGTH = 64 * 1024;
const PROMPT_GLOB_BRACE_EXPANSION_LIMIT = 1024;

function validatePromptGlob(pattern: string): void {
  const invalidGlob = (): never => {
    throw new PromptfooActionError(
      'Invalid prompt glob: the pattern could not be expanded safely.',
      ErrorCodes.INVALID_CONFIGURATION,
      'Use valid prompt glob patterns with bounded brace expansion.',
    );
  };

  const hasControlCharacter = [...pattern].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (pattern.length > MAX_PROMPT_GLOB_LENGTH || hasControlCharacter) {
    invalidGlob();
  }

  let braceStart = -1;
  let escapedBraceClosers = 0;
  let inCharacterClass = false;
  let braceExpansions = 1;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (path.sep === '/' && character === '\\') {
      if (index + 1 >= pattern.length) {
        invalidGlob();
      }
      if (pattern[index + 1] === '{') {
        escapedBraceClosers++;
      }
      index++;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (inCharacterClass && character === ']') {
      inCharacterClass = false;
      continue;
    }
    if (character === '{') {
      if (braceStart !== -1) {
        invalidGlob();
      }
      braceStart = index;
      continue;
    }
    if (character !== '}') {
      continue;
    }
    if (braceStart === -1) {
      if (escapedBraceClosers > 0) {
        escapedBraceClosers--;
        continue;
      }
      invalidGlob();
    }

    const group = pattern.slice(braceStart + 1, index);
    const range = group.split('..');
    let expansionCount = group.split(',').length;
    const hasNumericRange =
      range.length > 1 && range.some((entry) => /^-?\d/.test(entry));
    if (
      hasNumericRange &&
      !(
        (range.length === 2 || range.length === 3) &&
        range.every((entry) => /^-?\d+$/.test(entry))
      )
    ) {
      invalidGlob();
    }
    if (
      (range.length === 2 || range.length === 3) &&
      range.every((entry) => /^-?\d+$/.test(entry))
    ) {
      const values = range.map(Number);
      const [start, end, rawStep = 1] = values;
      if (
        values.some((value) => !Number.isSafeInteger(value)) ||
        rawStep === 0 ||
        !Number.isSafeInteger(end - start)
      ) {
        invalidGlob();
      }
      expansionCount =
        Math.floor(Math.abs(end - start) / Math.abs(rawStep)) + 1;
      const endpointWidth = Math.max(range[0].length, range[1].length);
      if (expansionCount * endpointWidth > MAX_PROMPT_GLOB_LENGTH) {
        invalidGlob();
      }
    }
    braceExpansions *= expansionCount;
    if (braceExpansions > PROMPT_GLOB_BRACE_EXPANSION_LIMIT) {
      invalidGlob();
    }
    braceStart = -1;
  }

  if (braceStart !== -1 || escapedBraceClosers > 0 || inCharacterClass) {
    invalidGlob();
  }
}

function toRepositoryPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function validatePromptPath(
  workspaceRoot: string,
  workingDirectory: string,
  filePath: string,
): string {
  const resolvedPath = path.resolve(workingDirectory, filePath);
  try {
    if (
      !isPathInside(workspaceRoot, resolvedPath) ||
      !isPathInside(workingDirectory, resolvedPath)
    ) {
      throw new Error('Prompt path escapes the workspace');
    }
    const realWorkspaceRoot = path.resolve(
      fs.realpathSync(workspaceRoot).toString(),
    );
    const realWorkingDirectory = path.resolve(
      fs.realpathSync(workingDirectory).toString(),
    );
    const realPath = path.resolve(fs.realpathSync(resolvedPath).toString());
    if (
      !isPathInside(realWorkspaceRoot, realPath) ||
      !isPathInside(realWorkingDirectory, realPath)
    ) {
      throw new Error('Prompt path escapes the workspace');
    }
    return resolvedPath;
  } catch {
    throw new PromptfooActionError(
      'Invalid prompt file path: prompt files must stay within the working directory.',
      ErrorCodes.INVALID_CONFIGURATION,
      'Use readable prompt files and glob patterns contained within the working directory.',
    );
  }
}

function formatChangedFilesForLog(changedFiles: string): string {
  return JSON.stringify(
    changedFiles
      .split(changedFiles.includes('\0') ? '\0' : '\n')
      .filter(Boolean),
  );
}

/**
 * Conservatively validates user-controlled git revisions before passing them to
 * git. This action accepts only the revision forms it documents for manual
 * workflow dispatch comparisons.
 */
function validateGitRevision(ref: string): void {
  const safeBranchOrTag =
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.includes('@{') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock');
  const safeHeadRevision = /^HEAD(?:~[1-9][0-9]*|\^[1-9]?)?$/.test(ref);
  const safeCommitSha = /^[0-9a-f]{40}$/i.test(ref);

  if (!safeBranchOrTag && !safeHeadRevision && !safeCommitSha) {
    throw new PromptfooActionError(
      `Invalid Git revision "${ref}"`,
      ErrorCodes.INVALID_GIT_REF,
      'Use a branch/tag name, a 40-character commit SHA, HEAD, HEAD~N, or HEAD^N',
    );
  }
}

function validateCommitSha(sha: string, name: string): void {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new PromptfooActionError(
      `Invalid ${name} "${sha}": expected a 40-character commit SHA`,
      ErrorCodes.INVALID_GIT_REF,
      'GitHub push payload commits must be full hexadecimal SHAs',
    );
  }
}

function validatePromptfooVersion(version: string): void {
  if (
    version.length > 128 ||
    version.startsWith('-') ||
    !/^[A-Za-z0-9._~^*+-]+$/.test(version)
  ) {
    throw new PromptfooActionError(
      `Invalid promptfoo-version "${version}"`,
      ErrorCodes.INVALID_CONFIGURATION,
      'Use a safe npm version or dist-tag such as "latest", "0.121.12", or "^0.121.0"',
    );
  }
}

const RESERVED_EXIT_CODES = new Set([0, 1, 2, 130]);

function normalizeFailedTestExitCode(raw: string | undefined): {
  value: number;
  warning?: string;
} {
  if (!raw) {
    return { value: 100 };
  }

  const parsed = Number.parseInt(raw, 10);
  const isValid =
    Number.isInteger(parsed) &&
    parsed >= 3 &&
    parsed <= 255 &&
    !RESERVED_EXIT_CODES.has(parsed);

  if (isValid) {
    return { value: parsed };
  }

  return {
    value: 100,
    warning: `PROMPTFOO_FAILED_TEST_EXIT_CODE=${raw} is reserved or invalid. Using default (100).`,
  };
}

function parsePromptfooPassRateThreshold(
  raw: string | undefined,
  isConfigured: boolean,
): number | undefined {
  if (!isConfigured) {
    return undefined;
  }

  const parsed = Number.parseFloat(raw || '');
  if (Number.isNaN(parsed)) {
    return 100;
  }

  return Number.isFinite(parsed) ? parsed : 100;
}

function calculateSuccessRate(stats: {
  successes: number;
  failures: number;
  errors?: number;
}): number | undefined {
  const total = stats.successes + stats.failures + (stats.errors ?? 0);

  if (total === 0) {
    return undefined;
  }

  return (stats.successes / total) * 100;
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
    const maskApiKeys = (
      environment: NodeJS.ProcessEnv = process.env,
    ): void => {
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
      for (const [name, value] of Object.entries(environment)) {
        if (
          value &&
          (/(?:API_?KEY|API_TOKEN|_(?:TOKEN|SECRET|PASSWORD|(?:PUBLIC|SECRET|PRIVATE)_KEY|ACCESS_KEY(?:_ID)?|SECRET_ACCESS_KEY))$/i.test(
            name,
          ) ||
            /(?:^|_)BEARER_TOKEN(?:_|$)/i.test(name) ||
            name.toUpperCase() === 'FAL_KEY' ||
            name.toUpperCase() === 'ABLIT_KEY')
        ) {
          apiKeys.push(value);
        }
      }
      for (const key of apiKeys) {
        if (key) {
          core.setSecret(key);
        }
      }
    };
    maskApiKeys();

    const githubToken: string = core.getInput('github-token', {
      required: true,
    });
    const promptsInput = core.getInput('prompts', {
      required: false,
      trimWhitespace: false,
    });
    const promptFilesGlobs: string[] = promptsInput
      ? promptsInput.split(/\r?\n/).filter((line) => line.trim())
      : [];
    const configPath: string = core.getInput('config', {
      required: true,
    });
    const cachePath: string = core.getInput('cache-path', { required: false });
    const version: string =
      core.getInput('promptfoo-version', { required: false }) || 'latest';
    validatePromptfooVersion(version);
    const workspaceRoot = process.cwd();
    const workingDirectory = path.resolve(
      path.join(
        workspaceRoot,
        core.getInput('working-directory', { required: false }) || '.',
      ),
    );
    const configAbsolutePath = path.resolve(workingDirectory, configPath);
    const configRepositoryPath = toRepositoryPath(
      path.relative(workspaceRoot, configAbsolutePath),
    );
    const noShare: boolean = core.getBooleanInput('no-share', {
      required: false,
    });
    const useConfigPrompts: boolean = core.getBooleanInput(
      'use-config-prompts',
      { required: false },
    );
    const envFiles: string = core.getInput('env-files', {
      required: false,
      trimWhitespace: false,
    });
    const failOnThreshold = parseOptionalPercentage(
      core.getInput('fail-on-threshold', { required: false }),
      'fail-on-threshold',
    );
    const maxConcurrency = parseOptionalPositiveInt(
      core.getInput('max-concurrency', { required: false }),
      'max-concurrency',
    );
    const noTable: boolean = core.getBooleanInput('no-table', {
      required: false,
    });
    const noProgressBar: boolean = core.getBooleanInput('no-progress-bar', {
      required: false,
    });
    const noCache: boolean = core.getBooleanInput('no-cache', {
      required: false,
    });
    const disableComment: boolean = core.getBooleanInput('disable-comment', {
      required: false,
    });
    const workflowFiles: string = core.getInput('workflow-files', {
      required: false,
      trimWhitespace: false,
    });
    const workflowBase: string = core.getInput('workflow-base', {
      required: false,
    });
    const forceRun: boolean = core.getBooleanInput('force-run', {
      required: false,
    });
    const repeat = parseOptionalPositiveInt(
      core.getInput('repeat', { required: false }),
      'repeat',
    );
    const repeatMinPass = parseOptionalPositiveInt(
      core.getInput('repeat-min-pass', { required: false }),
      'repeat-min-pass',
    );

    // Cross-field validation for repeat inputs
    if (repeat !== undefined && repeat < 2) {
      throw new PromptfooActionError(
        'repeat must be at least 2 (omit it to run tests once)',
        ErrorCodes.INVALID_CONFIGURATION,
        'Provide a value like 3 to run each test 3 times',
      );
    }
    if (repeatMinPass !== undefined) {
      if (repeat === undefined) {
        throw new PromptfooActionError(
          'repeat-min-pass requires repeat to be set (e.g., repeat: 3)',
          ErrorCodes.INVALID_CONFIGURATION,
          'Set repeat to the number of times each test should run',
        );
      }
      if (repeatMinPass > repeat) {
        throw new PromptfooActionError(
          `repeat-min-pass (${repeatMinPass}) cannot exceed repeat (${repeat})`,
          ErrorCodes.INVALID_CONFIGURATION,
          `Set repeat-min-pass to at most ${repeat}`,
        );
      }
    }

    const loadEnvironmentFiles = (): void => {
      const validateEnvFilePath = (envFilePath: string): void => {
        if (/[\0\r\n]/.test(envFilePath)) {
          throw new PromptfooActionError(
            'Invalid environment file path: control characters are not allowed.',
            ErrorCodes.INVALID_CONFIGURATION,
            'Choose an environment file path without NUL, CR, or LF characters.',
          );
        }
      };
      const resolveContainedEnvFile = (envFilePath: string): string => {
        validateEnvFilePath(envFilePath);
        const resolvedPath = path.resolve(envFilePath);
        const relativePath = path.relative(workingDirectory, resolvedPath);
        if (
          relativePath === '..' ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)
        ) {
          throw new PromptfooActionError(
            `Environment file ${envFilePath} must stay within the working directory`,
            ErrorCodes.INVALID_CONFIGURATION,
            `Choose an environment file within ${workingDirectory}`,
          );
        }

        if (!fs.existsSync(resolvedPath)) {
          return resolvedPath;
        }

        const realWorkingDirectory = path.resolve(
          fs.realpathSync(workingDirectory).toString(),
        );
        const realPath = path.resolve(fs.realpathSync(resolvedPath).toString());
        const realRelativePath = path.relative(realWorkingDirectory, realPath);
        if (
          realRelativePath === '..' ||
          realRelativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(realRelativePath)
        ) {
          throw new PromptfooActionError(
            `Environment file ${envFilePath} must stay within the working directory`,
            ErrorCodes.INVALID_CONFIGURATION,
            `Choose an environment file within ${workingDirectory}`,
          );
        }

        return resolvedPath;
      };

      // Promptfoo also loads workingDirectory/.env implicitly during startup.
      // Validate it first so selected env-files can still override application
      // values while no repository-controlled process setting reaches the child.
      const implicitEnvFilePath = path.join(workingDirectory, '.env');
      const implicitVaultFilePath = `${implicitEnvFilePath}.vault`;
      const implicitEnvExists = fs.existsSync(implicitEnvFilePath);
      const implicitVaultExists =
        process.env.DOTENV_KEY && fs.existsSync(implicitVaultFilePath);
      const implicitFilePath = resolveContainedEnvFile(
        implicitVaultExists ? implicitVaultFilePath : implicitEnvFilePath,
      );
      const explicitEnvFiles = envFiles
        .split(',')
        .map((envFile) => {
          validateEnvFilePath(envFile);
          return envFile.trim();
        })
        .filter(Boolean)
        .map((envFile) =>
          resolveContainedEnvFile(path.join(workingDirectory, envFile)),
        )
        .map((envFilePath) => {
          resolveContainedEnvFile(envFilePath);
          const vaultPath = envFilePath.endsWith('.vault')
            ? envFilePath
            : `${envFilePath}.vault`;
          const effectivePath =
            process.env.DOTENV_KEY && fs.existsSync(vaultPath)
              ? vaultPath
              : envFilePath;
          return resolveContainedEnvFile(effectivePath);
        });
      const implicitFileIsExplicit =
        explicitEnvFiles.includes(implicitFilePath);
      if (
        (implicitEnvExists || implicitVaultExists) &&
        !implicitFileIsExplicit
      ) {
        core.info(`Loading environment variables from ${implicitFilePath}`);
        loadEnvironmentFile(
          resolveContainedEnvFile(implicitFilePath),
          process.env,
          false,
        );
        maskApiKeys();
        core.info(`Successfully loaded ${implicitFilePath}`);
      }

      // Load explicitly selected .env files after the implicit default.
      if (explicitEnvFiles.length > 0) {
        for (const envFilePath of explicitEnvFiles) {
          if (fs.existsSync(envFilePath)) {
            core.info(`Loading environment variables from ${envFilePath}`);
            loadEnvironmentFile(resolveContainedEnvFile(envFilePath));
            maskApiKeys();
            core.info(`Successfully loaded ${envFilePath}`);
          } else {
            throw new PromptfooActionError(
              `Environment file ${envFilePath} not found`,
              ErrorCodes.ENV_FILE_NOT_FOUND,
              `Make sure the environment file exists within ${workingDirectory}`,
            );
          }
        }
      }
    };

    core.setSecret(githubToken);
    const octokit = github.getOctokit(githubToken);

    const event = github.context.eventName;
    let changedFiles = '';
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

      const pullRequestFiles = await octokit.paginate(
        octokit.rest.pulls.listFiles,
        {
          ...github.context.repo,
          pull_number: pullRequestNumber,
          per_page: 100,
        },
      );
      if (pullRequestFiles.length >= GITHUB_PULL_REQUEST_FILES_LIMIT) {
        core.warning(
          `GitHub only returns the first ${GITHUB_PULL_REQUEST_FILES_LIMIT} files changed in a pull request. Processing all matching prompt files to avoid missing changes.`,
        );
      } else {
        changedFiles = pullRequestFiles
          .flatMap((file) =>
            file.previous_filename
              ? [file.filename, file.previous_filename]
              : [file.filename],
          )
          .join('\0')
          .concat('\0');
      }
    } else if (event === 'workflow_dispatch') {
      core.info('Running in workflow_dispatch mode');

      // For workflow_dispatch, we can either:
      // 1. Accept a list of files as input
      // 2. Compare against a base branch/commit
      // 3. Run on all prompt files

      // Priority: action inputs > workflow inputs > defaults
      const filesInput = workflowFiles || github.context.payload.inputs?.files;
      const compareBase: string =
        workflowBase || github.context.payload.inputs?.base || 'HEAD~1';

      if (filesInput) {
        // Option 1: Use provided file list
        if (filesInput.includes('\0')) {
          throw new PromptfooActionError(
            'Invalid workflow file list: null bytes are not allowed.',
            ErrorCodes.INVALID_CONFIGURATION,
            'Remove null bytes from the workflow file list.',
          );
        }
        const manualFiles = filesInput
          .split('\n')
          .map((file: string) => file.replace(/\r$/, ''));
        const trimmedFiles = manualFiles
          .map((file: string) => file.trim())
          .filter(Boolean);
        changedFiles = manualFiles
          .flatMap((file: string) => {
            const trimmed = file.trim();
            if (!trimmed) {
              return [];
            }
            return file === trimmed ? [file] : [file, trimmed];
          })
          .join('\0');
        core.info(`Using ${trimmedFiles.length} manually specified files`);
      } else {
        // Option 2: Compare against base (default to previous commit)
        validateGitRevision(compareBase);
        try {
          changedFiles = await gitInterface.diff([
            '--name-only',
            '--no-renames',
            '-z',
            compareBase,
            'HEAD',
            '--',
          ]);
          core.info(
            `Comparing against ${compareBase}, found changed files: ${formatChangedFilesForLog(changedFiles)}`,
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
        validateCommitSha(beforeSha, 'before commit');
        validateCommitSha(afterSha, 'after commit');
        try {
          changedFiles = await gitInterface.diff([
            '--name-only',
            '--no-renames',
            '-z',
            beforeSha,
            afterSha,
            '--',
          ]);
          core.info(
            `Comparing ${beforeSha}..${afterSha}, found changed files: ${formatChangedFilesForLog(changedFiles)}`,
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
    const allPromptFiles: string[] = [];
    const changedPromptFiles: string[] = [];
    const seenPromptFiles = new Set<string>();
    const containsQuotedControlPath =
      !changedFiles.includes('\0') &&
      /(?:^|\n)"[^\n"]*\\(?:[0-7]{3}|[abtnvfr"\\])[^\n"]*"(?=\n|$)/.test(
        changedFiles,
      );
    const changedFilesList = containsQuotedControlPath
      ? []
      : changedFiles
          .split(changedFiles.includes('\0') ? '\0' : '\n')
          .filter(Boolean);

    for (const globPattern of promptFilesGlobs) {
      validatePromptGlob(globPattern);
      const matches = glob.sync(globPattern, {
        cwd: workingDirectory,
        nodir: true,
        braceExpandMax: PROMPT_GLOB_BRACE_EXPANSION_LIMIT,
      });
      for (const file of matches) {
        const repositoryFile = toRepositoryPath(
          path.relative(workspaceRoot, path.resolve(workingDirectory, file)),
        );
        if (repositoryFile === configRepositoryPath) {
          continue;
        }
        if (seenPromptFiles.has(repositoryFile)) {
          continue;
        }
        seenPromptFiles.add(repositoryFile);
        allPromptFiles.push(file);
        if (changedFilesList.includes(repositoryFile)) {
          changedPromptFiles.push(file);
        }
      }
    }

    const configChanged =
      changedFilesList.length > 0 &&
      changedFilesList.includes(configRepositoryPath);

    // Extract dependencies from config file
    let dependencyChanged = false;
    const dependencies = extractFileDependencies(
      configAbsolutePath,
      process.cwd(),
      workingDirectory,
    ).map(toRepositoryPath);
    if (changedFilesList.length > 0) {
      if (dependencies.length > 0) {
        core.debug(`Found ${dependencies.length} file dependencies in config`);

        // Check if any changed file matches the dependencies
        dependencyChanged = dependencies.some((dep) => {
          if (dep === './' || dep === '.' || /[\r\n\0]/.test(dep)) {
            return true;
          }
          // Direct file match
          if (changedFilesList.includes(dep)) {
            return true;
          }

          // Check if the dependency is a directory and any changed file is within it
          if (dep.endsWith('/') || isDirectory(dep)) {
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
      changedPromptFiles.length < 1 &&
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

    const evaluatedPromptFiles = useConfigPrompts
      ? []
      : forceRun ||
          configChanged ||
          dependencyChanged ||
          changedFilesList.length === 0
        ? allPromptFiles
        : changedPromptFiles;
    if (evaluatedPromptFiles.some((file) => /[\r\n]/.test(file))) {
      throw new PromptfooActionError(
        'Invalid prompt file path: line breaks are not allowed.',
        ErrorCodes.INVALID_CONFIGURATION,
        'Rename the prompt file so its path does not contain CR or LF characters.',
      );
    }
    for (const file of evaluatedPromptFiles) {
      validatePromptPath(workspaceRoot, workingDirectory, file);
    }

    // Only parse repository environment files once an evaluation is required.
    loadEnvironmentFiles();

    if (forceRun) {
      core.info('Force run enabled - running evaluation regardless of changes');
    }

    if (changedFilesList.length === 0) {
      core.info(
        `Processing all matching prompt files: ${JSON.stringify(evaluatedPromptFiles)}`,
      );
    }

    const configEnvironment: NodeJS.ProcessEnv = { ...process.env };
    loadConfigEnvironmentFiles(
      configAbsolutePath,
      workingDirectory,
      configEnvironment,
    );
    maskApiKeys(configEnvironment);

    // Set up caching environment for optimal performance
    core.startGroup('Setting up cache');
    const resolvedCachePath = cachePath
      ? path.resolve(workingDirectory, cachePath)
      : undefined;
    setupCacheEnvironment(resolvedCachePath);

    // Clean up old cache entries in CI to prevent unbounded growth
    if (process.env.CI === 'true') {
      const cleanedCount = await cleanupOldCache(
        process.env.PROMPTFOO_CACHE_PATH ||
          resolvedCachePath ||
          path.join(process.env.HOME || '/tmp', '.promptfoo', 'cache'),
        7 * 24 * 60 * 60, // 7 days
      );
      if (cleanedCount > 0) {
        core.info(`Cleaned ${cleanedCount} old cache entries`);
      }
    }

    // Log initial cache metrics
    const cacheDir =
      process.env.PROMPTFOO_CACHE_PATH ||
      resolvedCachePath ||
      path.join(process.env.HOME || '/tmp', '.promptfoo', 'cache');
    await logCacheMetrics(cacheDir);
    core.endGroup();

    // Use a unique output file path so stale results from a previous run
    // cannot influence the current run's comments, thresholds, or pass/fail.
    const outputFile = path.join(
      workingDirectory,
      `output-${Date.now()}-${globalThis.crypto.randomUUID()}.json`,
    );
    let promptfooArgs = ['eval', '-c', configPath, '-o', outputFile];
    if (evaluatedPromptFiles.length > 0) {
      promptfooArgs = promptfooArgs.concat([
        '--prompts',
        ...evaluatedPromptFiles,
      ]);
    }
    // Check if sharing is enabled and validate authentication upfront
    if (noShare) {
      // Override config-level sharing as well as the action's default behavior.
      promptfooArgs.push('--no-share');
    } else {
      const promptfooApiKey = process.env.PROMPTFOO_API_KEY;
      const hasRemoteConfig = process.env.PROMPTFOO_REMOTE_API_BASE_URL;

      if (promptfooApiKey) {
        // Validate API key before running eval to fail fast
        core.info('Validating Promptfoo API key...');
        await validatePromptfooApiKey(promptfooApiKey, getApiHost());
        core.info('✓ Promptfoo API key validated');
        promptfooArgs.push('--share');
      } else if (hasRemoteConfig) {
        // For self-hosted instances with custom API URLs, skip validation
        // as they may use different authentication mechanisms
        core.info(
          'Using custom PROMPTFOO_REMOTE_API_BASE_URL. Skipping API key validation.',
        );
        promptfooArgs.push('--share');
      } else {
        core.info(
          'Sharing is enabled but no authentication found (PROMPTFOO_API_KEY or PROMPTFOO_REMOTE_API_BASE_URL). ' +
            'Skipping share step. To enable sharing, set PROMPTFOO_API_KEY as an environment variable.',
        );
        // Prevent a config-level share setting from bypassing this guard.
        promptfooArgs.push('--no-share');
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
    if (noCache) {
      promptfooArgs.push('--no-cache');
    }
    if (repeat !== undefined) {
      promptfooArgs.push('--repeat', repeat.toString());
      core.info(`Running each test ${repeat} times (--repeat ${repeat})`);
      if (repeatMinPass !== undefined) {
        core.info(
          `Per-test minimum: ${repeatMinPass} of ${repeat} runs must pass`,
        );
      }
    }

    const normalizedFailedTestExitCode = normalizeFailedTestExitCode(
      process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE,
    );
    if (normalizedFailedTestExitCode.warning) {
      core.warning(normalizedFailedTestExitCode.warning);
    }
    const failedTestExitCode = normalizedFailedTestExitCode.value;
    const hasPromptfooPassRateThreshold =
      'PROMPTFOO_PASS_RATE_THRESHOLD' in process.env;
    const promptfooPassRateThreshold = parsePromptfooPassRateThreshold(
      process.env.PROMPTFOO_PASS_RATE_THRESHOLD,
      hasPromptfooPassRateThreshold,
    );

    // Build environment for promptfoo execution
    // Environment variables from workflow context (process.env) are used as fallback for API keys.
    // Action inputs (if provided) take precedence and override environment variables.
    const env = {
      ...process.env, // Includes cache settings and environment variable fallbacks
      // Override with action inputs if provided (takes precedence over env vars)
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
      ...(process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE
        ? { PROMPTFOO_FAILED_TEST_EXIT_CODE: failedTestExitCode.toString() }
        : {}),
    };
    // Use ignoreReturnCode so we can inspect the exit code and still read output.
    // Promptfoo exits non-zero when any test fails — we want to post PR comments
    // and evaluate thresholds before deciding whether to fail the action.
    // See: https://github.com/promptfoo/promptfoo-action/issues/786
    const exitCode = await exec.exec(
      'npx',
      [
        '--prefix',
        path.resolve(__dirname, '..'),
        `promptfoo@${version}`,
        ...promptfooArgs,
      ],
      { env, cwd: workingDirectory, ignoreReturnCode: true },
    );

    // Promptfoo uses specific exit codes:
    //   0   = all tests passed
    //   100 = some tests failed (configurable via PROMPTFOO_FAILED_TEST_EXIT_CODE)
    //   1   = general error (config, runtime, API keys)
    //   2   = deprecated flag
    // We only suppress the failed-test exit code when repeat-min-pass passes.
    // All other non-zero exits are always hard failures.
    // Exit codes must be 3-255 to be usable:
    //   - 0, 1, 2, 130 are reserved (success, general error, deprecated flag, SIGINT)
    //   - Values > 255 wrap at the OS boundary (e.g., 300 becomes 44), so they
    //     won't match what the process actually exits with
    const isTestFailureExit = exitCode === failedTestExitCode;
    const isHardFailure = exitCode !== 0 && !isTestFailureExit;

    // Hard failures (config errors, runtime crashes) should fail immediately
    // before we try to read output — there's nothing useful to report.
    if (isHardFailure) {
      throw new PromptfooActionError(
        `Promptfoo exited with unexpected code ${exitCode}`,
        ErrorCodes.PROMPTFOO_EXECUTION_FAILED,
        'This indicates a configuration or runtime error, not just failed tests. Check the logs above for details.',
      );
    }

    // Read output file - promptfoo writes output.json even when tests fail
    // We try to read it so we can post PR comments with the results
    let output: OutputFile;
    try {
      const outputContent = fs.readFileSync(outputFile, 'utf8');
      output = JSON.parse(outputContent) as OutputFile;
    } catch (error) {
      if (isTestFailureExit) {
        throw new PromptfooActionError(
          `Promptfoo tests failed (exit code ${exitCode}) but no output was generated`,
          ErrorCodes.PROMPTFOO_EXECUTION_FAILED,
          'Check that your promptfoo configuration is valid and all required API keys are set',
        );
      }
      throw new PromptfooActionError(
        `Failed to read or parse output file: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCodes.INVALID_OUTPUT_FILE,
        'This usually happens when promptfoo fails to generate valid output. Check the logs above for more details',
      );
    }

    // Clean up the per-run output file
    try {
      fs.unlinkSync(outputFile);
    } catch {
      // best effort cleanup
    }

    // Log final cache metrics and create manifest
    core.startGroup('Cache metrics after evaluation');
    await logCacheMetrics(cacheDir);
    await createCacheManifest(cacheDir);
    core.endGroup();

    // Evaluate repeat threshold early so we can include results in PR comments
    let repeatCheckResult:
      | ReturnType<typeof evaluateRepeatThreshold>
      | undefined;
    if (repeatMinPass !== undefined && repeat !== undefined) {
      const repeatCount = repeat;
      // Runtime validation: extract and validate output.results structure
      const rawResults = (output.results as { results?: unknown }).results;

      // Validate that results is an array
      if (!Array.isArray(rawResults)) {
        throw new PromptfooActionError(
          `Invalid output format: expected output.results.results to be an array, got ${typeof rawResults}`,
          ErrorCodes.REPEAT_CHECK_FAILED,
          'The evaluation output may be malformed or truncated. Check promptfoo logs for errors.',
        );
      }

      // Validate that each element has minimal EvaluateResult shape
      for (let i = 0; i < rawResults.length; i++) {
        const item = rawResults[i];
        if (!item || typeof item !== 'object') {
          throw new PromptfooActionError(
            `Invalid result at index ${i}: expected object, got ${typeof item}`,
            ErrorCodes.REPEAT_CHECK_FAILED,
            'The evaluation output contains invalid result entries. Check promptfoo logs for errors.',
          );
        }
        // Check for essential fields that EvaluateResult should have
        const result = item as Record<string, unknown>;
        if (typeof result.promptIdx !== 'number') {
          throw new PromptfooActionError(
            `Invalid result at index ${i}: missing or invalid 'promptIdx' field`,
            ErrorCodes.REPEAT_CHECK_FAILED,
            'The evaluation output contains malformed result entries. Check promptfoo logs for errors.',
          );
        }
        if (typeof result.success !== 'boolean') {
          throw new PromptfooActionError(
            `Invalid result at index ${i}: missing or invalid 'success' field`,
            ErrorCodes.REPEAT_CHECK_FAILED,
            'The evaluation output contains malformed result entries. Check promptfoo logs for errors.',
          );
        }
      }

      // Safe to cast after validation
      const results = rawResults as EvaluateResult[];

      if (results.length === 0) {
        throw new PromptfooActionError(
          'No test results found - cannot check per-test repeat threshold',
          ErrorCodes.REPEAT_CHECK_FAILED,
          'Ensure your configuration includes valid tests to run',
        );
      }
      // repeat is guaranteed defined by cross-field validation above
      repeatCheckResult = evaluateRepeatThreshold(
        results,
        repeatMinPass,
        repeatCount,
      );
    }

    const promptfooSuiteSuccessRate = calculateSuccessRate(
      output.results.stats,
    );

    // Comment on PR or output results
    if (isPullRequest && pullRequestNumber && !disableComment) {
      const evaluatedFiles = evaluatedPromptFiles.join(', ');
      const description =
        evaluatedPromptFiles.length === 0
          ? 'Evaluated config-defined prompts'
          : forceRun ||
              configChanged ||
              dependencyChanged ||
              changedFilesList.length === 0
            ? `Evaluated prompt files: ${evaluatedFiles}`
            : `⚠️ LLM prompt was modified in these files: ${evaluatedFiles}`;
      let body = `${description}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${output.results.stats.failures}       |

`;
      if (repeatCheckResult) {
        body += formatRepeatCommentMarkdown(repeatCheckResult.summary);
        body += '\n';
      }
      if (output.shareableUrl) {
        body += `**» [View eval results](${output.shareableUrl}) «**`;
      } else {
        body += '**» View eval results in CI console «**';
      }
      await octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: pullRequestNumber,
        body,
      });
    } else if (!isPullRequest) {
      // For non-PR workflows, output results to workflow summary

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

      if (evaluatedPromptFiles.length > 0) {
        summary.addHeading('Evaluated Files', 3);
        summary.addList(evaluatedPromptFiles);
      }

      if (repeatCheckResult) {
        summary.addHeading('Repeat Check', 3);
        summary.addRaw(formatRepeatCommentMarkdown(repeatCheckResult.summary));
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
    let suiteThresholdPassed = false;
    if (failOnThreshold !== undefined) {
      const successRate = calculateSuccessRate(output.results.stats);

      if (successRate === undefined) {
        throw new PromptfooActionError(
          `No tests were run - cannot calculate success rate`,
          ErrorCodes.THRESHOLD_NOT_MET,
          `Ensure your configuration includes valid tests to run`,
        );
      }

      if (successRate < failOnThreshold) {
        throw new PromptfooActionError(
          `Evaluation success rate (${successRate.toFixed(
            2,
          )}%) is below the required threshold (${failOnThreshold}%)`,
          ErrorCodes.THRESHOLD_NOT_MET,
          `Consider adjusting your prompts or lowering the threshold`,
        );
      }

      core.info(
        `Suite threshold passed: ${successRate.toFixed(2)}% >= ${failOnThreshold}%`,
      );
      suiteThresholdPassed = true;
    }

    // Preserve promptfoo's own explicit pass-rate threshold when this action
    // suppresses Promptfoo's default failed-test exit code.
    if (
      promptfooPassRateThreshold !== undefined &&
      promptfooSuiteSuccessRate !== undefined &&
      promptfooSuiteSuccessRate < promptfooPassRateThreshold
    ) {
      throw new PromptfooActionError(
        `Evaluation success rate (${promptfooSuiteSuccessRate.toFixed(
          2,
        )}%) is below PROMPTFOO_PASS_RATE_THRESHOLD (${promptfooPassRateThreshold}%)`,
        ErrorCodes.THRESHOLD_NOT_MET,
        'Consider adjusting your prompts or lowering PROMPTFOO_PASS_RATE_THRESHOLD',
      );
    }

    if (
      promptfooPassRateThreshold !== undefined &&
      promptfooSuiteSuccessRate !== undefined
    ) {
      core.info(
        `Promptfoo pass-rate threshold passed: ${promptfooSuiteSuccessRate.toFixed(
          2,
        )}% >= ${promptfooPassRateThreshold}%`,
      );
    }

    // Check per-test repeat threshold (already computed above for PR comments)
    if (repeatCheckResult) {
      if (repeatCheckResult.passed) {
        core.info(
          `Repeat check passed: all ${repeatCheckResult.summary.totalGroups} test(s) met minimum (${repeatCheckResult.summary.minPass} of ${repeatCheckResult.summary.repeatCount})`,
        );
      } else {
        throw new PromptfooActionError(
          formatRepeatFailureMessage(repeatCheckResult.summary),
          ErrorCodes.REPEAT_CHECK_FAILED,
          'Consider adjusting your prompts or lowering repeat-min-pass',
        );
      }
    }

    // Handle the failed-test exit code.
    // When thresholds are configured, the user explicitly opts into tolerating
    // some test failures. Suppress only Promptfoo's test-failure exit after the
    // configured action-level thresholds have passed.
    if (isTestFailureExit) {
      const repeatThresholdPassed =
        repeatMinPass !== undefined && repeatCheckResult?.passed;
      if (suiteThresholdPassed || repeatThresholdPassed) {
        const passedThresholds = [
          suiteThresholdPassed ? 'suite threshold' : undefined,
          repeatThresholdPassed ? 'repeat minimum' : undefined,
        ].filter(Boolean);
        core.info(
          `Promptfoo exited with test-failure code ${exitCode}, but ${passedThresholds.join(
            ' and ',
          )} passed.`,
        );
      } else {
        throw new PromptfooActionError(
          `Promptfoo evaluation failed (exit code ${exitCode})`,
          ErrorCodes.PROMPTFOO_EXECUTION_FAILED,
          'Some tests failed. Check the eval results for details.',
        );
      }
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

/* v8 ignore next 3 -- packaged action bootstrap */
if (require.main === module) {
  run();
}
