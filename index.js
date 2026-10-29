import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  createAudioPlayer,
  createStreamResource,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName('stream')
    .setDescription('Stream a video file or direct URL into your voice channel')
    .addStringOption((o) =>
      o.setName('source').setDescription('Local file path or direct video URL (.mp4/.webm/.m3u8)').setRequired(true),
    ),
  new SlashCommandBuilder().setName('screen').setDescription("Share this machine's screen into your voice channel"),
  new SlashCommandBuilder().setName('stop').setDescription('Stop streaming and leave'),
].map((c) => c.toJSON());

let session = null; // { connection, player, ffmpeg }

function stopSession() {
  if (!session) return;
  try { session.ffmpeg?.kill('SIGKILL'); } catch {}
  try { session.player.stop(true); } catch {}
  try { session.connection.destroy(); } catch {}
  session = null;
}

function buildFfmpegArgs(source) {
  const args = ['-hide_banner', '-loglevel', 'warning'];

  if (source === '__screen__') {
    // ---- video input: capture this machine's screen ----
    if (process.platform === 'win32') {
      args.push('-f', 'gdigrab', '-framerate', '30');
      if (process.env.SCREEN_SIZE) args.push('-video_size', process.env.SCREEN_SIZE); // e.g. 1920x1080
      args.push('-i', 'desktop');
    } else if (process.platform === 'darwin') {
      // list devices with: ffmpeg -f avfoundation -list_devices true -i ""
      args.push('-f', 'avfoundation', '-framerate', '30', '-i', process.env.SCREEN_INPUT ?? '1:none');
    } else {
      args.push('-f', 'x11grab', '-framerate', '30');
      if (process.env.SCREEN_SIZE) args.push('-video_size', process.env.SCREEN_SIZE);
      args.push('-i', process.env.SCREEN_INPUT ?? ':0.0');
    }
    // ---- audio input: real audio if configured, otherwise a silent track ----
    if (process.env.AUDIO_SOURCE) {
      args.push('-f', process.env.AUDIO_FORMAT ?? 'dshow', '-i', process.env.AUDIO_SOURCE);
    } else {
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest');
    }
    args.push('-map', '0:v', '-map', '1:a');
  } else {
    args.push('-re', '-i', source, '-map', '0:a', '-map', '0:v'); // -re = read at realtime speed
  }

  // ---- encode: VP8 video + Opus audio in WebM (what Discord's voice expects) ----
  args.push(
    '-acodec', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '96k',
    '-vcodec', 'libvpx', '-cpu-used', '5',      // fastest VP8 preset = realtime-friendly
    '-b:v', '1M', '-maxrate', '1M', '-bufsize', '2M',
    '-f', 'webm', 'pipe:1',
  );
  return args;
}

async function startStream(voiceChannel, source) {
  const perms = voiceChannel.permissionsFor(voiceChannel.guild.members.me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    throw new Error('I need **Connect** and **Speak** permission in that channel.');
  }

  stopSession();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // a deafened bot cannot stream video
    selfMute: false,
  });

  const ffmpeg = spawn('ffmpeg', buildFfmpegArgs(source));
  ffmpeg.stderr.on('data', (d) => process.env.FFMPEG_DEBUG && console.error(`[ffmpeg] ${d}`));
  ffmpeg.on('error', (err) => {
    console.error('ffmpeg failed to start (installed + in PATH?):', err.message);
    stopSession();
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }, // keep going even if nobody watches
  });
  const resource = createStreamResource(ffmpeg.stdout, StreamType.WebmOpus);
  player.play(resource);
  connection.subscribe(player);

  player.on('error', (e) => console.error('Player error:', e.message));
  connection.on('error', (e) => console.error('Voice connection error:', e));

  session = { connection, player, ffmpeg };
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  if (process.env.GUILD_ID) {
    await ready.guilds.cache.get(process.env.GUILD_ID)?.commands.set(commands); // instan per-guild
  } else {
    await ready.application.commands.set(commands); // global: bisa sampai 1 jam
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const reply = { flags: MessageFlags.Ephemeral };

  try {
    if (interaction.commandName === 'stream') {
      await interaction.deferReply();
      let source = interaction.options.getString('source', true);
      if (!/^https?:\/\//i.test(source)) {
        source = isAbsolute(source) ? source : resolve(process.cwd(), source);
        if (!existsSync(source)) return interaction.editReply(`No file found: \`${source}\``);
      }
      const channel = interaction.member?.voice?.channel;
      if (!channel) return interaction.editReply('Join a voice channel first, then run `/stream`.');

      await startStream(channel, source);
      await interaction.editReply(`▶️ Streaming \`${source}\` into **${channel.name}**`);
    }

    if (interaction.commandName === 'screen') {
      await interaction.deferReply();
      const channel = interaction.member?.voice?.channel;
      if (!channel) return interaction.editReply('Join a voice channel first, then run `/screen`.');
      await startStream(channel, '__screen__');
      await interaction.editReply(`🖥️ Sharing this machine's screen into **${channel.name}**`);
    }

    if (interaction.commandName === 'stop') {
      stopSession();
      await interaction.reply({ ...reply, content: '⏹️ Stopped.' });
    }
  } catch (err) {
    console.error(err);
    const content = `❌ ${err.message ?? 'Something went wrong.'}`;
    interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ ...reply, content });
  }
});

client.login(process.env.DISCORD_TOKEN);
