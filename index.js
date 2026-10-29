import { Client } from 'discord.js-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';

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

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
process.on('SIGTERM', async () => { await stopStream(); process.exit(0); });

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

  await streamer.joinVoice(channel.guildId, channel.id);

  const { command, output } = prepareStream(source, {
    width: Number(VIDEO_WIDTH),
    height: Number(VIDEO_HEIGHT),
    frameRate: Number(VIDEO_FPS),
    bitrateVideo: Number(VIDEO_BITRATE),
    videoCodec: Utils.normalizeVideoCodec('H264'),
  });
  command.on('error', (e) => console.error('ffmpeg:', e.message));
  current = { command };

  playStream(output, streamer, { type: 'go-live' })
    .catch((e) => console.error('playStream:', e))
    .finally(() => { if (current?.command === command) stopStream(); });
}

streamer.client.on('ready', () => {
  console.log(`Login sebagai ${streamer.client.user.tag}`);
});

streamer.client.on('messageCreate', async (msg) => {
  if (msg.channel.type !== 'DM') return;                  // hanya DM
  if (msg.author.id === streamer.client.user.id) return;  // abaikan pesan akun ini sendiri

  const [cmd, url, chanArg] = msg.content.trim().split(/\s+/);

  try {
    if (cmd === ',play') {
      if (!/^https?:\/\//i.test(url ?? '')) return msg.reply('Pakai: `,play <link video> [channelId]`');
      const channelId = chanArg ?? DEFAULT_CHANNEL_ID;
      if (!channelId) return msg.reply('Isi DEFAULT_CHANNEL_ID di Variables, atau tulis channelId di command.');
      await startStream(url, channelId);
      await msg.reply('▶️ Mulai streaming.');
    } else if (cmd === ',stop') {
      await stopStream();
      await msg.reply('⏹️ Berhenti.');
    }
  } catch (e) {
    console.error(e);
    msg.reply(`❌ ${e.message}`).catch(() => {});
  }
});

await streamer.client.login(USER_TOKEN);
