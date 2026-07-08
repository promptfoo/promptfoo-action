import * as esbuild from 'esbuild';
import * as fs from 'fs';

try {
  // Build the action bundle directly from TypeScript source
  // This allows esbuild to handle ESM-only packages properly
  await esbuild.build({
    entryPoints: ['./src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    outfile: './dist/index.js',
    format: 'cjs',
    sourcemap: true,
    minify: false,
    // Handle ESM-only packages by bundling them
    mainFields: ['module', 'main'],
    // Generate license file
    legalComments: 'external',
    logLevel: 'info',
  });

  // Rename the legal comments file to match ncc's output
  const legalFile = './dist/index.js.LEGAL.txt';
  if (fs.existsSync(legalFile)) {
    fs.renameSync(legalFile, './dist/licenses.txt');
  }

  console.log('Build complete!');
} catch (error) {
  console.error('Build failed: esbuild was unable to produce the bundle.');
  console.error(error);
  process.exitCode = 1;
}
