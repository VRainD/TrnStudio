import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { extractAudio, run } from './media.mjs';
const dir = resolve('.qa', 'media-' + Date.now());
await mkdir(dir, { recursive: true });
for (const [ext,codec] of [['webm','libopus'],['mp4','aac'],['mov','aac'],['mkv','flac'],['avi','pcm_s16le']]) {
  const input=join(dir,'video.'+ext);
  await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=128x72:r=5','-f','lavfi','-i','sine=frequency=440:duration=2','-t','2','-c:v',ext==='webm'?'libvpx':'mpeg4','-c:a',codec,input]);
  const result=await extractAudio(input,join(dir,ext+'.wav'));
  assert.ok(result.seconds>=1.9&&result.seconds<2.2,ext+' duration');
  console.log('PASS video '+ext);
}
for (const ext of ['mp3','wav','m4a','aac','ogg','opus','flac','aiff','wma']) {
  const input=join(dir,'source.'+ext);
  await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=600:duration=2',input]);
  const result=await extractAudio(input,join(dir,'decoded-'+ext+'.wav'));
  assert.ok(result.seconds>=1.9&&result.seconds<2.3,ext+' duration');
  console.log('PASS audio '+ext);
}
await copyFile(join(dir,'video.webm'),join(dir,'telemost.webv'));
assert.ok((await extractAudio(join(dir,'telemost.webv'),join(dir,'webv.wav'))).seconds>1.9);
console.log('PASS renamed WebM .webv');
await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=128x72:r=5','-t','1',join(dir,'silent.mp4')]);
await assert.rejects(extractAudio(join(dir,'silent.mp4'),join(dir,'silent.wav')),/нет аудиодорожки/);
await writeFile(join(dir,'broken.mp4'),'not a media file');
await assert.rejects(extractAudio(join(dir,'broken.mp4'),join(dir,'broken.wav')),/повреждён/);
await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=1','-f','lavfi','-i','sine=frequency=800:duration=1','-map','0:a','-map','1:a',join(dir,'multi.mkv')]);
await assert.rejects(extractAudio(join(dir,'multi.mkv'),join(dir,'multi.wav')),/несколько аудиодорожек/);
console.log('PASS no audio, corrupt input, multiple tracks');
console.log('Fixtures: '+dir);
