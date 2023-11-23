import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import {simpleGit} from 'simple-git';

const gitInterface = simpleGit();

interface IPromptFooOutput {
  results: {
    results: {
      success: boolean;
      error: string;
      vars: {[key: string]: string | boolean | number} | undefined;
    }[];
  };
}

function displayResultSummary(output: IPromptFooOutput): string {
  let text = '';
  for (const result of output.results.results) {
    if (result.success === true) {
      continue;
    }
    text += `*FAILED:*
      \`\`\`${result.error}\`\`\`
    
      *VARS:*
      \`\`\`${JSON.stringify(result.vars)}\`\`\`

      ----------
    `;
  }
  return text;
}

function findConfigFileFromPromptFile(promptFile: string): string | undefined {
  // Look for all yarm files and look for promptFile in them
  const yamlFiles = glob.sync('*.yaml');
  for (const yamlFile of yamlFiles) {
    const yamlContent = fs.readFileSync(yamlFile, 'utf8');
    if (yamlContent.includes(promptFile)) {
      return yamlFile;
    }
  }
  return undefined;
}

async function promptfoo(
  promptFile: string,
  env: {[key: string]: string},
  promptFileId: number,
): Promise<string> {
  const configFile = findConfigFileFromPromptFile(promptFile);
  if (!configFile) {
    return `⚠️ No config file found for ${promptFile}\n\n`;
  }

  const outputFile = path.join(
    process.cwd(),
    `promptfoo-output-${promptFileId}.json`,
  );
  const promptfooArgs = [
    'eval',
    '-c',
    configFile,
    '--prompts',
    promptFile,
    '-o',
    outputFile,
  ];
  await exec.exec('npx promptfoo', promptfooArgs, {env});
  const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  return `⚠️ LLM prompt was modified in ${promptFile}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${
    output.results.stats.failures
  }       |

${displayResultSummary(output)}

`;
}

export async function run(): Promise<void> {
  try {
    const openaiApiKey: string = core.getInput('openai-api-key', {
      required: false,
    });
    const azureOpenaiApiKey: string = core.getInput('azure-openai-api-key', {
      required: false,
    });
    const githubToken: string = core.getInput('github-token', {required: true});
    const promptFilesGlobs: string[] = core
      .getInput('prompts', {required: true})
      .split('\n');
    const cachePath: string = core.getInput('cache-path', {required: false});

    core.setSecret(openaiApiKey);
    core.setSecret(azureOpenaiApiKey);
    core.setSecret(githubToken);

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('No pull request found.');
    }

    core.info(`git diff --name-only origin/main`);
    const changedFiles = await gitInterface.diff([
      '--name-only',
      'origin/main',
    ]);
    core.info('Changed files:');
    core.info(JSON.stringify(changedFiles));

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
    core.info(`Changed prompt files: ${promptFiles.join(', ')}`);
    if (promptFiles.length === 0) {
      return;
    }
    // For each prompt file, find the .yaml file that references it
    // and run promptfoo with that .yaml file as config
    let body = '';
    const env = {
      ...process.env,
      ...(azureOpenaiApiKey ? {AZURE_OPENAI_API_KEY: azureOpenaiApiKey} : {}),
      ...(openaiApiKey ? {OPENAI_API_KEY: openaiApiKey} : {}),
      ...(cachePath ? {PROMPTFOO_CACHE_PATH: cachePath} : {}),
    };
    let promptFileId = 1;
    for (const promptFile of promptFiles) {
      core.info(`Running promptfoo for ${promptFile}`);
      body += await promptfoo(promptFile, env, promptFileId++);
    }

    // Comment PR
    const octokit = github.getOctokit(githubToken);
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: pullRequest.number,
      body,
    });
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
