import { Client } from 'discord.js-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const {
  USER_TOKEN,
  DEFAULT_CHANNEL_ID,
  VIDEO_WIDTH = '854',
  VIDEO_HEIGHT = '480',
  VIDEO_FPS = '30',
  VIDEO_BITRATE = '1500',
} = process.env;

if (!USER_TOKEN) {
  console.error('USER_TOKEN belum diisi di Variables Railway.');
  process.exit(1);
}

const streamer = new Streamer(new Client());
let current = null; // { command }

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
process.on('SIGTERM', async () => { await stopStream(); process.exit(0); });

function isYouTube(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '');
    return h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com' || h === 'youtu.be';
  } catch {
    return false;
  }
}

// Ubah link YouTube jadi link video langsung (gabungan video+audio, max 720p)
async function resolveSource(url) {
  if (!isYouTube(url)) return url;
  console.log('[yt-dlp] resolving', url);
  try {
    const { stdout } = await run(
      'yt-dlp',
      [
        '--no-playlist',
        '--js-runtimes', 'node',
        '-f', 'b[height<=720]/b',
        '-g',
        url,
      ],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    const direct = stdout.trim().split('\n')[0];
    if (!direct) throw new Error('yt-dlp tidak mengembalikan link.');
    return direct;
  } catch (e) {
    console.error('[yt-dlp]', e.stderr || e.message);
    throw new Error('Gagal mengambil video YouTube (lihat log). Bisa karena diblokir YouTube atau video dibatasi.');
  }
}

async function stopStream() {
  if (!current) return;
  try { current.command.kill('SIGINT'); } catch {}
  try { streamer.leaveVoice(); } catch {}
  current = null;
}

async function startStream(source, channelId) {
  await stopStream();

  const channel = await streamer.client.channels.fetch(channelId);
  if (!channel?.guildId) throw new Error('Channel tidak ditemukan atau bukan voice channel server.');

  const perms = channel.permissionsFor?.(streamer.client.user);
  console.log(
    `[join] guild=${channel.guildId} channel=${channel.id} name=${channel.name} type=${channel.type}`,
    `connect=${perms?.has('CONNECT')} speak=${perms?.has('SPEAK')}`,
    `userLimit=${channel.userLimit} members=${channel.members?.size}`,
  );

  const joined = streamer.joinVoice(channel.guildId, channel.id);
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('joinVoice timeout 20 detik (voice tidak tersambung).')), 20000),
  );
  await Promise.race([joined, timeout]);
  console.log('[join] joinVoice selesai');

  const direct = await resolveSource(source);

  const { command, output } = prepareStream(direct, {
    width: Number(VIDEO_WIDTH),
    height: Number(VIDEO_HEIGHT),
    frameRate: Number(VIDEO_FPS),
    bitrateVideo: Number(VIDEO_BITRATE),
    videoCodec: Utils.normalizeVideoCodec('H264'),
  });
  command.on('error', (e) => console.error('[ffmpeg]', e.message));
  current = { command };

  playStream(output, streamer, { type: 'go-live' })
    .then(() => console.log('[stream] selesai diputar'))
    .catch((e) => console.error('[playStream]', e))
    .finally(() => { if (current?.command === command) stopStream(); });
}

streamer.client.on('ready', () => {
  console.log(`Login sebagai ${streamer.client.user.tag}`);
});

streamer.client.on('messageCreate', async (msg) => {
  console.log(`[msg] type=${msg.channel.type} from=${msg.author.tag} content=${msg.content}`);

  if (msg.channel.type !== 'DM') return;
  if (msg.author.id === streamer.client.user.id) return;

  const [cmd, url, chanArg] = msg.content.trim().split(/\s+/);

  try {
    if (cmd === ',play') {
      if (!/^https?:\/\//i.test(url ?? '')) return msg.reply('Pakai: `,play <link video/YouTube> [channelId]`');
      const channelId = chanArg ?? DEFAULT_CHANNEL_ID;
      console.log(`[play] url=${url} channel=${channelId}`);
      if (!channelId) return msg.reply('Isi DEFAULT_CHANNEL_ID di Variables, atau tulis channelId di command.');
      await startStream(url, channelId);
      console.log('[play] joinVoice + playStream dipanggil');
      await msg.reply('▶️ Mulai streaming.');
    } else if (cmd === ',stop') {
      await stopStream();
      await msg.reply('⏹️ Berhenti.');
    }
  } catch (e) {
    console.error('[error]', e);
    msg.reply(`❌ ${e.message}`).catch(() => {});
  }
});

await streamer.client.login(USER_TOKEN);
