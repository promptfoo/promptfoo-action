import * as core from '@actions/core';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cache utilities for optimizing promptfoo evaluations in GitHub Actions.
 * Integrates with both promptfoo's internal caching and GitHub Actions cache.
 */

export interface CacheConfig {
  enabled: boolean;
  path: string;
  ttl: number;
  maxSize: number;
  maxFiles: number;
}

/**
 * Get default cache configuration optimized for GitHub Actions
 */
export function getDefaultCacheConfig(): CacheConfig {
  return {
    enabled: true,
    path:
      process.env.PROMPTFOO_CACHE_PATH ||
      path.join(process.env.HOME || '/tmp', '.promptfoo', 'cache'),
    ttl: parseInt(process.env.PROMPTFOO_CACHE_TTL || '86400', 10), // 1 day default for CI
    maxSize: parseInt(process.env.PROMPTFOO_CACHE_MAX_SIZE || '52428800', 10), // 50MB for CI
    maxFiles: parseInt(
      process.env.PROMPTFOO_CACHE_MAX_FILE_COUNT || '5000',
      10,
    ),
  };
}

/**
 * Set up promptfoo cache environment variables for optimal GitHub Actions performance
 */
export function setupCacheEnvironment(cachePath?: string): void {
  const config = getDefaultCacheConfig();

  // Always enable caching in CI for better performance
  process.env.PROMPTFOO_CACHE_ENABLED = 'true';
  process.env.PROMPTFOO_CACHE_TYPE = 'disk'; // Use disk cache for persistence across steps

  if (cachePath) {
    // Use provided cache path
    const absolutePath = path.isAbsolute(cachePath)
      ? cachePath
      : path.join(process.cwd(), cachePath);

    process.env.PROMPTFOO_CACHE_PATH = absolutePath;

    // Ensure cache directory exists
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
      core.debug(`Created cache directory at: ${absolutePath}`);
    }
  } else {
    // Use default cache path
    process.env.PROMPTFOO_CACHE_PATH = config.path;

    // Ensure default cache directory exists
    if (!fs.existsSync(config.path)) {
      fs.mkdirSync(config.path, { recursive: true });
      core.debug(`Created default cache directory at: ${config.path}`);
    }
  }

  // Set cache TTL and size limits optimized for CI
  process.env.PROMPTFOO_CACHE_TTL = config.ttl.toString();
  process.env.PROMPTFOO_CACHE_MAX_SIZE = config.maxSize.toString();
  process.env.PROMPTFOO_CACHE_MAX_FILE_COUNT = config.maxFiles.toString();

  core.info('Cache environment configured:');
  core.info(`  Path: ${process.env.PROMPTFOO_CACHE_PATH}`);
  core.info(`  TTL: ${config.ttl}s (${config.ttl / 3600} hours)`);
  core.info(`  Max Size: ${config.maxSize / 1048576}MB`);
  core.info(`  Max Files: ${config.maxFiles}`);
}

/**
 * Generate a cache key for the current evaluation context
 * This helps with GitHub Actions cache@v4 integration
 */
export function generateCacheKey(
  configPath: string,
  promptFiles: string[],
  additionalFactors?: string[],
): string {
  const factors = [
    configPath,
    ...promptFiles.sort(),
    ...(additionalFactors || []),
  ];

  // Create a hash of all factors for a stable cache key
  const hash = crypto
    .createHash('sha256')
    .update(factors.join('|'))
    .digest('hex')
    .substring(0, 16);

  // Include OS and date for cache freshness
  const os = process.platform;
  const week = getWeekNumber(new Date());

  return `promptfoo-${os}-${week}-${hash}`;
}

/**
 * Get week number for cache rotation
 */
function getWeekNumber(date: Date): string {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  const weekNumber = Math.ceil(
    (pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7,
  );
  return `${date.getFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
}

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStats(cachePath: string): Promise<{
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  oldestFile?: Date;
  newestFile?: Date;
}> {
  if (!fs.existsSync(cachePath)) {
    return {
      exists: false,
      sizeBytes: 0,
      fileCount: 0,
    };
  }

  let totalSize = 0;
  let fileCount = 0;
  let oldestTime: number | undefined;
  let newestTime: number | undefined;

  function walkDir(dir: string): void {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        walkDir(filePath);
      } else {
        totalSize += stat.size;
        fileCount++;

        const mtime = stat.mtime.getTime();
        if (!oldestTime || mtime < oldestTime) oldestTime = mtime;
        if (!newestTime || mtime > newestTime) newestTime = mtime;
      }
    }
  }

  walkDir(cachePath);

  return {
    exists: true,
    sizeBytes: totalSize,
    fileCount,
    oldestFile: oldestTime ? new Date(oldestTime) : undefined,
    newestFile: newestTime ? new Date(newestTime) : undefined,
  };
}

/**
 * Log cache performance metrics
 */
export async function logCacheMetrics(cachePath: string): Promise<void> {
  try {
    const stats = await getCacheStats(cachePath);

    if (stats.exists) {
      core.info('Cache Statistics:');
      core.info(`  Size: ${(stats.sizeBytes / 1048576).toFixed(2)}MB`);
      core.info(`  Files: ${stats.fileCount}`);
      if (stats.oldestFile) {
        core.info(`  Oldest: ${stats.oldestFile.toISOString()}`);
      }
      if (stats.newestFile) {
        core.info(`  Newest: ${stats.newestFile.toISOString()}`);
      }

      // Set outputs for workflow usage
      core.setOutput('cache-size-mb', (stats.sizeBytes / 1048576).toFixed(2));
      core.setOutput('cache-file-count', stats.fileCount.toString());
    } else {
      core.info('Cache directory does not exist yet');
    }
  } catch (error) {
    core.warning(`Failed to get cache metrics: ${error}`);
  }
}

/**
 * Clean up old cache entries to prevent unbounded growth
 */
export async function cleanupOldCache(
  cachePath: string,
  maxAgeSeconds: number = 604800, // 7 days default
): Promise<number> {
  if (!fs.existsSync(cachePath)) {
    return 0;
  }

  const now = Date.now();
  const maxAgeMs = maxAgeSeconds * 1000;
  let deletedCount = 0;

  function cleanDir(dir: string): void {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        cleanDir(filePath);
        // Remove empty directories
        if (fs.readdirSync(filePath).length === 0) {
          fs.rmdirSync(filePath);
          deletedCount++;
        }
      } else {
        const age = now - stat.mtime.getTime();
        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
          core.debug(`Deleted old cache file: ${filePath}`);
        }
      }
    }
  }

  try {
    cleanDir(cachePath);
    if (deletedCount > 0) {
      core.info(`Cleaned up ${deletedCount} old cache entries`);
    }
  } catch (error) {
    core.warning(`Cache cleanup failed: ${error}`);
  }

  return deletedCount;
}

/**
 * Optimize cache for GitHub Actions by creating a cache manifest
 */
export async function createCacheManifest(
  cachePath: string,
  outputPath?: string,
): Promise<void> {
  const manifestPath =
    outputPath || path.join(cachePath, '.cache-manifest.json');
  const stats = await getCacheStats(cachePath);

  const manifest = {
    version: '1.0.0',
    created: new Date().toISOString(),
    stats,
    environment: {
      os: process.platform,
      node: process.version,
      ci: process.env.CI === 'true',
      github_action: process.env.GITHUB_ACTION,
      github_run_id: process.env.GITHUB_RUN_ID,
      github_sha: process.env.GITHUB_SHA,
    },
    config: {
      path: cachePath,
      ttl: process.env.PROMPTFOO_CACHE_TTL,
      maxSize: process.env.PROMPTFOO_CACHE_MAX_SIZE,
      maxFiles: process.env.PROMPTFOO_CACHE_MAX_FILE_COUNT,
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  core.debug(`Cache manifest created at: ${manifestPath}`);
}
