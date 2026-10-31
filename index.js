import { Client } from 'discord.js-selfbot-v13';
import WebSocket from 'ws';

const {
  USER_TOKEN,
  DEFAULT_CHANNEL_ID,
  LAVALINK_HOST = 'localhost',
  LAVALINK_PORT = '2333',
  LAVALINK_PASSWORD,
  LAVALINK_SECURE,
} = process.env;

if (!USER_TOKEN || !LAVALINK_PASSWORD) {
  console.error('USER_TOKEN dan LAVALINK_PASSWORD wajib diisi di Variables Railway.');
  process.exit(1);
}

// urutan pencarian: ytmsearch (YouTube Music), ytsearch (YouTube), scsearch (SoundCloud)
const SEARCH_ORDER = (process.env.SEARCH_ORDER || 'ytmsearch,ytsearch,scsearch')
  .split(',').map((s) => s.trim()).filter(Boolean);

const secure = LAVALINK_SECURE === 'true';
const hostPort = LAVALINK_PORT ? `${LAVALINK_HOST}:${LAVALINK_PORT}` : LAVALINK_HOST;
const HTTP_BASE = `${secure ? 'https' : 'http'}://${hostPort}`;
const WS_BASE = `${secure ? 'wss' : 'ws'}://${hostPort}`;

const MAX_QUEUE = 100;
const MAX_PLAYLIST = 50;

const client = new Client();

const state = {
  queue: [],       // item: { title, author, encoded, uri }
  current: null,
  loop: 'off',     // off | track | queue
  volume: 1,       // 1 = 100%
  startedAt: 0,
  skipFlag: false,
  notify: null,    // DM channel untuk pengumuman pergantian lagu
};

// data voice yang diteruskan ke Lavalink
const voice = { guildId: null, channelId: null, sessionId: null, token: null, endpoint: null, pushed: false };

let ws = null;
let lavaSession = null;
let reconnectTimer = null;

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// ---------- util ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms, message) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(250);
  }
  throw new Error(message);
}

function say(text) {
  state.notify?.send(text).catch(() => {});
}

function findUserVoiceChannelId(userId) {
  for (const guild of client.guilds.cache.values()) {
    const vs = guild.voiceStates?.cache.get(userId);
    if (vs?.channelId) return vs.channelId;
  }
  return null;
}

// ---------- Lavalink: REST ----------
async function lava(method, path, body) {
  const r = await fetch(`${HTTP_BASE}${path}`, {
    method,
    headers: { Authorization: LAVALINK_PASSWORD, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`Lavalink ${r.status}: ${data?.message || text.slice(0, 200)}`);
  return data;
}

const playerPath = () => `/v4/sessions/${lavaSession}/players/${voice.guildId}`;

async function patchPlayer(body) {
  await waitFor(() => lavaSession, 15000, 'Lavalink belum tersambung (cek log [lavalink]).');
  return lava('PATCH', playerPath(), body);
}

// ---------- Lavalink: WebSocket ----------
function connectLavalink() {
  clearTimeout(reconnectTimer);
  try { ws?.removeAllListeners(); ws?.terminate(); } catch {}

  ws = new WebSocket(`${WS_BASE}/v4/websocket`, {
    headers: {
      Authorization: LAVALINK_PASSWORD,
      'User-Id': client.user.id,
      'Client-Name': 'selfbot-lavalink/1.0',
    },
  });

  ws.on('open', () => console.log('[lavalink] websocket terhubung'));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    handleLavalink(m).catch((e) => console.error('[lavalink handler]', e));
  });

  ws.on('error', (e) => {
    const detail =
      e.message ||
      e.code ||
      (e.errors || []).map((x) => `${x.code}@${x.address}:${x.port}`).join(', ') ||
      String(e);
    console.error('[lavalink] error:', detail);
  });

  ws.on('close', (code, reason) => {
    console.error('[lavalink] websocket putus, kode', code, String(reason || ''), '-> coba lagi 5 detik');
    lavaSession = null;
    voice.pushed = false;
    reconnectTimer = setTimeout(connectLavalink, 5000);
  });
}

async function handleLavalink(m) {
  if (m.op === 'ready') {
    lavaSession = m.sessionId;
    console.log('[lavalink] siap, session', lavaSession);
    // setelah reconnect: kirim ulang data voice dan lanjutkan lagu yang tadi diputar
    if (voice.guildId) {
      await pushVoice().catch((e) => console.error('[voice push]', e.message));
      if (state.current) await startTrack(state.current).catch((e) => console.error('[resume]', e.message));
    }
    return;
  }
  if (m.op !== 'event') return;

  switch (m.type) {
    case 'TrackEndEvent':
      await onTrackEnd(m.reason);
      break;
    case 'TrackExceptionEvent':
      console.error('[track error]', m.exception?.message, m.exception?.cause);
      break;
    case 'TrackStuckEvent':
      console.error('[track stuck]', state.current?.title);
      if (state.current) {
        state.skipFlag = true;
        await patchPlayer({ track: { encoded: null } }).catch(() => {});
      }
      break;
    case 'WebSocketClosedEvent':
      console.error('[voice ditutup oleh Discord]', m.code, m.reason);
      break;
  }
}

// ---------- voice (jembatan selfbot -> Lavalink) ----------
function sendGateway(guildId, payload) {
  const guild = client.guilds.cache.get(guildId);
  if (guild?.shard?.send) return guild.shard.send(payload);
  if (client.ws?.broadcast) return client.ws.broadcast(payload);
  throw new Error('Tidak bisa mengirim voice state ke gateway (API library berbeda).');
}

async function pushVoice() {
  const { guildId, channelId, sessionId, token, endpoint } = voice;
  const missing = [];
  if (!lavaSession) missing.push('lavalinkSession');
  if (!guildId) missing.push('guildId');
  if (!channelId) missing.push('channelId');
  if (!sessionId) missing.push('voiceSessionId');
  if (!token) missing.push('voiceToken');
  if (!endpoint) missing.push('voiceEndpoint');
  if (missing.length) {
    console.log('[voice] menunggu:', missing.join(', '));
    return;
  }
  await lava('PATCH', `/v4/sessions/${lavaSession}/players/${guildId}`, {
    voice: { token, endpoint, sessionId, channelId },
  });
  voice.pushed = true;
  console.log('[voice] data voice dikirim ke Lavalink');
}

client.on('raw', (p) => {
  if (!p?.t || !p.d) return;

  if (p.t === 'VOICE_STATE_UPDATE' && p.d.user_id === client.user.id) {
    console.log(`[raw] VOICE_STATE_UPDATE channel=${p.d.channel_id} guild=${p.d.guild_id}`);
    if (p.d.channel_id) {
      voice.sessionId = p.d.session_id;
      pushVoice().catch((e) => console.error('[voice push]', e.message));
    } else if (voice.guildId && voice.pushed) {
      // ditendang / diputus setelah sempat tersambung
      console.log('[voice] terputus dari voice channel');
      forcedLeave();
    }
  }

  if (p.t === 'VOICE_SERVER_UPDATE') {
    console.log(`[raw] VOICE_SERVER_UPDATE guild=${p.d.guild_id} endpoint=${p.d.endpoint}`);
    if (p.d.guild_id === voice.guildId) {
      voice.token = p.d.token;
      voice.endpoint = p.d.endpoint;
      pushVoice().catch((e) => console.error('[voice push]', e.message));
    }
  }
});

async function joinChannel(channel) {
  if (voice.guildId === channel.guildId && voice.channelId === channel.id && voice.pushed) return;
  if (voice.guildId) await leaveChannel();

  Object.assign(voice, { guildId: channel.guildId, channelId: channel.id, token: null, endpoint: null, pushed: false });
  sendGateway(channel.guildId, {
    op: 4,
    d: { guild_id: channel.guildId, channel_id: channel.id, self_mute: false, self_deaf: false },
  });
  try {
    await waitFor(() => voice.pushed, 20000, 'Voice tidak tersambung dalam 20 detik (cek log [voice] dan [lavalink]).');
  } catch (e) {
    console.error('[join] timeout. status:', JSON.stringify({
      lavalinkSiap: Boolean(lavaSession),
      voiceSessionId: Boolean(voice.sessionId),
      voiceToken: Boolean(voice.token),
      voiceEndpoint: voice.endpoint,
    }));
    await leaveChannel();
    throw e;
  }
}

async function leaveChannel() {
  const g = voice.guildId;
  if (!g) return;
  try { if (lavaSession) await lava('DELETE', `/v4/sessions/${lavaSession}/players/${g}`); } catch {}
  try { sendGateway(g, { op: 4, d: { guild_id: g, channel_id: null, self_mute: false, self_deaf: false } }); } catch {}
  Object.assign(voice, { guildId: null, channelId: null, token: null, endpoint: null, pushed: false });
}

function forcedLeave() {
  Object.assign(voice, { guildId: null, channelId: null, token: null, endpoint: null, pushed: false });
  state.queue = [];
  state.current = null;
  say('⚠️ Bot terputus dari voice channel.');
}

// ---------- pencarian lagu ----------
async function loadTracks(identifier) {
  const r = await lava('GET', `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
  if (r.loadType === 'track') return [r.data];
  if (r.loadType === 'search') return r.data.slice(0, 1);
  if (r.loadType === 'playlist') return r.data.tracks.slice(0, MAX_PLAYLIST);
  if (r.loadType === 'error') throw new Error(r.data?.message || 'gagal memuat');
  return []; // empty
}

const toItem = (t) => ({ title: t.info.title, author: t.info.author, encoded: t.encoded, uri: t.info.uri });

// input = judul lagu ATAU link (video / playlist)
async function resolve(input) {
  const isUrl = /^https?:\/\//i.test(input);
  const ids = isUrl ? [input] : SEARCH_ORDER.map((p) => `${p}:${input}`);

  let lastErr;
  for (const id of ids) {
    try {
      const tracks = await loadTracks(id);
      if (tracks.length) return tracks.map(toItem);
      console.log(`[search] ${id} -> kosong`);
    } catch (e) {
      lastErr = e;
      console.error(`[search] ${id} -> ${e.message}`);
    }
  }
  throw new Error(lastErr ? `Gagal memuat lagu: ${lastErr.message}` : `Lagu "${input}" tidak ditemukan. Coba tambahkan nama artis.`);
}

// ---------- pemutaran ----------
async function startTrack(item) {
  state.current = item;
  state.startedAt = Date.now();
  try {
    await patchPlayer({ track: { encoded: item.encoded }, volume: Math.round(state.volume * 100), paused: false });
  } catch (e) {
    state.current = null;
    throw e;
  }
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
  say('⏹️ Antrean habis. Bot tetap di voice (`,leave` untuk keluar).');
}

async function onTrackEnd(reason) {
  if (!state.current) return;                           // sudah di-stop manual
  if (reason === 'replaced' || reason === 'cleanup') return;

  const ended = state.current;
  const skipped = state.skipFlag;
  state.skipFlag = false;
  const failed = reason === 'loadFailed' || (!skipped && Date.now() - state.startedAt < 3000);

  let next;
  if (state.loop === 'track' && !skipped && !failed) {
    next = ended;
  } else {
    if (state.loop === 'queue' && !failed) state.queue.push(ended);
    next = state.queue.shift() ?? null;
  }
  await advance(next, true);
}

async function clearAll() {
  state.queue = [];
  state.current = null;
  state.skipFlag = false;
  if (voice.guildId) await patchPlayer({ track: { encoded: null } }).catch(() => {});
}

// ---------- command ----------
const LOOP_LABEL = { off: 'mati', track: 'lagu ini', queue: 'seluruh antrean' };

client.once('ready', () => {
  console.log(`Login sebagai ${client.user.tag} | Lavalink: ${HTTP_BASE} | sumber: ${SEARCH_ORDER.join(', ')}`);
  connectLavalink();
});

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
        const channelId = userChannelId ?? voice.channelId ?? DEFAULT_CHANNEL_ID;
        console.log(`[play] user=${msg.author.tag} userChannel=${userChannelId} pakai=${channelId}`);
        if (!channelId) {
          return msg.reply('Kamu belum ada di voice channel (di server yang sama dengan akun ini). Masuk voice dulu, lalu `,play` lagi.');
        }
        if (state.queue.length >= MAX_QUEUE) return msg.reply(`Antrean penuh (maks ${MAX_QUEUE}).`);

        const items = await resolve(arg);

        const channel = await client.channels.fetch(channelId);
        if (!channel?.guildId) throw new Error('Channel tidak ditemukan atau bukan voice channel server.');
        const perms = channel.permissionsFor?.(client.user);
        console.log(`[join] ${channel.name} connect=${perms?.has('CONNECT')} speak=${perms?.has('SPEAK')} userLimit=${channel.userLimit}`);
        await joinChannel(channel);

        if (!state.current) {
          const first = items.shift();
          state.queue.push(...items);
          await startTrack(first);
          await msg.reply(`▶️ Memutar: ${first.title}${first.author ? ` — ${first.author}` : ''}\n🔊 Di: ${channel.name}${items.length ? `\n➕ +${items.length} lagu ke antrean` : ''}`);
        } else {
          state.queue.push(...items);
          await msg.reply(items.length > 1
            ? `➕ ${items.length} lagu ditambahkan ke antrean.`
            : `➕ Ditambahkan ke antrean #${state.queue.length}: ${items[0].title}`);
        }
        break;
      }

      case ',skip':
      case ',s': {
        if (!state.current) return msg.reply('Tidak ada lagu yang sedang diputar.');
        const title = state.current.title;
        state.skipFlag = true;
        await patchPlayer({ track: { encoded: null } }); // memicu TrackEnd -> lagu berikutnya
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
          state.loop = state.loop === 'off' ? 'track' : state.loop === 'track' ? 'queue' :
