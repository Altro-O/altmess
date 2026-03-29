const fs = require('fs/promises');
const path = require('path');
const { loadState, getState, saveState } = require('./persistence');

const MEDIA_UPLOAD_DIR = path.resolve(process.env.MEDIA_UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
const SOFT_LIMIT_BYTES = Number(process.env.MEDIA_CLEANUP_SOFT_LIMIT_BYTES || 6.5 * 1024 * 1024 * 1024);
const HARD_LIMIT_BYTES = Number(process.env.MEDIA_CLEANUP_HARD_LIMIT_BYTES || 7 * 1024 * 1024 * 1024);
const MIN_FREE_BYTES = Number(process.env.MEDIA_CLEANUP_MIN_FREE_BYTES || 512 * 1024 * 1024);

function toStoragePath(storageKey) {
  const normalized = String(storageKey || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(MEDIA_UPLOAD_DIR, normalized);
  return resolved.startsWith(MEDIA_UPLOAD_DIR) ? resolved : null;
}

async function walkFiles(directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walkFiles(entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stats = await fs.stat(entryPath);
    result.push({
      path: entryPath,
      storageKey: path.relative(MEDIA_UPLOAD_DIR, entryPath).replace(/\\/g, '/'),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }

  return result;
}

function collectProtectedStorageKeys(state) {
  const protectedKeys = new Set();

  state.users.forEach((user) => {
    if (user.avatarStorageKind === 'vps' && user.avatarStorageKey) {
      protectedKeys.add(String(user.avatarStorageKey));
    }
  });

  return protectedKeys;
}

function collectMessageAttachmentEntries(state) {
  return state.messages
    .filter((message) => message.attachment && message.attachment.storageKind === 'vps' && message.attachment.storageKey)
    .map((message) => ({
      message,
      storageKey: String(message.attachment.storageKey),
      uploadedAt: message.attachment.uploadedAt || message.createdAt || new Date(0).toISOString(),
    }))
    .sort((left, right) => new Date(left.uploadedAt).getTime() - new Date(right.uploadedAt).getTime());
}

async function getDiskMetrics() {
  const stats = await fs.statfs(MEDIA_UPLOAD_DIR);
  return {
    availableBytes: stats.bavail * stats.bsize,
  };
}

async function main() {
  await loadState();
  const state = getState();
  const files = await walkFiles(MEDIA_UPLOAD_DIR);
  const protectedKeys = collectProtectedStorageKeys(state);
  const messageEntries = collectMessageAttachmentEntries(state);
  const fileMap = new Map(files.map((file) => [file.storageKey, file]));
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let availableBytes = (await getDiskMetrics()).availableBytes;
  let stateChanged = false;

  for (const entry of messageEntries) {
    if (!fileMap.has(entry.storageKey) && entry.message.attachment.storageStatus === 'ready') {
      entry.message.attachment.storageStatus = 'expired';
      stateChanged = true;
    }
  }

  const orphanFiles = files
    .filter((file) => !protectedKeys.has(file.storageKey) && !messageEntries.some((entry) => entry.storageKey === file.storageKey))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);

  for (const orphan of orphanFiles) {
    if (totalBytes <= SOFT_LIMIT_BYTES && availableBytes >= MIN_FREE_BYTES) {
      break;
    }

    await fs.unlink(orphan.path).catch(() => null);
    totalBytes -= orphan.size;
    availableBytes += orphan.size;
  }

  for (const entry of messageEntries) {
    if (totalBytes <= SOFT_LIMIT_BYTES && availableBytes >= MIN_FREE_BYTES && totalBytes < HARD_LIMIT_BYTES) {
      break;
    }

    const file = fileMap.get(entry.storageKey);
    if (!file || entry.message.attachment.storageStatus !== 'ready') {
      continue;
    }

    const filePath = toStoragePath(entry.storageKey);
    if (!filePath) {
      continue;
    }

    await fs.unlink(filePath).catch(() => null);
    entry.message.attachment.storageStatus = 'expired';
    totalBytes -= file.size;
    availableBytes += file.size;
    stateChanged = true;
  }

  if (stateChanged) {
    await saveState(state);
  }

  console.log(JSON.stringify({
    ok: true,
    totalBytes,
    availableBytes,
    softLimitBytes: SOFT_LIMIT_BYTES,
    hardLimitBytes: HARD_LIMIT_BYTES,
    minFreeBytes: MIN_FREE_BYTES,
  }, null, 2));
}

main().catch((error) => {
  console.error('Media cleanup failed:', error);
  process.exit(1);
});
