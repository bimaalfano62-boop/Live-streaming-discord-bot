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
import { writeFileSync } from 'node:fs';

const run = promisify(execFile);
const { USER_TOKEN, DEFAULT_CHANNEL_ID } = process.env;

if (!USER_TOKEN) {
  console.error('USER_TOKEN belum diisi di Variables Railway.');
  process.exit(1);
}

// ---------- konfigurasi opsional ----------
const SEARCH_SOURCE = (process.env.SEARCH_SOURCE || 'soundcloud').toLowerCase(); // soundcloud | youtube
const SEARCH_FALLBACK = (process.env.SEARCH_FALLBACK || '').toLowerCase();       // '' | youtube | soundcloud
const YT_PROXY = process.env.YT_PROXY || '';
const MAX_QUEUE = 100;
const URL_MAX_AGE = 20 * 60 * 1000; // refresh link kalau sudah > 20 menit di antrean

const COOKIES_PATH = '/tmp/yt-cookies.txt';
let hasCookies = false;
if (process.env.YT_COOKIES_B64) {
  try {
    writeFileSync(COOKIES_PATH, Buffer.from(process.env.YT_COOKIES_B64, 'base64'));
    hasCookies = true;
    console.log('[yt-dlp] cookies dimuat');
  } catch (e) {
    console.error('[yt-dlp] gagal menulis cookies:', e.message);
  }
}

const client = new Client();
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

const state = {
  queue: [],       // item: { title, pageUrl, streamUrl, resolvedAt, site, refresh }
  current: null,
  loop: 'off',     // off | track | queue
  volume: 1,       // 1 = 100%
  resource: null,
  startedAt: 0,
  skipFlag: false,
  guildId: null,
  channelId: null,
  notify: null,    // DM channel untuk pengumuman pergantian lagu
};

let ffmpeg = null;

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// ---------- pencarian / resolve ----------
function isYouTubeUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(h);
  } catch {
    return false;
  }
}

function isSoundCloudUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '').endsWith('soundcloud.com');
  } catch {
    return false;
  }
}

async function extract(target, site) {
  const args = ['--no-playlist', '-f', 'bestaudio/best'];
  if (site === 'youtube') {
    args.push('--js-runtimes', 'node');
    if (hasCookies) args.push('--cookies', COOKIES_PATH);
    if (YT_PROXY) args.push('--proxy', YT_PROXY);
  }
  args.push('--print', '%(title)s', '--print', '%(webpage_url)s', '--print', 'urls', target);

  console.log(`[yt-dlp] (${site}) ${target}`);
  const { stdout } = await run('yt-dlp', args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length < 3) throw new Error('hasil kosong');
  return {
    title: lines[0],
    pageUrl: lines[1],
    streamUrl: lines[lines.length - 1],
    resolvedAt: Date.now(),
    site,
    refresh: true,
  };
}

// input = judul lagu ATAU link
async function resolve(input) {
  const isUrl = /^https?:\/\//i.test(input);

  // link audio/video langsung (mp3, radio stream, dll)
  if (isUrl && !isYouTubeUrl(input) && !isSoundCloudUrl(input)) {
    return { title: input, pageUrl: input, streamUrl: input, resolvedAt: Date.now(), site: 'direct', refresh: false };
  }

  // link YouTube / SoundCloud
  if (isUrl) {
    const site = isYouTubeUrl(input) ? 'youtube' : 'soundcloud';
    try {
      return await extract(input, site);
    } catch (e) {
      console.error('[yt-dlp]', e.stderr || e.message);
      throw new Error('Gagal mengambil audio dari link itu (lihat log). Bisa diblokir atau tidak tersedia.');
    }
  }

  // judul lagu -> cari
  const order = [SEARCH_SOURCE];
  if (SEARCH_FALLBACK && SEARCH_FALLBACK !== SEARCH_SOURCE) order.push(SEARCH_FALLBACK);

  let lastErr;
  for (const site of order) {
    const prefix = site === 'youtube' ? 'ytsearch1' : 'scsearch1';
    try {
      return await extract(`${prefix}:${input}`, site);
    } catch (e) {
      lastErr = e;
      console.error(`[yt-dlp] ${site} gagal:`, (e.stderr || e.message || '').toString().split('\n').slice(-3).join(' | '));
    }
  }
  console.error('[resolve] semua sumber gagal', lastErr?.message);
  throw new Error(`Lagu "${input}" tidak ditemukan atau diblokir. Coba tambahkan nama artis.`);
}

async function freshStreamUrl(item) {
  if (item.refresh && Date.now() - item.resolvedAt > URL_MAX_AGE) {
    const r = await extract(item.pageUrl, item.site);
    item.streamUrl = r.streamUrl;
    item.resolvedAt = r.resolvedAt;
  }
  return item.streamUrl;
}

// ---------- util ----------
function killFfmpeg() {
  try { ffmpeg?.kill('SIGKILL'); } catch {}
  ffmpeg = null;
}

function say(text) {
  state.notify?.send(text).catch(() => {});
}

// ---------- voice ----------
async function ensureVoice(channel) {
  if (state.guildId && state.guildId !== channel.guildId) {
    try { getVoiceConnection(state.guildId)?.destroy(); } catch {}
  }

  let conn = getVoiceConnection(channel.guildId);
  const needNew =
    !conn ||
    conn.joinConfig.channelId !== channel.id ||
    conn.state.status === VoiceConnectionStatus.Destroyed;

  if (needNew) {
    try { conn?.destroy(); } catch {}
    const guildId = channel.guildId;
    conn = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    conn.on('stateChange', (o, n) => console.log(`[voice] ${o.status} -> ${n.status}`));
    conn.on('error', (e) => console.error('[voice error]', e));
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
        ]); // sedang pindah channel / reconnect
      } catch {
        try { conn.destroy(); } catch {}
      }
    });
    conn.on(VoiceConnectionStatus.Destroyed, () => {
      if (state.guildId === guildId) {
        state.guildId = null;
        state.channelId = null;
      }
    });
  }

  state.guildId = channel.guildId;
  state.channelId = channel.id;

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
  } catch {
    try { conn.destroy(); } catch {}
    state.guildId = null;
    state.channelId = null;
    throw new Error('Voice tidak tersambung dalam 20 detik (lihat log [voice]).');
  }
  conn.subscribe(player);
  console.log('[join] voice Ready');
}

// cari voice channel tempat user yang DM sedang berada
function findUserVoiceChannelId(userId) {
  for (const guild of client.guilds.cache.values()) {
    const vs = guild.voiceStates?.cache.get(userId);
    if (vs?.channelId) return vs.channelId;
  }
  return null;
}

// ---------- pemutaran ----------
async function startTrack(item) {
  const url = await freshStreamUrl(item);

  killFfmpeg();
  state.current = item;
  state.startedAt = Date.now();

  const ffArgs = ['-hide_banner', '-loglevel', 'warning'];
  if (YT_PROXY && item.site === 'youtube') ffArgs.push('-http_proxy', YT_PROXY);
  ffArgs.push(
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  );

  const proc = spawn('ffmpeg', ffArgs);
  ffmpeg = proc;
  proc.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  proc.stdout.on('error', () => {});
  proc.on('error', (e) => console.error('[ffmpeg start]', e.message));

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
  resource.volume?.setVolume(state.volume);
  state.resource = resource;
  player.play(resource);
  console.log(`[play] ${item.title}`);
}

async function advance(next, announce) {
  while (next) {
    try {
      await startTrack(next);
      if (announce) say(`▶️ Memutar: ${next.title}`);
      return;
    } catch (e) {
      console.error('[advance]', e.message);
      say(`⚠️ Dilewati (gagal): ${next.title}`);
      next = state.queue.shift() ?? null;
    }
  }
  state.current = null;
  state.resource = null;
  say('⏹️ Antrean habis. Bot tetap di voice (`,leave` untuk keluar).');
}

async function onTrackEnd() {
  const ended = state.current;
  const skipped = state.skipFlag;
  state.skipFlag = false;
  const failed = !skipped && Date.now() - state.startedAt < 3000; // lagu langsung mati = gagal

  let next;
  if (state.loop === 'track' && !skipped && !failed) {
    next = ended;
  } else {
    if (state.loop === 'queue' && !failed) state.queue.push(ended);
    next = state.queue.shift() ?? null;
  }
  await advance(next, true);
}

player.on('error', (e) => console.error('[player]', e.message));
player.on(AudioPlayerStatus.Idle, () => {
  killFfmpeg();
  if (!state.current) return; // sudah di-stop manual
  onTrackEnd().catch((e) => console.error('[onTrackEnd]', e));
});

function clearAll() {
  state.queue = [];
  state.current = null;
  state.resource = null;
  state.skipFlag = false;
  killFfmpeg();
  try { player.stop(true); } catch {}
}

// ---------- command ----------
const LOOP_LABEL = { off: 'mati', track: 'lagu ini', queue: 'seluruh antrean' };

client.on('ready', () => console.log(`Login sebagai ${client.user.tag} | sumber: ${SEARCH_SOURCE}${SEARCH_FALLBACK ? ` (+${SEARCH_FALLBACK})` : ''}`));

client.on('messageCreate', async (msg) => {
  console.log(`[msg] type=${msg.channel.type} from=${msg.author.tag} content=${msg.content}`);
  if (msg.channel.type !== 'DM') return;
  if (msg.author.id === client.user.id) return;

  const [rawCmd, ...rest] = msg.content.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ');

  const known = [',play', ',p', ',skip', ',s', ',queue', ',q', ',loop', ',volume', ',vol',
                 ',np', ',pause', ',resume', ',stop', ',leave'];
  if (!known.includes(cmd)) return;
  state.notify = msg.channel;

  try {
    switch (cmd) {
      case ',play':
      case ',p': {
        if (!arg) return msg.reply('Pakai: `,play <judul lagu>` contoh: `,play hindia rumah ke rumah`');

        const userChannelId = findUserVoiceChannelId(msg.author.id);
        const channelId = userChannelId ?? state.channelId ?? DEFAULT_CHANNEL_ID;
        console.log(`[play] user=${msg.author.tag} userChannel=${userChannelId} pakai=${channelId}`);
        if (!channelId) {
          return msg.reply('Kamu belum ada di voice channel (di server yang sama dengan akun ini). Masuk voice dulu, lalu `,play` lagi.');
        }
        if (state.queue.length >= MAX_QUEUE) return msg.reply(`Antrean penuh (maks ${MAX_QUEUE}).`);

        const item = await resolve(arg);

        const channel = await client.channels.fetch(channelId);
        if (!channel?.guildId) throw new Error('Channel tidak ditemukan atau bukan voice channel server.');
        const perms = channel.permissionsFor?.(client.user);
        console.log(`[join] ${channel.name} connect=${perms?.has('CONNECT')} speak=${perms?.has('SPEAK')} userLimit=${channel.userLimit}`);
        await ensureVoice(channel);

        if (!state.current) {
          await startTrack(item);
          await msg.reply(`▶️ Memutar: ${item.title}\n🔊 Di: ${channel.name}`);
        } else {
          state.queue.push(item);
          await msg.reply(`➕ Ditambahkan ke antrean #${state.queue.length}: ${item.title}`);
        }
        break;
      }

      case ',skip':
      case ',s': {
        if (!state.current) return msg.reply('Tidak ada lagu yang sedang diputar.');
        const title = state.current.title;
        state.skipFlag = true;
        player.stop(true); // memicu Idle -> lanjut lagu berikutnya
        await msg.reply(`⏭️ Dilewati: ${title}`);
        break;
      }

      case ',queue':
      case ',q': {
        if (!state.current && state.queue.length === 0) return msg.reply('Antrean kosong.');
        const lines = [];
        if (state.current) lines.push(`🎵 Sekarang: ${state.current.title}`);
        state.queue.slice(0, 10).forEach((it, i) => lines.push(`${i + 1}. ${it.title}`));
        if (state.queue.length > 10) lines.push(`...dan ${state.queue.length - 10} lagu lagi`);
        lines.push(`Loop: ${LOOP_LABEL[state.loop]} | Volume: ${Math.round(state.volume * 100)}%`);
        await msg.reply(lines.join('\n').slice(0, 1900));
        break;
      }

      case ',loop': {
        const a = arg.toLowerCase();
        const map = { off: 'off', mati: 'off', track: 'track', song: 'track', lagu: 'track', queue: 'queue', all: 'queue', antrean: 'queue' };
        if (a && !map[a]) return msg.reply('Pakai: `,loop off|track|queue` (tanpa argumen = ganti mode berurutan)');
        if (a) {
          state.loop = map[a];
        } else {
          state.loop = state.loop === 'off' ? 'track' : state.loop === 'track' ? 'queue' : 'off';
        }
        await msg.reply(`🔁 Loop: ${LOOP_LABEL[state.loop]}`);
        break;
      }

      case ',volume':
      case ',vol': {
        if (!arg) return msg.reply(`🔊 Volume: ${Math.round(state.volume * 100)}%`);
        const n = Number(arg.replace('%', ''));
        if (!Number.isFinite(n) || n < 0 || n > 200) return msg.reply('Pakai: `,volume <0-200>` (100 = normal)');
        state.volume = n / 100;
        state.resource?.volume?.setVolume(state.volume);
        await msg.reply(`🔊 Volume: ${n}%`);
        break;
      }

      case ',np': {
        if (!state.current) return msg.reply('Tidak ada lagu yang sedang diputar.');
        await msg.reply(`🎵 ${state.current.title}\nLoop: ${LOOP_LABEL[state.loop]} | Volume: ${Math.round(state.volume * 100)}% | Antrean: ${state.queue.length}`);
        break;
      }

      case ',pause':
        player.pause();
        await msg.reply('⏸️ Pause.');
        break;

      case ',resume':
        player.unpause();
        await msg.reply('▶️ Lanjut.');
        break;

      case ',stop':
        clearAll(); // bot TETAP di voice
        await msg.reply('⏹️ Dihentikan & antrean dikosongkan. Bot tetap di voice (`,leave` untuk keluar).');
        break;

      case ',leave':
        clearAll();
        if (state.guildId) {
          try { getVoiceConnection(state.guildId)?.destroy(); } catch {}
        }
        state.guildId = null;
        state.channelId = null;
        await msg.reply('👋 Keluar dari voice.');
        break;
    }
  } catch (e) {
    console.error('[error]', e);
    msg.reply(`❌ ${e.message}`).catch(() => {});
  }
});

await client.login(USER_TOKEN);
