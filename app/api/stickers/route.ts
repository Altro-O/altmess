import { promises as fs } from 'fs';
import path from 'path';

const STICKERS_DIR = path.join(process.cwd(), 'public', 'stickers');
const ALLOWED_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.webm']);
const DEFAULT_REMOTE_MANIFEST_URL = 'https://altro-o.github.io/altmess-stickers/manifest.json';
const REMOTE_MANIFEST_URL = process.env.STICKERS_MANIFEST_URL?.trim() || DEFAULT_REMOTE_MANIFEST_URL;
const REMOTE_MANIFEST_TTL_MS = 10 * 60 * 1000;
const API_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';

type StickerPack = {
  key: string;
  title: string;
  items: string[];
};

type StickerPackCacheEntry = {
  packs: StickerPack[];
  expiresAt: number;
};

let remoteStickerPackCache: StickerPackCacheEntry | null = null;
let remoteStickerPackRequest: Promise<StickerPack[]> | null = null;

function getPackTitle(packKey: string) {
  return packKey.replace(/-raw$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function toAbsoluteUrl(value: string, baseUrl?: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    if (!baseUrl) {
      return null;
    }

    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return null;
    }
  }
}

function normalizeRemotePacks(payload: unknown): StickerPack[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const packs = Array.isArray((payload as { packs?: unknown }).packs) ? (payload as { packs: unknown[] }).packs : [];
  const globalBaseUrl = typeof (payload as { baseUrl?: unknown }).baseUrl === 'string'
    ? (payload as { baseUrl: string }).baseUrl.trim()
    : '';

  return packs
    .map((pack) => {
      if (!pack || typeof pack !== 'object') {
        return null;
      }

      const key = typeof (pack as { key?: unknown }).key === 'string' ? (pack as { key: string }).key.trim() : '';
      if (!key) {
        return null;
      }

      const title = typeof (pack as { title?: unknown }).title === 'string' && (pack as { title: string }).title.trim()
        ? (pack as { title: string }).title.trim()
        : getPackTitle(key);
      const baseUrl = typeof (pack as { baseUrl?: unknown }).baseUrl === 'string' && (pack as { baseUrl: string }).baseUrl.trim()
        ? (pack as { baseUrl: string }).baseUrl.trim()
        : globalBaseUrl;
      const items = Array.isArray((pack as { items?: unknown }).items)
        ? (pack as { items: unknown[] }).items
          .filter((item): item is string => typeof item === 'string')
          .map((item) => toAbsoluteUrl(item, baseUrl))
          .filter((item): item is string => Boolean(item))
        : [];

      return { key, title, items };
    })
    .filter((pack): pack is StickerPack => Boolean(pack && pack.items.length > 0));
}

async function listPackItems(directory: string, packKey: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await listPackItems(entryPath, packKey);
      files.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      continue;
    }

    files.push(`/stickers/${packKey}/${path.relative(path.join(STICKERS_DIR, packKey), entryPath).replace(/\\/g, '/')}`);
  }

  return files.sort();
}

async function getLocalStickerPacks(): Promise<StickerPack[]> {
  try {
    const entries = await fs.readdir(STICKERS_DIR, { withFileTypes: true });
    const packs = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        key: entry.name,
        title: getPackTitle(entry.name),
        items: await listPackItems(path.join(STICKERS_DIR, entry.name), entry.name),
      })));

    return packs.filter((pack) => pack.items.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function getRemoteStickerPacks(): Promise<StickerPack[]> {
  if (!REMOTE_MANIFEST_URL) {
    return [];
  }

  const now = Date.now();
  if (remoteStickerPackCache && remoteStickerPackCache.expiresAt > now) {
    return remoteStickerPackCache.packs;
  }

  if (remoteStickerPackRequest) {
    return remoteStickerPackRequest;
  }

  remoteStickerPackRequest = (async () => {
    try {
      const response = await fetch(REMOTE_MANIFEST_URL, {
        headers: {
          'cache-control': 'no-cache',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to load sticker manifest: ${response.status}`);
      }

      const packs = normalizeRemotePacks(await response.json());
      remoteStickerPackCache = {
        packs,
        expiresAt: Date.now() + REMOTE_MANIFEST_TTL_MS,
      };

      return packs;
    } catch (error) {
      if (remoteStickerPackCache) {
        return remoteStickerPackCache.packs;
      }

      throw error;
    }
  })();

  try {
    return await remoteStickerPackRequest;
  } finally {
    remoteStickerPackRequest = null;
  }
}

export async function GET() {
  const remotePacks = await getRemoteStickerPacks().catch(() => []);
  if (remotePacks.length > 0) {
    return Response.json({ packs: remotePacks, source: 'remote' }, {
      headers: {
        'Cache-Control': API_CACHE_CONTROL,
      },
    });
  }

  const localPacks = await getLocalStickerPacks();
  return Response.json({ packs: localPacks, source: 'local' }, {
    headers: {
      'Cache-Control': API_CACHE_CONTROL,
    },
  });
}
