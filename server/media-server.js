const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const MEDIA_PORT = Number(process.env.MEDIA_PORT || 4100);
const MEDIA_HOST = process.env.MEDIA_HOST || '0.0.0.0';
const MEDIA_UPLOAD_DIR = path.resolve(process.env.MEDIA_UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
const MEDIA_PUBLIC_BASE_URL = String(process.env.MEDIA_PUBLIC_BASE_URL || '').trim();
const MEDIA_SERVICE_TOKEN = String(process.env.MEDIA_SERVICE_TOKEN || '').trim();
const MAX_MEDIA_UPLOAD_BYTES = 75 * 1024 * 1024;

function sanitizeUploadFileName(fileName) {
  let normalizedName = String(fileName || 'file');

  try {
    normalizedName = decodeURIComponent(normalizedName);
  } catch {
    normalizedName = String(fileName || 'file');
  }

  const baseName = path.basename(normalizedName);
  return baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

function getFileExtension(fileName, mimeType) {
  const explicitExtension = path.extname(String(fileName || '')).slice(1).trim().toLowerCase();
  if (explicitExtension) {
    return explicitExtension.slice(0, 12);
  }

  const subtype = String(mimeType || '').split('/')[1] || 'bin';
  return subtype.split(';')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'bin';
}

function buildPublicUploadUrl(relativePath) {
  const normalized = `/uploads/${relativePath.replace(/\\/g, '/')}`;
  if (!MEDIA_PUBLIC_BASE_URL) {
    return normalized;
  }

  return `${MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}${normalized}`;
}

function requireMediaToken(req, res, next) {
  if (!MEDIA_SERVICE_TOKEN || req.headers['x-media-token'] !== MEDIA_SERVICE_TOKEN) {
    res.status(401).json({ error: 'Недостаточно прав' });
    return;
  }

  next();
}

async function storeUploadedMedia(buffer, fileName, mimeType) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const directory = path.join(MEDIA_UPLOAD_DIR, year, month);
  const safeFileName = sanitizeUploadFileName(fileName);
  const extension = getFileExtension(safeFileName, mimeType);
  const storageKey = path.posix.join(year, month, `${randomUUID()}.${extension}`);
  const filePath = path.join(directory, path.basename(storageKey));

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, buffer);

  return {
    fileName: safeFileName,
    mimeType,
    sizeBytes: buffer.length,
    fileUrl: buildPublicUploadUrl(storageKey),
    storageKey,
    storageKind: 'vps',
    storageStatus: 'ready',
    uploadedAt: now.toISOString(),
  };
}

function resolveStoragePath(storageKey) {
  const normalizedKey = String(storageKey || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const filePath = path.resolve(MEDIA_UPLOAD_DIR, normalizedKey);

  if (!filePath.startsWith(MEDIA_UPLOAD_DIR)) {
    return null;
  }

  return filePath;
}

async function main() {
  await fs.mkdir(MEDIA_UPLOAD_DIR, { recursive: true });

  const app = express();
  app.use('/uploads', express.static(MEDIA_UPLOAD_DIR, {
    fallthrough: false,
    index: false,
    maxAge: '7d',
  }));

  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/upload', requireMediaToken, express.raw({ type: '*/*', limit: `${MAX_MEDIA_UPLOAD_BYTES}b` }), async (req, res) => {
    const fileName = sanitizeUploadFileName(req.headers['x-file-name']);
    const mimeType = String(req.headers['content-type'] || 'application/octet-stream').trim() || 'application/octet-stream';

    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Пустой файл' });
      return;
    }

    try {
      const attachment = await storeUploadedMedia(req.body, fileName, mimeType);
      res.status(201).json({ attachment });
    } catch (error) {
      console.error('Failed to store uploaded media:', error);
      res.status(500).json({ error: 'Не удалось сохранить файл' });
    }
  });

  app.delete('/upload/:storageKey(*)', requireMediaToken, async (req, res) => {
    const filePath = resolveStoragePath(req.params.storageKey);
    if (!filePath) {
      res.status(400).json({ error: 'Некорректный storage key' });
      return;
    }

    try {
      await fs.unlink(filePath);
      res.status(200).json({ ok: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        res.status(200).json({ ok: true });
        return;
      }

      console.error('Failed to delete uploaded media:', error);
      res.status(500).json({ error: 'Не удалось удалить файл' });
    }
  });

  app.listen(MEDIA_PORT, MEDIA_HOST, () => {
    console.log(`Media server listening on ${MEDIA_HOST}:${MEDIA_PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start media server:', error);
  process.exit(1);
});
