import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import * as core from '@actions/core';

export interface IPromptFooOutput {
  results: {
    results: {
      success: boolean;
      error: string;
      vars: {[key: string]: string | boolean | number} | undefined;
    }[];
    stats: {
      successes: number;
      failures: number;
    };
  };
}

export function displayResultSummary(output: IPromptFooOutput): string {
  let text = '';
  for (const result of output.results.results) {
    if (result.success === true) {
      continue;
    }
    text += `**🚫 FAILED:**
\`\`\`
${result.error}
\`\`\`
    
**VARS:**
\`\`\`
${JSON.stringify(result.vars)}
\`\`\`

----------

`;
  }
  return text;
}

export function findPromptFile(promptFile: string): string {
  const jsonFiles = glob.sync(`prompts-output/**/*.json`);
  for (const jsonFile of jsonFiles) {
    if (path.basename(jsonFile).includes(promptFile)) {
      return jsonFile;
    }
  }
  throw new Error(`Prompt file not found: ${promptFile}`);
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

export async function runPromptfoo(
  promptFile: string,
  env: {[key: string]: string},
  promptFileId: number,
  additionalParameters?: string[],
): Promise<{outputFile: string; summary: string}> {
  const configFile = findConfigFileFromPromptFile(promptFile);
  if (!configFile) {
    return {
      outputFile: '',
      summary: `⚠️ No config file found for ${promptFile}\n\n`,
    };
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
    ...(additionalParameters || []),
  ];
  core.info(
    `[action] Running promptfoo with args: ${JSON.stringify(promptfooArgs)}`,
  );
  try {
    const exitCode = await exec.exec('npx promptfoo', promptfooArgs, {env});
    core.info(
      `[action] Finished running promptfoo with exit code: ${exitCode}`,
    );
  } catch (error: unknown) {
    core.error(`[action] Error running promptfoo: ${error}`);
  }
  const output: IPromptFooOutput = JSON.parse(
    fs.readFileSync(outputFile, 'utf8'),
  );
  const summary = `# ${promptFile}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${
    output.results.stats.failures
  }       |

${displayResultSummary(output)}

`;
  return {outputFile, summary};
}
