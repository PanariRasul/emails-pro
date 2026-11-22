import { prisma } from '../lib/prisma.js';
import { caches } from '../lib/cache.js';

export async function getSettings() {
  return caches.settings.wrap('system', async () => {
    const existing = await prisma.systemSettings.findUnique({ where: { id: 1 } });
    if (existing) return existing;
    return prisma.systemSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  });
}

export async function updateSettings(data) {
  const s = await prisma.systemSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  caches.settings.clear();
  return s;
}
