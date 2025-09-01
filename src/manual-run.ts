import * as core from '@actions/core';
import {findPromptFile, runPromptfoo} from './shared';

export async function run(): Promise<void> {
  try {
    const promptName = core.getInput('prompt-file', {required: true});
    const inputFile = core.getInput('input-file', {required: true});
    const promptFile = findPromptFile(promptName);
    const provider = core.getInput('provider', {required: true});
    const openaiApiKey: string = core.getInput('openai-api-key', {
      required: false,
    });
    const azureOpenaiApiKey: string = core.getInput('azure-openai-api-key', {
      required: false,
    });
    const cachePath: string = core.getInput('cache-path', {required: false});

    core.setSecret(openaiApiKey);
    core.setSecret(azureOpenaiApiKey);

    const env = {
      ...process.env,
      ...(azureOpenaiApiKey ? {AZURE_OPENAI_API_KEY: azureOpenaiApiKey} : {}),
      ...(openaiApiKey ? {OPENAI_API_KEY: openaiApiKey} : {}),
      ...(cachePath ? {PROMPTFOO_CACHE_PATH: cachePath} : {}),
    };

    core.info('Running promptfoo...');
    const {outputFile, summary} = await runPromptfoo(promptFile, env, 1, [
      '--filter-providers',
      provider,
      '--tests',
      inputFile,
    ]);
    core.info(summary);
    core.setOutput('output-path', outputFile);
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
