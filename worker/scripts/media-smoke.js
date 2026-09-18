import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const temp=await mkdtemp(join(tmpdir(),'shorts-test-'));process.env.DATA_DIR=temp;
const {run,exportVideo,ass}=await import('../src/media.js');
const {pool}=await import('../src/common.js');
const session=randomUUID(),a=randomUUID(),b=randomUUID(),folder=join(temp,session);await mkdir(folder);
try{
 await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:s=320x240:r=30:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-threads','1','-c:a','aac','-shortest','-f','mp4',join(folder,a+'.media')]);
 await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=240x320:r=30:d=1','-c:v','libx264','-threads','1','-f','mp4',join(folder,b+'.media')]);
 const payload={clips:[{assetId:a,start:0.1,end:0.8,fit:'crop'},{assetId:b,start:0,end:0.7,fit:'fit'}],captions:[{start:0,end:1.2,text:'Hello {test}\nCaption'}]};
 const work=join(folder,randomUUID());
 await exportVideo(session,payload,work,{});
 const meta=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',join(work,'output.mp4')]));
 const v=meta.streams.find(s=>s.codec_type==='video');assert.equal(v.width,1080);assert.equal(v.height,1920);assert.ok(meta.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(meta.format.duration)-1.4)<0.2);
 assert.ok(!ass([{start:0,end:1,text:'{\\pos(1,1)}'}]).includes('{\\pos'));
 await assert.rejects(exportVideo(session,{clips:[{assetId:a,start:0,end:8}],captions:[]},join(folder,randomUUID()),{}),/Trim exceeds/);
 console.log('PASS: real FFmpeg export, mixed audio, crop/fit, captions, duration, invalid trim');
}finally{await pool.end();await rm(temp,{recursive:true,force:true});}
