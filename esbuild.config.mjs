import * as esbuild from 'esbuild';
import * as fs from 'fs';

// Build the action bundle directly from TypeScript source
// This allows esbuild to handle ESM-only packages properly
await esbuild.build({
  entryPoints: ['./src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  outfile: './dist/index.js',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // Handle ESM packages
  mainFields: ['module', 'main'],
  // Generate license file
  legalComments: 'external',
  logLevel: 'info',
  banner: {
    js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
  },
});

// Rename the legal comments file
const legalFile = './dist/index.js.LEGAL.txt';
if (fs.existsSync(legalFile)) {
  fs.renameSync(legalFile, './dist/licenses.txt');
}

// Create package.json to mark dist as ESM
fs.writeFileSync('./dist/package.json', JSON.stringify({ type: 'module' }, null, 2));

console.log('Build complete!');
