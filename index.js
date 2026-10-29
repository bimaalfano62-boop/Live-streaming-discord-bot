```javascript
import { Client } from 'discord.js-selfbot-v13';
import {
  Streamer,
  prepareStream,
  playStream,
  Utils,
} from '@dank074/discord-video-stream';

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
  console.error('[CONFIG] USER_TOKEN belum diisi.');
  process.exit(1);
}

const streamer = new Streamer(new Client());

let current = null;
let starting = false;

// ==================================================
// ERROR HANDLING
// ==================================================

process.on('unhandledRejection', (error) => {
  console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

// ==================================================
// ENVIRONMENT CHECK
// ==================================================

async function checkEnvironment() {
  console.log('[CHECK] Memeriksa FFmpeg...');

  try {
    const { stdout } = await run('ffmpeg', ['-version'], {
      timeout: 10000,
    });

    console.log('[CHECK] FFmpeg tersedia:', stdout.split('\n')[0]);
  } catch (error) {
    console.error('[CHECK] FFmpeg tidak tersedia:', error.message);
  }

  console.log('[CHECK] Memeriksa yt-dlp...');

  try {
    const { stdout } = await run('yt-dlp', ['--version'], {
      timeout: 10000,
    });

    console.log('[CHECK] yt-dlp tersedia:', stdout.trim());
  } catch (error) {
    console.error('[CHECK] yt-dlp tidak tersedia:', error.message);
  }
}

// ==================================================
// YOUTUBE DETECTION
// ==================================================

function isYouTube(url) {
  try {
    const hostname = new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, '');

    return [
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
    ].includes(hostname);
  } catch {
    return false;
  }
}

// ==================================================
// SOURCE RESOLVER
// ==================================================

async function resolveSource(url) {
  if (!isYouTube(url)) {
    return url;
  }

  console.log('[YT-DLP] Resolving YouTube URL...');

  try {
    const { stdout } = await run(
      'yt-dlp',
      [
        '--no-playlist',
        '--js-runtimes',
        'node',
        '-f',
        'b[height<=720]/b',
        '-g',
        url,
      ],
      {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );

    const direct = stdout.trim().split(/\r?\n/)[0];

    if (!direct) {
      throw new Error('URL video langsung tidak ditemukan.');
    }

    console.log('[YT-DLP] URL berhasil diperoleh.');

    return direct;
  } catch (error) {
    console.error(
      '[YT-DLP ERROR]',
      error.stderr || error.message,
    );

    throw new Error(
      'Gagal mengambil sumber YouTube. Periksa URL, pembatasan video, dan log yt-dlp.',
    );
  }
}

// ==================================================
// STOP STREAM
// ==================================================

async function stopStream() {
  const session = current;

  current = null;

  if (session?.command) {
    try {
      session.command.kill('SIGINT');
    } catch (error) {
      console.error('[STOP] Gagal menghentikan FFmpeg:', error.message);
    }
  }

  try {
    streamer.leaveVoice();
  } catch (error) {
    console.error('[STOP] Gagal keluar dari voice:', error.message);
  }

  console.log('[STOP] Proses penghentian selesai.');
}

// ==================================================
// START STREAM
// ==================================================

async function startStream(source, channelId) {
  if (starting) {
    throw new Error('Proses streaming lain sedang dimulai.');
  }

  starting = true;

  try {
    await stopStream();

    console.log('[JOIN] Mengambil channel:', channelId);

    const channel = await streamer.client.channels.fetch(channelId);

    if (!channel) {
      throw new Error('Channel tidak ditemukan.');
    }

    if (!channel.guildId) {
      throw new Error('Channel bukan voice channel di server.');
    }

    console.log('[JOIN] Channel ditemukan:', channel.name);
    console.log('[JOIN] Guild ID:', channel.guildId);
    console.log('[JOIN] Channel ID:', channel.id);

    const joined = streamer.joinVoice(
      channel.guildId,
      channel.id,
    );

    let timeoutId;

    try {
      await Promise.race([
        joined,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error('Timeout saat mencoba masuk voice channel.'),
            );
          }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    console.log('[JOIN] joinVoice selesai.');

    console.log('[SOURCE] Menyiapkan sumber video...');

    const direct = await resolveSource(source);

    console.log('[SOURCE] Sumber video berhasil disiapkan.');

    console.log('[FFMPEG] Menyiapkan stream...');

    const { command, output } = prepareStream(direct, {
      width: Number(VIDEO_WIDTH),
      height: Number(VIDEO_HEIGHT),
      frameRate: Number(VIDEO_FPS),
      bitrateVideo: Number(VIDEO_BITRATE),
      videoCodec: Utils.normalizeVideoCodec('H264'),
    });

    command.on('error', (error) => {
      console.error('[FFMPEG ERROR]', error.message);
    });

    command.on('close', (code, signal) => {
      console.log(
        `[FFMPEG] Proses berakhir. code=${code}, signal=${signal}`,
      );
    });

    current = {
      command,
      channelId,
    };

    console.log('[STREAM] Memulai playStream...');

    const session = current;

    // Tunggu hasil playStream supaya kegagalan bisa dilaporkan.
    const playback = playStream(output, streamer, {
      type: 'go-live',
    });

    playback
      .then(() => {
        console.log('[STREAM] playStream selesai.');
      })
      .catch((error) => {
        console.error('[STREAM ERROR]', error);
      })
      .finally(async () => {
        if (current === session) {
          await stopStream();
        }
      });

    console.log(
      '[STREAM] Proses streaming sudah dimulai, menunggu hasil playback.',
    );
  } finally {
    starting = false;
  }
}

// ==================================================
// DISCORD EVENTS
// ==================================================

streamer.client.on('ready', () => {
  console.log(
    `[READY] Login sebagai ${streamer.client.user.tag}`,
  );
});

streamer.client.on('messageCreate', async (msg) => {
  if (msg.author.id === streamer.client.user.id) {
    return;
  }

  if (msg.channel.type !== 'DM') {
    return;
  }

  console.log(
    `[MESSAGE] author=${msg.author.tag} content=${msg.content}`,
  );

  const args = msg.content.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();

  try {
    if (cmd === ',play') {
      const source = args[1];

      const channelId = args[2] || DEFAULT_CHANNEL_ID;

      if (!source || !/^https?:\/\//i.test(source)) {
        await msg.reply(
          'Gunakan: `,play <URL video> [channelId]`',
        );
        return;
      }

      if (!channelId) {
        await msg.reply(
          'Isi DEFAULT_CHANNEL_ID di Variables Railway atau sertakan channelId.',
        );
        return;
      }

      if (starting) {
        await msg.reply(
          'Proses streaming sedang disiapkan. Tunggu sebentar.',
        );
        return;
      }

      console.log(
        `[PLAY] source=${source} channel=${channelId}`,
      );

      await startStream(source, channelId);

      await msg.reply(
        '▶️ Proses streaming sudah dimulai. Periksa log jika video belum muncul.',
      );
    } else if (cmd === ',stop') {
      await stopStream();

      await msg.reply('⏹️ Permintaan penghentian diproses.');
    }
  } catch (error) {
    console.error('[COMMAND ERROR]', error);

    await msg.reply(
      `❌ ${error.message}`,
    ).catch(() => {});
  }
});

// ==================================================
// SHUTDOWN
// ==================================================

process.on('SIGTERM', async () => {
  console.log('[SYSTEM] SIGTERM diterima.');

  await stopStream();

  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SYSTEM] SIGINT diterima.');

  await stopStream();

  process.exit(0);
});

// ==================================================
// START APPLICATION
// ==================================================

await checkEnvironment();

console.log('[SYSTEM] Memulai login Discord...');

await streamer.client.login(USER_TOKEN);
```
