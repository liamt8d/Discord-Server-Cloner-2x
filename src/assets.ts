import { createHash } from 'node:crypto';
import type { BackupData, EmojiData } from './src/types';

export async function mapLimited<T, R>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await action(items[index], index);
    }
  }));
  return result;
}

// Abort the actual download, rather than leaving a timed-out request running.
export async function imageBytes(fetcher: typeof import('node-fetch').default, url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetcher(url, { signal: controller.signal, size: 8 * 1024 * 1024 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { clearTimeout(timeout); }
}
export function animatedEmoji(emoji: EmojiData): boolean {
  if (typeof emoji.animated === 'boolean') return emoji.animated;
  if (emoji.base64) return Buffer.from(emoji.base64, 'base64').subarray(0, 3).toString() === 'GIF';
  return /\.gif(?:\?|$)/i.test(emoji.url ?? '');
}
export function imageDataUri(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  const signature = bytes.subarray(0, 12);
  const mime = signature.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
    : signature[0] === 0x89 && signature.subarray(1, 4).toString() === 'PNG' ? 'image/png'
    : signature.subarray(0, 4).toString() === 'RIFF' && signature.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
    : signature[0] === 0xff && signature[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${base64}`;
}
export function emojiCapacity(guild: { premiumTier?: string | number; features?: readonly string[] }): number {
  const tier = typeof guild.premiumTier === 'number' ? guild.premiumTier : Number(guild.premiumTier?.replace('TIER_', '') ?? 0);
  return Math.max([50, 100, 150, 250][tier] ?? 50, guild.features?.includes('MORE_EMOJI') ? 200 : 0);
}
export function stickerCapacity(guild: { premiumTier?: string | number; features?: readonly string[] }): number {
  const tier = typeof guild.premiumTier === 'number' ? guild.premiumTier : Number(guild.premiumTier?.replace('TIER_', '') ?? 0);
  return Math.max([5, 15, 30, 60][tier] ?? 5, guild.features?.includes('MORE_STICKERS') ? 60 : 0);
}

// Only reuse an image when both snapshots have the same bytes, name and format.
// Matching names alone could silently keep the wrong picture.
export function planEmojiReuse(source: BackupData, destination: BackupData): Record<string, string> {
  const fingerprint = (emoji: EmojiData) => emoji.base64 && `${emoji.name}:${animatedEmoji(emoji)}:` +
    createHash('sha256').update(Buffer.from(emoji.base64, 'base64')).digest('hex');
  const available = new Map<string, string[]>();
  for (const emoji of destination.emojis) {
    const key = fingerprint(emoji);
    if (!key || !emoji.id || emoji.managed) continue;
    const ids = available.get(key) ?? [];
    ids.push(emoji.id); available.set(key, ids);
  }
  const result: Record<string, string> = {};
  for (const emoji of source.emojis) {
    const key = fingerprint(emoji);
    const target = key && available.get(key)?.shift();
    if (target && emoji.id) result[emoji.id] = target;
  }
  return result;
}

export function rejectLongAssetWait(data: { timeout: number; method: string; path: string; route?: string }): boolean {
  return data.timeout > 15000 && ['POST', 'PATCH'].includes(data.method.toUpperCase()) && /\/guilds\/[^/]+\/(emojis|stickers)(?:\/|$)/.test(data.path);
}
export function assetError(error: unknown): string {
  const value = error as { name?: string; timeout?: number; code?: number; message?: string };
  if (value?.name === 'RateLimitError') return value.timeout > 0
    ? `Discord pide esperar ${Math.ceil(value.timeout / 1000)} s; se aplazan los recursos pendientes para continuar la copia.`
    : 'Discord limitó las solicitudes sin indicar un plazo de espera; se aplazan las imágenes pendientes.';
  const reasons: Record<number, string> = {
    30008: 'El destino alcanzó su cupo de emojis de este tipo; los cupos estáticos y animados son independientes.',
    30039: 'El destino alcanzó su cupo de stickers.',
    50013: 'Faltan permisos para administrar este recurso en el destino.',
    50035: 'Discord rechazó el formato, tamaño o campos de este recurso.',
    50045: 'Discord rechazó el tamaño de la imagen.',
  };
  return value?.code ? `Discord ${value.code}: ${reasons[value.code] ?? value.message ?? 'Solicitud rechazada'}` : value?.message ?? String(error);
}
