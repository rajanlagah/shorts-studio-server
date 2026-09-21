import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assetPath,edit} from './common.js';
export function run(bin,args,{cwd,signal}={}){return new Promise((resolve,reject)=>{
 const p=spawn(bin,args,{cwd,signal,stdio:['ignore','pipe','pipe']});let out='',err='';
 const timer=setTimeout(()=>p.kill('SIGKILL'),15*60*1000);
 p.stdout.on('data',b=>{out=(out+b).slice(-1000000);});p.stderr.on('data',b=>{err=(err+b).slice(-16000);});
 p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(`${bin} failed (${code}): ${err}`));});
});}
export async function probe(path,signal){
 const result=JSON.parse(await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-show_streams','-show_format','-of','json',path],{signal}));
 const v=result.streams.find(x=>x.codec_type==='video');const duration=Number(result.format.duration);
 if(!v || !Number.isFinite(duration) || duration<=0 || duration>3600 || v.width>4096 || v.height>4096)throw new Error('Unsupported video: maximum 4096 pixels per side and 1 hour source duration');
 return {duration,audio:result.streams.some(x=>x.codec_type==='audio')};
}
const stamp=t=>{const n=Math.round(t*100);return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,'0')}:${String(Math.floor(n/100)%60).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`;};
// Matches --caption-highlight in the frontend's styles.css (plan 007) so
// the burned-in export and the live preview use the same color.
export function ass(captions,captionStyle='classic'){
 // Neutralize ASS override sequences while keeping real line breaks.
 const text=s=>s.replaceAll('\\','／').replaceAll('{','(').replaceAll('}',')').replaceAll('\r','').replaceAll('\n','\\N');
 const styleName=captionStyle==='highlight'?'Highlight':'Default';
 return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,80,80,240,1
Style: Highlight,Noto Sans,66,&H000AD6FF,&H000AD6FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,80,80,240,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`+captions.map(c=>`Dialogue: 0,${stamp(c.start)},${stamp(c.end)},${styleName},,0,0,0,,${text(c.text)}`).join('\n');
}
export async function renderTimeline(sessionId,input,work,{signal,onProgress=async()=>{}}={}){
 const payload=edit.parse(input);await mkdir(work,{recursive:true});
 for(let i=0;i<payload.clips.length;i++){
 const c=payload.clips[i],path=assetPath(sessionId,c.assetId),meta=await probe(path,signal),duration=c.end-c.start;
 if(c.end>meta.duration+0.05)throw new Error('Trim exceeds source duration');
 const scale=c.fit==='crop'?'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920':'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
 const args=['-nostdin','-y','-v','error','-filter_threads','1','-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-ss',String(c.start),'-i',path];
 if(!meta.audio)args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
 args.push('-map','0:v:0','-map',meta.audio?'0:a:0':'1:a:0','-t',String(duration),'-vf',`${scale},setsar=1,fps=30,format=yuv420p`,'-af','aresample=48000,apad','-c:v','libx264','-preset','veryfast','-crf','23','-threads','1','-c:a','aac','-ar','48000','-ac','2',`clip-${i}.mp4`);
 await run('ffmpeg',args,{cwd:work,signal});await onProgress(Math.round(10+65*(i+1)/payload.clips.length));
 }
 await writeFile(join(work,'clips.txt'),payload.clips.map((_,i)=>`file 'clip-${i}.mp4'`).join('\n'));
 await run('ffmpeg',['-nostdin','-y','-v','error','-f','concat','-safe','1','-i','clips.txt','-c','copy','-movflags','+faststart','joined.mp4'],{cwd:work,signal});
 return join(work,'joined.mp4');
}
export async function exportVideo(sessionId,payload,work,options){
 await renderTimeline(sessionId,payload,work,options);
 if(payload.captions.length){
 await writeFile(join(work,'captions.ass'),ass(payload.captions,payload.captionStyle));
 await run('ffmpeg',['-nostdin','-y','-v','error','-filter_threads','1','-i','joined.mp4','-vf','ass=captions.ass','-c:v','libx264','-preset','veryfast','-crf','23','-threads','1','-c:a','copy','-movflags','+faststart','output.mp4'],{cwd:work,signal:options.signal});
 }else{const {rename}=await import('node:fs/promises');await rename(join(work,'joined.mp4'),join(work,'output.mp4'));}
 return {downloadReady:true};
}
export async function transcribe(sessionId,payload,work,options){
 if(!process.env.OPENAI_API_KEY)throw new Error('Auto-captions disabled: configure OPENAI_API_KEY on worker');
 await renderTimeline(sessionId,payload,work,options);
 await run('ffmpeg',['-nostdin','-y','-v','error','-i','joined.mp4','-vn','-ac','1','-ar','16000','audio.wav'],{cwd:work,signal:options.signal});
 const form=new FormData();form.append('file',new Blob([await readFile(join(work,'audio.wav'))],{type:'audio/wav'}),'audio.wav');form.append('model','whisper-1');form.append('response_format','verbose_json');form.append('timestamp_granularities[]','segment');
 form.append('timestamp_granularities[]','word');
 const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form,signal:options.signal});
 if(!response.ok)throw new Error(`Transcription provider returned HTTP ${response.status}`);
 const data=await response.json();const duration=payload.clips.reduce((n,c)=>n+c.end-c.start,0);
 const perCard=payload.wordsPerCaption||2;
 const words=(data.words||[]).map(w=>({text:w.word.trim(),start:Math.max(0,w.start),end:Math.min(duration,w.end)})).filter(w=>w.end>w.start && w.text);
 const cards=[];
 for(let i=0;i<words.length;i+=perCard){
 const chunk=words.slice(i,i+perCard);
 cards.push({start:chunk[0].start,end:chunk[chunk.length-1].end,text:chunk.map(w=>w.text).join(' ').slice(0,300)});
 }
 // Defensive fallback: if the provider ever omits word timestamps, keep
 // today's segment-level behavior rather than returning nothing.
 const captions=(cards.length?cards:(data.segments||[]).map(s=>({start:Math.max(0,s.start),end:Math.min(duration,s.end),text:s.text.trim().slice(0,300)}))).filter(c=>c.end>c.start && c.text);
 return {captions:edit.parse({...payload,captions}).captions};
}
