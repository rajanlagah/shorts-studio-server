import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {edit} from './common.js';
import {FONTS,resolveStyle} from './style.js';
const fontsDir=fileURLToPath(new URL('../fonts/ttf',import.meta.url));
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
 return {duration,width:v.width,height:v.height,audio:result.streams.some(x=>x.codec_type==='audio')};
}
const stamp=t=>{const n=Math.round(t*100);return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,'0')}:${String(Math.floor(n/100)%60).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`;};
// ASS colors are &HBBGGRR&; alpha is &HAA& with 00 = opaque.
export const bgr=hex=>`&H${hex.slice(5,7)}${hex.slice(3,5)}${hex.slice(1,3)}&`.toUpperCase();
export const alpha=opacity=>`&H${Math.round((1-opacity)*255).toString(16).padStart(2,'0').toUpperCase()}&`;
// Break text into lines of at most N characters (on spaces; explicit newlines
// kept). Every event of a caption uses these lines with \q2, so word
// highlight events never re-wrap. The frontend preview uses the same formula.
export function preWrap(text,size){
 const n=Math.floor(900/(size*0.55)),lines=[];
 for(const para of text.replaceAll('\r','').split('\n')){
 let line='';
 for(const w of para.split(/\s+/).filter(Boolean)){if(line&&line.length+1+w.length>n){lines.push(line);line=w;}else line=line?`${line} ${w}`:w;}
 if(line)lines.push(line);
 }
 return lines;
}
// Real timings when they match the word count, else an equal split.
function wordTimes(c,count){
 if(c.words?.length===count)return c.words;
 const d=(c.end-c.start)/count;
 return Array.from({length:count},(_,i)=>({start:c.start+i*d,end:c.start+(i+1)*d}));
}
// Neutralize ASS override sequences in user text; every tag below is generated.
const clean=s=>s.replaceAll('\\','／').replaceAll('{','(').replaceAll('}',')');
const ANCHOR={bottom:[2,1920-240],middle:[5,960],top:[8,240]};
function captionEvents(c,s){
 const f=FONTS[s.font],[an,y]=ANCHOR[s.position.anchor],h=s.highlight;
 const head=`\\an${an}\\pos(540,${y-s.position.offset})\\q2\\b${s.weight===700?1:0}\\i${s.italic?1:0}\\fn${f.family}\\fs${s.size}\\fsp${s.letterSpacing}`;
 const lines=preWrap(s.uppercase?c.text.toUpperCase():c.text,s.size).map(l=>l.split(' ').map(clean));
 // Render the caption's words; span(i) returns the override tags for word i.
 const body=span=>{let i=0;return lines.map(ws=>ws.map((w,j)=>`${span?`{${span(i++)}}`:''}${j?' ':''}${w}`).join('')).join('\\N');};
 const out=[];
 if(!lines.length)return out;
 const line=(layer,style,start,end,text)=>{if(stamp(start)!==stamp(end))out.push(`Dialogue: ${layer},${stamp(start)},${stamp(end)},${style},,0,0,0,,${text}`);};
 // Box layers use BorderStyle 3, whose "outline" is an opaque box; the
 // glyphs themselves are invisible, the text layer draws them on top.
 // libass draws no box at \bord0, so padding 0 means a hairline.
 const boxHead=pad=>`{${head}\\1a&HFF&\\4a&HFF&\\shad0\\bord${Math.max(pad,0.1)}}`;
 if(s.box.enabled)line(0,'Box',c.start,c.end,`${boxHead(s.box.padding)}{\\3c${bgr(s.box.color)}\\3a${alpha(s.box.opacity)}}${body()}`);
 const textHead=`{${head}\\3c${bgr(s.outline.color)}\\bord${s.outline.width}\\4c${bgr(s.shadow.color)}\\shad${s.shadow.depth}}`;
 const look=(color,opacity,scale)=>`\\1c${bgr(color)}\\1a${alpha(opacity)}\\3a${alpha(opacity)}\\4a${alpha(opacity*s.shadow.opacity)}\\fscx${scale}\\fscy${scale}`;
 if(!h.enabled){line(1,'Default',c.start,c.end,`${textHead}{${look(s.color,1,100)}}${body()}`);return out;}
 const count=lines.flat().length,times=wordTimes(c,count),clamp=t=>Math.min(c.end,Math.max(c.start,t));
 const intervals=[];
 if(clamp(times[0].start)>c.start)intervals.push([c.start,clamp(times[0].start),-1]);
 for(let i=0;i<count;i++)intervals.push([clamp(times[i].start),i+1<count?clamp(times[i+1].start):c.end,i]);
 const wordPad=Math.round(s.size*WORD_PAD);
 for(const [start,end,active] of intervals){
 if(end<=start)continue;
 if(h.background.enabled&&active>=0)line(0,'Box',start,end,boxHead(wordPad)+body(i=>i===active?`\\3c${bgr(h.background.color)}\\3a${alpha(h.background.opacity)}\\fscx${h.scale}\\fscy${h.scale}`:'\\3a&HFF&\\fscx100\\fscy100'));
 line(1,'Default',start,end,textHead+body(i=>i===active?look(h.color,1,h.scale):look(s.color,h.dimOpacity,100)));
 }
 return out;
}
// Padding around a highlighted word's background, as a fraction of font size
// (frontend preview uses the same constant).
export const WORD_PAD=0.12;
// `captionStyle` is the parsed style object (legacy names already converted
// by the schema); each caption's `style` is a partial override of it.
export function ass(captions,captionStyle){
 return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,0,0,0,1
Style: Box,Noto Sans,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,0,0,2,0,0,0,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`+captions.flatMap(c=>captionEvents(c,resolveStyle(captionStyle,c.style))).join('\n');
}
// `resolve(assetId)` returns (or produces) the local file of a source clip:
// a session upload for legacy jobs, the object-storage cache for project jobs.
export async function renderTimeline(resolve,input,work,{signal,onProgress=async()=>{}}={}){
 const payload=edit.parse(input);await mkdir(work,{recursive:true});
 for(let i=0;i<payload.clips.length;i++){
 const c=payload.clips[i],path=await resolve(c.assetId),meta=await probe(path,signal),duration=c.end-c.start;
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
export async function exportVideo(resolve,input,work,options){
 const payload=edit.parse(input);
 await renderTimeline(resolve,payload,work,options);
 if(payload.captions.length){
 await writeFile(join(work,'captions.ass'),ass(payload.captions,payload.captionStyle));
 await run('ffmpeg',['-nostdin','-y','-v','error','-filter_threads','1','-i','joined.mp4','-vf',`ass=captions.ass:fontsdir='${fontsDir}'`,'-c:v','libx264','-preset','veryfast','-crf','23','-threads','1','-c:a','copy','-movflags','+faststart','output.mp4'],{cwd:work,signal:options.signal});
 }else{const {rename}=await import('node:fs/promises');await rename(join(work,'joined.mp4'),join(work,'output.mp4'));}
 return {downloadReady:true};
}
export async function transcribe(resolve,payload,work,options){
 if(!process.env.OPENAI_API_KEY)throw new Error('Auto-captions disabled: configure OPENAI_API_KEY on worker');
 await renderTimeline(resolve,payload,work,options);
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
