import { Client } from 'discord.js-selfbot-v13';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { USER_TOKEN, DEFAULT_CHANNEL_ID } = process.env;

if (!USER_TOKEN) {
  console.error('USER_TOKEN belum diisi di Variables Railway.');
  process.exit(1);
}

const client = new Client();
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let ffmpeg = null;
let guildId = null;

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

player.on('error', (e) => console.error('[player]', e.message));
player.on(AudioPlayerStatus.Idle, () => console.log('[player] selesai / idle'));

// Cari voice channel tempat user sedang berada (di server yang sama dengan akun ini)
function findUserVoiceChannelId(userId) {
  for (const guild of client.guilds.cache.values()) {
    const vs = guild.voiceStates?.cache.get(userId);
    if (vs?.channelId) return vs.channelId;
  }
  return null;
}

// Link YouTube / judul lagu -> { title, url } (link audio langsung)
async function resolve(input) {
  const isUrl = /^https?:\/\//i.test(input);
  if (isUrl && !/(youtube\.com|youtu\.be)/i.test(input)) {
    return { title: input, url: input }; // link audio/video langsung
  }
  const target = isUrl ? input : `ytsearch1:${input}`;
  console.log('[yt-dlp] resolving', target);
  try {
    const { stdout } = await run(
      'yt-dlp',
      ['--no-playlist', '--js-runtimes', 'node', '-f', 'bestaudio/best',
       '--print', '%(title)s', '--print', 'urls', target],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('hasil kosong');
    return { title: lines[0], url: lines[lines.length - 1] };
  } catch (e) {
    console.error('[yt-dlp]', e.stderr || e.message);
    throw new Error('Gagal mengambil audio (lihat log). Bisa diblokir YouTube atau tidak ditemukan.');
  }
}

function killFfmpeg() {
  try { ffmpeg?.kill('SIGKILL'); } catch {}
  ffmpeg = null;
}

function stopAll() {
  killFfmpeg();
  try { player.stop(true); } catch {}
  if (guildId) {
    try { getVoiceConnection(guildId)?.destroy(); } catch {}
    guildId = null;
  }
}

async function play(input, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.guildId) throw new Error('Channel tidak ditemukan atau bukan voice channel server.');

  const perms = channel.permissionsFor?.(client.user);
  console.log(
    `[join] guild=${channel.guildId} channel=${channel.id} name=${channel.name} type=${channel.type}`,
    `connect=${perms?.has('CONNECT')} speak=${perms?.has('SPEAK')} userLimit=${channel.userLimit}`,
  );

  const { title, url } = await resolve(input);

  killFfmpeg();
  player.stop(true);

  // kalau sebelumnya ada di server lain, keluar dulu
  if (guildId && guildId !== channel.guildId) {
    try { getVoiceConnection(guildId)?.destroy(); } catch {}
  }

  let connection = getVoiceConnection(channel.guildId);
  if (!connection || connection.joinConfig.channelId !== channel.id) {
    connection?.destroy();
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on('stateChange', (o, n) => console.log(`[voice] ${o.status} -> ${n.status}`));
    connection.on('error', (e) => console.error('[voice error]', e));
  }
  guildId = channel.guildId;

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch {
    connection.destroy();
    guildId = null;
    throw new Error('Voice tidak tersambung dalam 20 detik (lihat log [voice]).');
  }
  console.log('[join] voice Ready');

  ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-vn', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    '-f', 'ogg', 'pipe:1',
  ]);
  ffmpeg.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  ffmpeg.on('error', (e) => console.error('[ffmpeg start]', e.message));

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
  connection.subscribe(player);

  return { title, channelName: channel.name };
}

client.on('ready', () => console.log(`Login sebagai ${client.user.tag}`));

client.on('messageCreate', async (msg) => {
  console.log(`[msg] type=${msg.channel.type} from=${msg.author.tag} content=${msg.content}`);
  if (msg.channel.type !== 'DM') return;
  if (msg.author.id === client.user.id) return;

  const [cmd, ...rest] = msg.content.trim().split(/\s+/);
  const arg = rest.join(' ');

  try {
    if (cmd === ',play') {
      if (!arg) return msg.reply('Pakai: `,play <link atau judul lagu>`');

      const userChannelId = findUserVoiceChannelId(msg.author.id);
      const channelId = userChannelId ?? DEFAULT_CHANNEL_ID;
      console.log(`[play] user=${msg.author.tag} userChannel=${userChannelId} pakai=${channelId}`);

      if (!channelId) {
        return msg.reply('Kamu belum ada di voice channel (di server yang sama dengan akun ini). Masuk voice dulu, lalu `,play` lagi.');
      }

      const { title, channelName } = await play(arg, channelId);
      await msg.reply(`▶️ Memutar: ${title}\n🔊 Di: ${channelName}`);
    } else if (cmd === ',pause') {
      player.pause();
      await msg.reply('⏸️ Pause.');
    } else if (cmd === ',resume') {
      player.unpause();
      await msg.reply('▶️ Lanjut.');
    } else if (cmd === ',stop') {
      stopAll();
      await msg.reply('⏹️ Berhenti.');
    }
  } catch (e) {
    console.error('[error]', e);
    msg.reply(`❌ ${e.message}`).catch(() => {});
  }
});

await client.login(USER_TOKEN);
