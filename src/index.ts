import Discord from 'discord.js-selfbot-v13';
import dotenv from 'dotenv';
import { runMenu } from './cli';
import { renderHeader } from './branding';
import { TerminalInput } from './terminal';
import { rejectLongAssetWait } from './assets';
dotenv.config();
console.log(renderHeader(Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined));

const client = new Discord.Client({ partials: [], rejectOnRateLimit: rejectLongAssetWait,
  restRequestTimeout: 15000, retryLimit: 1, captchaRetryLimit: 0 });
const input = new TerminalInput();
let timeout: ReturnType<typeof setTimeout>;
function shutdown(code = 0) {
  clearTimeout(timeout);
  input.close();
  client.destroy();
  process.exitCode = code;
}
process.once('SIGINT', () => { shutdown(130); process.exit(130); });
process.once('SIGTERM', () => { shutdown(143); process.exit(143); });
client.on('error', () => console.error('Discord informó un error de conexión.'));
client.once('ready', () => {
  clearTimeout(timeout);
  console.log(`Conectado como ${client.user.username}.`);
  void runMenu(client, input).then(() => { process.exit(0); }).catch((error) => {
    console.error(error.message); shutdown(1); process.exit(1);
  });
});
async function login(token: string) {
  if (!token.trim()) { console.error('Token vacío. Configura TOKEN en .env.'); shutdown(1); return; }
  console.log('Conectando con Discord…');
  timeout = setTimeout(() => { console.error('La conexión tardó demasiado. Revisa la conexión y el token.'); shutdown(1); }, 60000);
  try { await client.login(token.trim()); }
  catch { console.error('No se pudo iniciar sesión. Revisa el token y la conexión.'); shutdown(1); }
}
if (process.env.TOKEN?.trim()) void login(process.env.TOKEN);
else if (!process.stdin.isTTY) { console.error('Configura TOKEN en .env o usa una terminal interactiva.'); shutdown(1); }
else {
  input.secretQuestion('Token de cuenta (*** · también puedes usar .env)', (token) => { void login(token); });
}
