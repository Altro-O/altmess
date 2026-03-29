import { promises as fs } from 'fs';
import path from 'path';

const STICKERS_DIR = path.join(process.cwd(), 'public', 'stickers');
const ALLOWED_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.webm']);

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

export async function GET() {
  const entries = await fs.readdir(STICKERS_DIR, { withFileTypes: true });
  const packs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => ({
      key: entry.name,
      title: entry.name.replace(/-raw$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      items: await listPackItems(path.join(STICKERS_DIR, entry.name), entry.name),
    })));

  return Response.json({ packs: packs.filter((pack) => pack.items.length > 0) });
}
