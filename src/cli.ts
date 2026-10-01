import type { Client, Guild } from 'discord.js-selfbot-v13';
import type { QuestionInput } from './terminal';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import backup, { getBackupData, storageFolder, validateDestination } from './src/index';
import type { BackupData, CloneEvent, LoadOptions } from './src/types';
import { errorReason } from './src/util';
import { animatedEmoji, emojiCapacity, planEmojiReuse, stickerCapacity } from './assets';
import { ProgressDisplay, elapsedTime } from './progress';
import { normaliseRoleName } from './roles';

// Retained for callers of the library. The interactive copier always uses zero.
export function parseMessageLimit(value: string): number {
  if (!value.trim()) return 0;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < -1) throw new Error('Usa -1, 0 o un número entero positivo.');
  return limit;
}
export function validateGuildId(id: string): string {
  const value = id.trim();
  if (!/^\d{17,20}$/.test(value)) throw new Error('El ID debe contener entre 17 y 20 dígitos.');
  return value;
}
export function selectBackupId(answer: string, ids: string[]): string | undefined {
  const value = answer.trim();
  if (!value || value === '0') return undefined;
  if (ids.includes(value)) return value;
  if (/^\d+$/.test(value)) {
    const index = Number(value);
    if (Number.isSafeInteger(index) && index >= 1 && index <= ids.length) return ids[index - 1];
  }
  throw new Error('Selección no válida: elige un número de la lista o pega un ID guardado. 0 vuelve al menú.');
}
function stats(data: BackupData) {
  const channels = [...data.channels.categories.flatMap((c) => c.children), ...data.channels.others];
  const threads = channels.flatMap((c) => ('threads' in c ? c.threads ?? [] : []));
  const animated = data.emojis.filter(animatedEmoji).length;
  return `${data.roles.length} roles · ${data.channels.categories.length + channels.length} canales/categorías\n` +
    `${data.emojis.length - animated} emojis estáticos · ${animated} animados · ${data.stickers?.length ?? 0} stickers\n` +
    `${data.autoMod?.length ?? 0} AutoMod · ${threads.length} hilos · ${data.bans.length} baneos`;
}
export async function runMenu(client: Client<true>, input: QuestionInput) {
  const ui = new ProgressDisplay();
  const ask = (text: string) => { ui.stop(); return new Promise<string>((resolve) => input.question(text, (answer) => resolve(answer.trim()))); };
  const reportsFolder = resolve(storageFolder(), '../reports');
  mkdirSync(reportsFolder, { recursive: true });
  const savedBackups = async () => {
    ui.stop();
    const entries: { id: string; data: BackupData }[] = [];
    for (const id of (await backup.list()).filter((value) => /^\d+$/.test(value))) {
      try { entries.push({ id, data: await getBackupData(id) }); }
      catch { console.log(`! ${id}: respaldo ilegible; no se puede seleccionar.`); }
    }
    entries.sort((a, b) => (b.data.createdTimestamp ?? 0) - (a.data.createdTimestamp ?? 0) || b.id.localeCompare(a.id));
    if (!entries.length) console.log('Todavía no hay respaldos legibles.');
    for (const [index, entry] of entries.entries()) {
      const { data } = entry;
      const purpose = data.purpose === 'destination' ? 'destino previo' : data.purpose === 'source' ? 'copia del origen' : 'respaldo';
      const date = data.createdTimestamp ? new Date(data.createdTimestamp).toLocaleString('es-ES') : 'fecha desconocida';
      const channels = data.channels.categories.reduce((count, category) => count + 1 + category.children.length, 0) + data.channels.others.length;
      console.log(`\n${index + 1}) ${data.name} · ${purpose}\n   ${date} · ${data.roles.length} roles · ${channels} canales/categorías\n   ID: ${entry.id} · Servidor: ${data.guildID}`);
    }
    return entries;
  };
  const chooseSavedBackup = async () => {
    console.log('\nRESPALDOS GUARDADOS · más recientes primero');
    const entries = await savedBackups();
    if (!entries.length) return undefined;
    while (true) {
      try {
        const id = selectBackupId(await ask('Elige un número de esta lista o pega el ID\n0 / Enter: volver sin restaurar'), entries.map((entry) => entry.id));
        return id ? entries.find((entry) => entry.id === id).data : undefined;
      } catch (error) { console.log((error as Error).message); }
    }
  };
  while (true) {
    console.log('\n╭─ liam · ft8d ─────────────────────╮\n│  COPIAR COMUNIDAD · SIN MENSAJES  │\n╰─────────────────────────────────╯\n  1  Copiar a un servidor existente\n  2  Crear servidor y copiar\n  3  Restaurar un respaldo\n  4  Ver respaldos\n  0  Salir');
    const choice = (await ask('Elige una opción [1]')) || '1';
    if (choice === '0') { ui.stop(); input.close(); client.destroy(); return; }
    ui.reset();
    let reportFile: string;
    let targetBackupId: string;
    const events: CloneEvent[] = [];
    const started = Date.now();
    let lastReportWrite = 0;
    let operation: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'preparando', messageLimit: 0, limitations: [
      'Este menú no lee ni copia mensajes, tampoco al restaurar un respaldo antiguo.',
      'No se transfieren miembros, bots, integraciones, boosts ni propiedad.',
      'No se importan reacciones, historial de auditoría ni sesiones de voz.',
      'La guía avanzada del servidor, las invitaciones y la configuración externa de bots no se importan.',
      'Se conservan los baneos previos del destino y se añaden los del origen.',
      'El respaldo previo conserva estructura y ajustes; no recupera las conversaciones eliminadas.',
      'Las esperas de más de 15 s al subir nuevos emojis/stickers se aplazan sin eludir los límites de Discord.'
    ] };
    const saveReport = (force = true) => {
      if (reportFile && (force || Date.now() - lastReportWrite >= 1000)) {
        writeFileSync(reportFile, JSON.stringify({ ...operation, targetBackupId, events }, null, 2));
        lastReportWrite = Date.now();
      }
    };
    const onEvent = (event: CloneEvent) => {
      if (event.kind === 'progress') operation.phase = { feature: event.feature, current: event.current, total: event.total };
      else events.push(event);
      ui.event(event); saveReport(false);
    };
    const snapshot = async (guild: Guild, complete: boolean, purpose: 'source' | 'destination') => {
      ui.start(`Respaldar ${guild.name}`);
      return backup.create(guild, { purpose, maxMessagesPerChannel: 0, includeThreads: complete, includeCommunity: true,
        jsonSave: true, jsonBeautify: true, doNotBackup: complete ? [] : ['memberRoles'], saveImages: 'base64',
        onProgress: (message) => ui.update(message),
        onWarning: (reason) => onEvent({ kind: 'skipped', feature: 'lectura del respaldo', name: guild.name, reason }) });
    };
    const rateLimit = (data: { timeout: number }) => ui.rateLimit(data);
    client.on?.('rateLimit', rateLimit);
    try {
      if (choice === '4') {
        await savedBackups();
        continue;
      }
      if (!['1', '2', '3'].includes(choice)) { console.log('Opción no válida.'); continue; }
      reportFile = resolve(reportsFolder, `copia-${Date.now()}.json`); saveReport();
      let source: BackupData;
      let target: Guild;
      let complete = false;
      if (choice === '3') {
        source = await chooseSavedBackup();
        if (!source) { operation.status = 'cancelado'; saveReport(); continue; }
        console.log(`\nSeleccionado: ${source.name}\nServidor original: ${source.guildID}\n${stats(source)}`);
        for (const reason of source.warnings ?? []) onEvent({ kind: 'skipped', feature: 'omisión del respaldo original', reason });
        target = await client.guilds.fetch(validateGuildId(await ask('ID del servidor donde restaurarlo')));
        complete = Boolean(source.memberRoles || source.channels.categories.some((c) => c.children.some((ch) => 'threads' in ch && ch.threads?.length)) || source.channels.others.some((ch) => 'threads' in ch && ch.threads?.length));
      } else {
        const sourceId = validateGuildId(await ask('ID del servidor de origen'));
        const targetId = choice === '1' ? validateGuildId(await ask('ID del servidor de destino')) : undefined;
        if (sourceId === targetId) throw new Error('Origen y destino deben ser distintos.');
        console.log('\n  1  Rápido: estructura, AutoMod y recursos\n  2  Completo: añade hilos y roles de miembros presentes\n  Ambos modos omiten todos los mensajes.');
        const mode = (await ask('Modo de copia [1: rápido]')) || '1';
        if (!['1', '2'].includes(mode)) throw new Error('Elige 1 (rápido) o 2 (completo).');
        complete = mode === '2';
        operation.profile = complete ? 'completo sin mensajes' : 'rápido sin mensajes';
        const sourceGuild = await client.guilds.fetch(sourceId);
        source = await snapshot(sourceGuild, complete, 'source');
        if (targetId) target = await client.guilds.fetch(targetId);
        else {
          console.log(`\nOrigen: ${source.name}\n${stats(source)}`);
          if ((await ask('Crear un servidor nuevo? Escribe S para crearlo')).toLowerCase() !== 's') { operation.status = 'cancelado'; saveReport(); continue; }
          target = await client.guilds.create(source.name);
          console.log(`Servidor creado: ${target.name} · ${target.id}`);
        }
      }
      const options: LoadOptions = { clearGuildBeforeRestore: true, enableCommunity: true,
        restoreSnapshot: choice === '3', maxMessagesPerChannel: 0, allowedMentions: { parse: [] }, onEvent };
      operation = { ...operation, sourceId: source.guildID, targetId: target.id }; saveReport();
      await validateDestination(source, target, options);
      const targetBackup = await snapshot(target, complete, 'destination');
      targetBackupId = targetBackup.id;
      options.reuseEmojiIds = planEmojiReuse(source, targetBackup);
      ui.stop();
      console.log(`\n╭─ REVISAR COPIA ──────────────────╮\nOrigen: ${source.name}\nDestino: ${target.name}\n${stats(source)}\nHistorial: desactivado\n╰─────────────────────────────────╯`);
      console.log(`Emojis idénticos reutilizables: ${Object.keys(options.reuseEmojiIds).length}`);
      console.log(`Cupos del destino: ${emojiCapacity(target)} por tipo de emoji · ${stickerCapacity(target)} stickers`);
      console.log(`Respaldo previo: ${targetBackupId}`);
      const adjustedNames = source.roles.filter((role, index) => !role.isEveryone && normaliseRoleName(role.name, `rol-${index + 1}`).changed).length;
      if (adjustedNames) console.log(`${adjustedNames} nombres de roles vacíos/invisibles o largos se ajustarán para que Discord los acepte.`);
      console.log('Se reemplazarán canales, roles y recursos del destino.\nEl respaldo previo no incluye sus conversaciones.');
      if (source.warnings?.length || targetBackup.warnings?.length) console.log('Hay omisiones de lectura: detalles en el informe.');
      if ((await ask('Escribe CLONAR y pulsa Enter para iniciar\nEnter vacío cancela')).toUpperCase() !== 'CLONAR') {
        operation.status = 'cancelado'; saveReport(); console.log('Copia cancelada.'); continue;
      }
      operation.status = 'copiando'; saveReport();
      await backup.load(source, target, options);
      ui.stop();
      operation.status = events.some((e) => e.kind === 'failed' || e.kind === 'skipped') ? 'completado con omisiones' : 'completado';
      operation.finishedAt = new Date().toISOString(); saveReport();
      const totals = new Map<string, number>();
      for (const event of events.filter((e) => e.kind === 'copied')) totals.set(event.feature, (totals.get(event.feature) ?? 0) + (event.count ?? 1));
      console.log(`\n✓ ${String(operation.status).toUpperCase()} · ${elapsedTime(Date.now() - started)}`);
      for (const [feature, count] of totals) console.log(`  ${feature}: ${count}`);
      const omitted = events.filter((e) => e.kind === 'failed' || e.kind === 'skipped');
      console.log(`Omisiones/errores: ${omitted.length}\nInforme: ${reportFile}\nRespaldo del destino: ${targetBackupId}`);
    } catch (error) {
      ui.stop(); operation.status = 'interrumpido por error'; operation.error = errorReason(error); saveReport();
      console.error(`\nNo se completó la copia: ${errorReason(error)}`);
      if (targetBackupId) console.log(`Respaldo previo: ${targetBackupId}. Opción 3 para restaurar su estructura.`);
      if (reportFile) console.log(`Informe: ${reportFile}`);
    } finally { ui.stop(); client.off?.('rateLimit', rateLimit); }
  }
}
