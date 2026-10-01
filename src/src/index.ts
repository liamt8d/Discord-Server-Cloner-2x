import type {
  BackupData,
  BackupInfos,
  CreateOptions,
  LoadOptions,
} from "./types/";
import type { Guild } from "discord.js-selfbot-v13";
import { SnowflakeUtil } from "discord.js-selfbot-v13";

import nodeFetch from "node-fetch";
import { imageBytes } from '../assets';
import { sep, resolve } from "path";

import {
  existsSync,
  mkdirSync,
  readdir,
  statSync,
  unlinkSync,
  writeFile,
  readFileSync,
} from "fs";
import { promisify } from "util";
const writeFileAsync = promisify(writeFile);
const readdirAsync = promisify(readdir);

import { captureCommunity, prepareCommunity, restoreCommunity } from "./community";
import * as createMaster from "./create";
import * as loadMaster from "./load";
import * as utilMaster from "./util";
export async function executeWithRetry(operation: () => any, retrytents2 = 3) {
  let retrytents = 0;
  while (retrytents < retrytents2) {
    try {
      await operation();
      return;
    } catch (error) {
      console.error(`Erro na clonagem (tentativa ${retrytents + 1}):`, error);
      retrytents++;
    }
  }
  throw new Error(`A clonagem falhou após ${retrytents2} tentativas`);
}
let cloner = resolve(__dirname, "../../backups");
if (!existsSync(cloner)) {
  mkdirSync(cloner, { recursive: true });
}

/**
 * Checks if a backup exists and returns its data
 */
const backupPath = (id: string) => {
  if (!/^\d+$/.test(id)) throw new Error("Invalid backup ID");
  return `${cloner}${sep}${id}.json`;
};
export function validateBackup(value: unknown): asserts value is BackupData {
  const data = value as BackupData;
  if (!data || typeof data.name !== 'string' || !data.name.trim() || typeof data.guildID !== 'string' ||
      !Array.isArray(data.roles) || !Array.isArray(data.emojis) || !Array.isArray(data.bans) ||
      !Array.isArray(data.channels?.categories) || !Array.isArray(data.channels?.others)) {
    throw new Error('El archivo no contiene un respaldo válido de servidor.');
  }
  for (const role of data.roles) {
    if (typeof role.name !== 'string' || !/^\d+$/.test(role.permissions)) throw new Error('El respaldo contiene un rol inválido.');
  }
  for (const category of data.channels.categories) {
    if (typeof category.name !== 'string' || !Array.isArray(category.children) || !Array.isArray(category.permissions)) {
      throw new Error('El respaldo contiene una categoría inválida.');
    }
  }
  for (const channel of [...data.channels.categories.flatMap((c) => c.children), ...data.channels.others]) {
    if (typeof channel.name !== 'string' || !channel.name.trim() || !['GUILD_TEXT','GUILD_NEWS','GUILD_VOICE','GUILD_STAGE_VOICE','GUILD_FORUM','GUILD_MEDIA'].includes(channel.type) || !Array.isArray(channel.permissions)) {
      throw new Error('El respaldo contiene un canal inválido.');
    }
  }
}
export const getBackupData = async (backupID: string): Promise<BackupData> => {
  let contents: string;
  try { contents = readFileSync(backupPath(backupID), 'utf-8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No existe el respaldo ${backupID}. Elige uno desde la lista de respaldos guardados.`);
    throw error;
  }
  const data = JSON.parse(contents);
  validateBackup(data);
  return data;
};

/**
 * Fetches a backyp and returns the information about it
 */
export const fetch = (backupID: string) => {
  return new Promise<BackupInfos>(async (resolve, reject) => {
    getBackupData(backupID)
      .then((backupData) => {
        const size = statSync(backupPath(backupID)).size;
        const backupInfos: BackupInfos = {
          data: backupData,
          id: backupID,
          size: Number((size / 1024).toFixed(2)),
        };
        resolve(backupInfos);
      })
      .catch(() => {
        reject("No found");
      });
  });
};

/**
 * Creates a new backup and saves it to the storage
 */

export const create = async (
  guild: Guild,
  options: CreateOptions = {
    backupID: null,
    maxMessagesPerChannel: 10,
    jsonSave: true,
    jsonBeautify: true,
    doNotBackup: [],
    saveImages: "",
  }
) => {
  const warnings: string[] = [];
  const onWarning = (message: string) => { warnings.push(message); options.onWarning?.(message); };
  const captureOptions = { ...options, onWarning };
  await guild.channels.fetch();
  await guild.roles.fetch();
  await guild.emojis.fetch();
  const backupData: BackupData = {
    purpose: options.purpose,
    excluded: options.doNotBackup ?? [], warnings,
    isCommunity: guild.features.includes('COMMUNITY'), description: guild.description,
    preferredLocale: guild.preferredLocale, premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
    systemChannelId: guild.systemChannelId ?? undefined, systemChannelFlags: guild.systemChannelFlags.bitfield.toString(),
    community: { rulesChannelId: guild.rulesChannelId ?? undefined,
      publicUpdatesChannelId: guild.publicUpdatesChannelId ?? undefined, safetyAlertsChannelId: guild.safetyAlertsChannelId ?? undefined },
    managedRoles: Array.from(guild.roles.cache.values()).filter((r) => r.managed).map((r) => ({
      id: r.id, botId: r.tags?.botId, premium: r.tags?.premiumSubscriberRole, name: r.name })),
    name: guild.name, verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    afkTimeout: guild.afkTimeout,
    afk: guild.afkChannel ? { channelId: guild.afkChannelId, name: guild.afkChannel.name, timeout: guild.afkTimeout } : null,
    widget: { known: typeof guild.widgetEnabled === 'boolean', enabled: guild.widgetEnabled ?? false, channelId: guild.widgetChannelId, channel: guild.widgetChannel?.name },
    channels: { categories: [], others: [] }, roles: [], bans: [], emojis: [],
    createdTimestamp: Date.now(), guildID: guild.id, id: options.backupID ?? SnowflakeUtil.generate(Date.now())
  };
  for (const kind of ['icon', 'splash', 'banner'] as const) {
    const url = kind === 'icon' ? guild.iconURL({ dynamic: true }) : kind === 'splash' ? guild.splashURL() : guild.bannerURL();
    if (!url) continue;
    backupData[`${kind}URL`] = url;
    if (options.saveImages === 'base64') {
      try {
        backupData[`${kind}Base64`] = (await imageBytes(nodeFetch, url)).toString('base64');
      } catch (error) { onWarning(`Imagen ${kind}: ${(error as Error).message}`); }
    }
  }
  if (!backupData.excluded.includes('roles')) backupData.roles = await createMaster.getRoles(guild);
  if (!backupData.excluded.includes('emojis')) backupData.emojis = await createMaster.getEmojis(guild, captureOptions);
  if (!backupData.excluded.includes('channels')) backupData.channels = await createMaster.getChannels(guild, captureOptions);
  if (options.includeCommunity) {
    try {
      const widget = await guild.fetchWidgetSettings();
      backupData.widget = { known: true, enabled: widget.enabled, channelId: widget.channel?.id, channel: widget.channel?.name };
    } catch (error) { onWarning(`Lectura de widget: ${utilMaster.errorReason(error)}`); }
  }
  if (options.includeCommunity) await captureCommunity(guild, backupData, captureOptions);
  if (options.jsonSave !== false) await writeFileAsync(backupPath(backupData.id),
    JSON.stringify(backupData, null, options.jsonBeautify ? 2 : undefined), 'utf-8');
  return backupData;
};

export async function validateDestination(backupData: BackupData, guild: Guild, options: LoadOptions) {
  if (!guild) throw new Error("Invalid guild");
  if (!options.restoreSnapshot && backupData.guildID === guild.id) throw new Error("Source and destination must be different guilds");
  const member = await guild.members.fetch(guild.client.user.id);
  if (guild.ownerId !== member.id && !member.permissions.has('ADMINISTRATOR')) {
    throw new Error("Se necesitan permisos de administrador en el destino");
  }
  const blockedRole = guild.roles.cache.find((r) => !r.managed && r.id !== guild.id && !r.editable);
  if (options.clearGuildBeforeRestore !== false && !backupData.excluded?.includes("roles") && blockedRole) {
    throw new Error(`El rol ${blockedRole.name} está por encima de la cuenta. Usa la cuenta propietaria del destino.`);
  }
  const allSource = [...(backupData.channels?.categories.flatMap((c) => c.children) ?? []), ...(backupData.channels?.others ?? [])];
  const sourceCount = (backupData.channels?.categories.length ?? 0) + allSource.length;
  const protectedIds = utilMaster.communityChannelIds(guild);
  let extraProtected = 0;
  for (const id of protectedIds) {
    const target = guild.channels.cache.get(id);
    const hasEquivalent = allSource.some((source) => source.type === 'GUILD_TEXT' && !(source as { nsfw?: boolean }).nsfw &&
      (source.name === target?.name || (['rulesChannelId', 'publicUpdatesChannelId', 'safetyAlertsChannelId'] as const).some((key) =>
        source.id && source.id === backupData.community?.[key] && guild[key] === id)));
    if (!hasEquivalent) extraProtected++;
  }
  if (sourceCount + extraProtected > 500) throw new Error('El destino superaría el límite de 500 canales de Discord.');
  const managed = guild.roles.cache.filter((r) => r.managed).size;
  if ((backupData.roles?.length ?? 0) + managed > 250) throw new Error('El destino superaría el límite de 250 roles de Discord (incluidos los roles de bots existentes).');

}

/**
 * Loads a backup for a guild
 */

export const load = async (
  backup: string | BackupData,
  guild: Guild,
  options: LoadOptions = {
    clearGuildBeforeRestore: true,
    maxMessagesPerChannel: 10,
  }
) => {
  const backupData: BackupData = typeof backup === "string" ? await getBackupData(backup) : backup;
  await validateDestination(backupData, guild, options);
  utilMaster.startChannelRestore(guild);
  utilMaster.emit(options, { kind: 'progress', feature: '1/8 · Preparar Comunidad' });
  await prepareCommunity(guild, backupData, options);
  utilMaster.emit(options, { kind: "progress", feature: "2/8 · Limpiar destino" });
  if (options.clearGuildBeforeRestore !== false) await utilMaster.clearGuild(guild, backupData.excluded ?? [], options);
  utilMaster.emit(options, { kind: 'progress', feature: '3/8 · Ajustes y roles' });
  await loadMaster.loadConfig(guild, backupData, options);
  await loadMaster.loadRoles(guild, backupData, options);
  utilMaster.emit(options, { kind: 'progress', feature: '4/8 · Crear canales' });
  await loadMaster.loadChannels(guild, backupData, { ...options, deferForumEmojis: true });
  utilMaster.emit(options, { kind: 'progress', feature: '5/8 · Emojis' });
  await loadMaster.loadEmojis(guild, backupData, options);
  utilMaster.emit(options, { kind: 'progress', feature: '6/8 · Etiquetas y canales especiales' });
  for (const data of [...backupData.channels?.categories.flatMap((c) => c.children) ?? [], ...backupData.channels?.others ?? []]) {
    if (data.type === 'GUILD_FORUM' || data.type === 'GUILD_MEDIA') await utilMaster.restoreForumEmojis(guild, data as import('./types').ForumChannelData, options);
  }
  for (const [feature, restore] of [['AFK', loadMaster.loadAFK], ['widget', loadMaster.loadEmbedChannel]] as const) {
    try { await restore(guild, backupData); }
    catch (error) { utilMaster.emit(options, { kind: 'failed', feature, reason: utilMaster.errorReason(error) }); }
  }
  utilMaster.emit(options, { kind: 'progress', feature: '7/8 · AutoMod, stickers y Comunidad' });
  await restoreCommunity(guild, backupData, options);
  utilMaster.emit(options, { kind: 'progress', feature: '8/8 · Terminado' });
  return backupData;
};

/**
 * Removes a backup
 */
export const remove = async (backupID: string) => {
  return new Promise<void>((resolve, reject) => {
    try {
      unlinkSync(backupPath(backupID));
      resolve();
    } catch (error) {
      reject("Not found");
    }
  });
};

/**
 * Returns the list of all backup
 */
export const list = async () => {
  const files = await readdirAsync(cloner); // Read "cloner" directory
  return files.map((f) => f.split(".")[0]);
};

/**
 * Change the storage path
 */
export const setStorageFolder = (path: string) => {
  if (path.endsWith(sep)) {
    path = path.substr(0, path.length - 1);
  }
  cloner = path;
  if (!existsSync(cloner)) {
    mkdirSync(cloner, { recursive: true });
  }
};

export const storageFolder = () => cloner;

export default {
  create,
  fetch,
  list,
  load,
  remove,
};
