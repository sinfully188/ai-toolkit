import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

function trimTrailingSeparator(value: string) {
  if (value.length <= 1) {
    return value;
  }

  return value.replace(/[\\/]+$/, '');
}

async function canonicalizePath(inputPath: string) {
  const normalizedPath = path.normalize(inputPath);

  try {
    return trimTrailingSeparator(await fsp.realpath(normalizedPath));
  } catch {
    return trimTrailingSeparator(path.resolve(normalizedPath));
  }
}

export async function canonicalizeConfiguredPath(inputPath: string) {
  return canonicalizePath(inputPath);
}

export async function isPathAllowed(targetPath: string, allowedRoots: string[]) {
  const canonicalTarget = await canonicalizePath(targetPath);
  const canonicalRoots = await Promise.all(allowedRoots.map(root => canonicalizePath(root)));

  return canonicalRoots.some(root => {
    const relativePath = path.relative(root, canonicalTarget);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  });
}

export function pathContainsTraversal(inputPath: string) {
  return inputPath.split(/[\\/]+/).includes('..');
}

export function fileExists(inputPath: string) {
  return fs.existsSync(inputPath);
}