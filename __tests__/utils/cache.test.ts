import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import {
  cleanupOldCache,
  createCacheManifest,
  generateCacheKey,
  getCacheStats,
  getDefaultCacheConfig,
  setupCacheEnvironment,
} from '../../src/utils/cache';

// Mock dependencies
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  setFailed: jest.fn(),
}));
jest.mock('fs', () => {
  const realFs = jest.requireActual('fs') as typeof import('fs');
  return {
    ...realFs,
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    readdirSync: jest.fn(),
    statSync: jest.fn(),
    unlinkSync: jest.fn(),
    rmdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    promises: {
      ...realFs.promises,
      access: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
    },
  };
});

const mockCore = core as jest.Mocked<typeof core>;
const mockFs = fs as jest.Mocked<typeof fs> & {
  readdirSync: jest.MockedFunction<any>;
  statSync: jest.MockedFunction<any>;
};

describe('Cache Utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear environment variables
    delete process.env.PROMPTFOO_CACHE_PATH;
    delete process.env.PROMPTFOO_CACHE_TTL;
    delete process.env.PROMPTFOO_CACHE_MAX_SIZE;
    delete process.env.PROMPTFOO_CACHE_MAX_FILE_COUNT;
    delete process.env.PROMPTFOO_CACHE_ENABLED;
    delete process.env.PROMPTFOO_CACHE_TYPE;
  });

  describe('getDefaultCacheConfig', () => {
    it('should return default configuration', () => {
      const config = getDefaultCacheConfig();
      expect(config).toEqual({
        enabled: true,
        path: expect.stringContaining('.promptfoo/cache'),
        ttl: 86400, // 1 day
        maxSize: 52428800, // 50MB
        maxFiles: 5000,
      });
    });

    it('should use environment variables when available', () => {
      process.env.PROMPTFOO_CACHE_PATH = '/custom/cache';
      process.env.PROMPTFOO_CACHE_TTL = '3600';
      process.env.PROMPTFOO_CACHE_MAX_SIZE = '10485760';
      process.env.PROMPTFOO_CACHE_MAX_FILE_COUNT = '1000';

      const config = getDefaultCacheConfig();
      expect(config).toEqual({
        enabled: true,
        path: '/custom/cache',
        ttl: 3600,
        maxSize: 10485760,
        maxFiles: 1000,
      });
    });
  });

  describe('setupCacheEnvironment', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined);
    });

    it('should set up cache environment with default path', () => {
      setupCacheEnvironment();

      expect(process.env.PROMPTFOO_CACHE_ENABLED).toBe('true');
      expect(process.env.PROMPTFOO_CACHE_TYPE).toBe('disk');
      expect(process.env.PROMPTFOO_CACHE_PATH).toContain('.promptfoo/cache');
      expect(process.env.PROMPTFOO_CACHE_TTL).toBe('86400');
      expect(process.env.PROMPTFOO_CACHE_MAX_SIZE).toBe('52428800');
      expect(process.env.PROMPTFOO_CACHE_MAX_FILE_COUNT).toBe('5000');
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.promptfoo/cache'),
        { recursive: true },
      );
      expect(mockCore.debug).toHaveBeenCalledWith(
        expect.stringContaining('Created default cache directory'),
      );
    });

    it('should use provided cache path', () => {
      setupCacheEnvironment('/custom/cache/path');

      expect(process.env.PROMPTFOO_CACHE_PATH).toBe('/custom/cache/path');
      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/custom/cache/path', {
        recursive: true,
      });
    });

    it('should handle relative cache path', () => {
      const cwd = process.cwd();
      setupCacheEnvironment('relative/cache');

      expect(process.env.PROMPTFOO_CACHE_PATH).toBe(
        path.join(cwd, 'relative/cache'),
      );
    });

    it('should not create directory if it exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      setupCacheEnvironment('/existing/cache');

      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should log cache configuration', () => {
      setupCacheEnvironment();

      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Cache environment configured:'),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Path:'),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('TTL:'),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Max Size:'),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Max Files:'),
      );
    });
  });

  describe('generateCacheKey', () => {
    // Mock Date to have consistent output
    const mockDate = new Date('2025-03-15');

    beforeAll(() => {
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);
    });

    afterAll(() => {
      jest.useRealTimers();
    });

    it('should generate cache key with config and prompt files', () => {
      const key = generateCacheKey('config.yaml', [
        'prompt1.txt',
        'prompt2.txt',
      ]);

      expect(key).toMatch(/^promptfoo-\w+-2025-W\d+-[a-f0-9]{16}$/);
      expect(key).toContain(process.platform);
    });

    it('should generate consistent keys for same inputs', () => {
      const key1 = generateCacheKey('config.yaml', ['a.txt', 'b.txt']);
      const key2 = generateCacheKey('config.yaml', ['a.txt', 'b.txt']);

      expect(key1).toBe(key2);
    });

    it('should generate different keys for different inputs', () => {
      const key1 = generateCacheKey('config1.yaml', ['a.txt']);
      const key2 = generateCacheKey('config2.yaml', ['a.txt']);

      expect(key1).not.toBe(key2);
    });

    it('should include additional factors in key', () => {
      const key1 = generateCacheKey('config.yaml', ['a.txt'], ['factor1']);
      const key2 = generateCacheKey('config.yaml', ['a.txt'], ['factor2']);

      expect(key1).not.toBe(key2);
    });

    it('should handle empty prompt files array', () => {
      const key = generateCacheKey('config.yaml', []);

      expect(key).toMatch(/^promptfoo-\w+-2025-W\d+-[a-f0-9]{16}$/);
    });
  });

  describe('getCacheStats', () => {
    it('should return stats for non-existent cache', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const stats = await getCacheStats('/cache/path');

      expect(stats).toEqual({
        exists: false,
        sizeBytes: 0,
        fileCount: 0,
      });
    });

    it('should calculate cache statistics', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockImplementation((dir: any) => {
        const dirStr = String(dir);
        if (dirStr.endsWith('subdir')) {
          return []; // Empty subdirectory to stop recursion
        }
        return ['file1.json', 'file2.json', 'subdir'];
      });
      mockFs.statSync.mockImplementation((filePath: any) => {
        const filePathStr = String(filePath);
        if (filePathStr.endsWith('subdir')) {
          return {
            isDirectory: () => true,
            size: 0,
            mtime: new Date('2025-01-01'),
          } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          size: 1024,
          mtime: new Date('2025-01-15'),
        } as fs.Stats;
      });

      const stats = await getCacheStats('/cache/path');

      expect(stats.exists).toBe(true);
      expect(stats.sizeBytes).toBe(2048); // 2 files * 1024 bytes
      expect(stats.fileCount).toBe(2);
      expect(stats.oldestFile).toEqual(new Date('2025-01-15'));
      expect(stats.newestFile).toEqual(new Date('2025-01-15'));
    });
  });

  describe('cleanupOldCache', () => {
    it('should return 0 for non-existent cache', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const deleted = await cleanupOldCache('/cache/path');

      expect(deleted).toBe(0);
      expect(mockFs.readdirSync).not.toHaveBeenCalled();
    });

    it('should delete old files', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 8 * 24 * 60 * 60 * 1000); // 8 days old
      const newDate = new Date(now - 1 * 24 * 60 * 60 * 1000); // 1 day old

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['old.json', 'new.json']);
      mockFs.statSync.mockImplementation((filePath: any) => {
        const filePathStr = String(filePath);
        if (filePathStr.endsWith('old.json')) {
          return {
            isDirectory: () => false,
            mtime: oldDate,
          } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: newDate,
        } as fs.Stats;
      });
      mockFs.unlinkSync.mockImplementation(() => undefined);

      const deleted = await cleanupOldCache('/cache/path', 7 * 24 * 60 * 60);

      expect(deleted).toBe(1);
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('old.json'),
      );
      expect(mockFs.unlinkSync).not.toHaveBeenCalledWith(
        expect.stringContaining('new.json'),
      );
    });

    it('should remove empty directories after cleaning old files', async () => {
      const now = Date.now();
      const oldDate = new Date(now - 8 * 24 * 60 * 60 * 1000); // 8 days old

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync
        .mockReturnValueOnce(['subdir']) // Root directory
        .mockReturnValueOnce(['old.json']) // Subdirectory with old file
        .mockReturnValueOnce([]); // Empty after file deletion

      mockFs.statSync.mockImplementation((filePath: any) => {
        const filePathStr = String(filePath);
        if (filePathStr.includes('subdir') && !filePath.includes('.json')) {
          return {
            isDirectory: () => true,
            mtime: oldDate,
          } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: oldDate,
        } as fs.Stats;
      });

      mockFs.unlinkSync.mockImplementation(() => undefined);
      mockFs.rmdirSync.mockImplementation(() => undefined);

      const deleted = await cleanupOldCache('/cache/path', 7 * 24 * 60 * 60);

      expect(deleted).toBe(2); // 1 file + 1 directory
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('old.json'),
      );
      expect(mockFs.rmdirSync).toHaveBeenCalledWith(
        expect.stringContaining('subdir'),
      );
    });
  });

  describe('createCacheManifest', () => {
    it('should create cache manifest', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['file.json']);
      mockFs.statSync.mockReturnValue({
        isDirectory: () => false,
        size: 1024,
        mtime: new Date('2025-01-15'),
      } as fs.Stats);
      mockFs.writeFileSync.mockImplementation(() => undefined);

      await createCacheManifest('/cache/path');

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/cache/path/.cache-manifest.json',
        expect.stringContaining('"version": "1.0.0"'),
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"sizeBytes": 1024'),
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"fileCount": 1'),
      );
    });

    it('should use custom output path', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => undefined);

      await createCacheManifest('/cache/path', '/custom/manifest.json');

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/custom/manifest.json',
        expect.any(String),
      );
    });
  });
});
