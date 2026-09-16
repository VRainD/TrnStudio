import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export class MediaError extends Error {}
export function run(binary, args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const done = (err, value) => { if (finished) return; finished = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); done(new MediaError('Превышено время обработки файла.')); }, timeout);
    child.stdout.on('data', data => { output += data; if (output.length > 2e6) { child.kill(); done(new MediaError('Слишком много метаданных в файле.')); } });
    child.stderr.resume();
    child.on('error', () => done(new MediaError(`Не удалось запустить ${binary}. Проверьте установку FFmpeg и FFprobe.`)));
    child.on('close', code => code === 0 ? done(null, output) : done(new MediaError('Не удалось прочитать аудиодорожку. Файл повреждён или кодек не поддерживается.')));
  });
}

export async function extractAudio(input, output) {
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-probesize', '10000000', '-analyzeduration', '10000000', '-show_streams', '-show_format', '-of', 'json', input], { timeout: 30000 }));
  const tracks = (probe.streams || []).filter(s => s.codec_type === 'audio');
  if (!tracks.length) throw new MediaError('В этом видео нет аудиодорожки. Выберите запись со звуком.');
  if (tracks.length > 1) throw new MediaError('В файле несколько аудиодорожек. В локальной версии сначала оставьте нужную дорожку в видеоредакторе.');
  const track = tracks[0];
  const duration = Number(track.duration || probe.format?.duration);
  if (Number.isFinite(duration) && duration > 14400) throw new MediaError('Длительность превышает лимит 4 часа.');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-protocol_whitelist', 'file', '-threads', '2', '-i', input,
    '-map', `0:${track.index}`, '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', '14401', '-f', 'wav', output]);
  const decoded = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=duration_ts,time_base', '-of', 'json', output], { timeout: 10000 }));
  const stream = decoded.streams?.[0];
  const [num, den] = String(stream?.time_base).split('/').map(Number);
  const seconds = Number(stream?.duration_ts) * num / den;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new MediaError('Аудиодорожка пуста или имеет некорректную длительность.');
  if (seconds > 14400) throw new MediaError('Длительность превышает лимит 4 часа.');
  const info = await stat(output);
  return { seconds, bytes: info.size, format: probe.format?.format_name, codec: track.codec_name };
}
