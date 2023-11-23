import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import { simpleGit } from 'simple-git';

const gitInterface = simpleGit();


function findConfigFileFromPromptFile(promptFile: string): string | undefined {
  // Look for all yarm files and look for promptFile in them
  const yamlFiles = glob.sync('*.yaml');
  for (const yamlFile of yamlFiles) {
    console.log(`Checking if ${yamlFile} refers to ${promptFile}`);
    const yamlContent = fs.readFileSync(yamlFile, 'utf8');
    if (yamlContent.includes(promptFile)) {
      console.log(`YES!`);
      return yamlFile;
    }
  }
  return undefined;
}

async function promptfoo(promptFile: string, env: any) {
  const configFile = findConfigFileFromPromptFile(promptFile);
  if (!configFile) {
    return `⚠️ No config file found for ${promptFile}\n\n`;
  }
  
  const outputFile = path.join(process.cwd(), 'output.json');
  const promptfooArgs = [
    'eval',
    '-c',
    configFile,
    '--prompts',
    promptFile,
    '-o',
    outputFile,
    '--share',
  ];
  await exec.exec('npx promptfoo', promptfooArgs, { env });
  const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  return `⚠️ LLM prompt was modified in ${promptFile}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${output.results.stats.failures}       |

**» [View eval results](${output.shareableUrl}) «**

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
    const githubToken: string = core.getInput('github-token', { required: true });
    const promptFilesGlobs: string[] = core
      .getInput('prompts', { required: true })
      .split('\n');
    const cachePath: string = core.getInput('cache-path', { required: false });

    core.setSecret(openaiApiKey);
    core.setSecret(azureOpenaiApiKey);
    core.setSecret(githubToken);

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('No pull request found.');
    }

    // Get list of changed files in PR
    const baseRef = pullRequest.base.ref;
    const headRef = pullRequest.head.ref;
    console.log(`Fetching...`);
    await exec.exec('git', ['fetch', 'origin', baseRef, headRef]);
    const baseFetchHead = (await gitInterface.revparse(['FETCH_HEAD'])).trim();
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
        file => changedFiles.includes(file),
      );
      promptFiles.push(...changedMatches);
    }

    // Run promptfoo evaluation only for changed files
    if (promptFiles.length === 0) {
      return;
    }
    // For each prompt file, find the .yaml file that references it
    // and run promptfoo with that .yaml file as config
    let body = '';
    const env = {
      ...process.env,
      ...(azureOpenaiApiKey ? { AZURE_OPENAI_API_KEY: azureOpenaiApiKey } : {}),
      ...(openaiApiKey ? { OPENAI_API_KEY: openaiApiKey } : {}),
      ...(cachePath ? { PROMPTFOO_CACHE_PATH: cachePath } : {}),
    }
    for (const promptFile of promptFiles) {
      console.log(`Running promptfoo for ${promptFile}`);
      body += await promptfoo(promptFile, env);
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
