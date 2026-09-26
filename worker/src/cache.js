// Local disk cache of source footage from object storage. ffmpeg only ever
// reads local files (no HTTP in its protocol whitelist), and a clip rendered
// twice is downloaded once. Least-recently-used files are evicted past
// maxBytes; files pinned by the running job are never evicted.
import {mkdir,stat,rename,rm,readdir,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export function createCache({root,maxBytes,storage}){
 const pinned=new Set();
 const pathOf=id=>join(root,`${id}.media`);
 async function evict(){
  const files=[];
  for(const name of await readdir(root)){
   if(!name.endsWith('.media'))continue;
   const s=await stat(join(root,name)).catch(()=>null);
   if(s)files.push({id:name.slice(0,-6),path:join(root,name),bytes:s.size,mtime:s.mtimeMs});
  }
  let total=files.reduce((n,f)=>n+f.bytes,0);
  for(const f of files.sort((a,b)=>a.mtime-b.mtime)){
   if(total<=maxBytes)break;
   if(pinned.has(f.id))continue;
   await rm(f.path,{force:true});total-=f.bytes;
  }
 }
 return {
  pathOf,
  // Returns a local path holding exactly asset.bytes bytes, pinned until unpinAll().
  async ensureLocal(asset,signal){
   await mkdir(root,{recursive:true});
   const path=pathOf(asset.id);
   pinned.add(asset.id);
   const s=await stat(path).catch(()=>null);
   if(s&&s.size===Number(asset.bytes)){const now=new Date();await utimes(path,now,now);return path;}
   const temp=join(root,`${asset.id}.${randomUUID()}.part`);
   try{
    await storage.download(asset.object_key,temp,signal);
    const {size}=await stat(temp);
    if(size!==Number(asset.bytes))throw new Error(`Downloaded ${size} bytes, expected ${asset.bytes}`);
    await rename(temp,path);
   }catch(e){await rm(temp,{force:true});throw e;}
   await evict();
   return path;
  },
  unpinAll(){pinned.clear();},
  async drop(id){if(!pinned.has(id))await rm(pathOf(id),{force:true});},
  // Leftover partial downloads from a crash.
  async sweep(){
   await mkdir(root,{recursive:true});
   for(const name of await readdir(root))if(name.endsWith('.part'))await rm(join(root,name),{force:true});
  },
  evict,
 };
}
