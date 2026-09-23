import pg from 'pg';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {captionStyleSchema,captionStyleOverride,LEGACY,resolveStyle,fontIssue} from './style.js';
export const dataDir=resolve(process.env.DATA_DIR || '/data');
export const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,
 ...(process.env.PG_CA_FILE ? {ssl:{rejectUnauthorized:true,ca:readFileSync(process.env.PG_CA_FILE,'utf8')}} : {})});
export const uuid=z.string().uuid();
export const dir=id=>join(dataDir,uuid.parse(id));
export const assetPath=(id,asset)=>join(dir(id),uuid.parse(asset)+'.media');
export const words=z.array(z.object({start:z.number().min(0).max(180),end:z.number().positive().max(180)}).strict()).max(60);
// Legacy 'classic' | 'highlight' names still parse, into the equivalent style object.
export const captionStyle=z.union([z.enum(['classic','highlight']).transform(k=>structuredClone(LEGACY[k])),captionStyleSchema]);
export const caption=z.object({start:z.number().min(0).max(180),end:z.number().positive().max(180),text:z.string().min(1).max(300),style:captionStyleOverride.optional(),words:words.optional()}).strict().refine(c=>c.end>c.start);
export const edit=z.object({
 clips:z.array(z.object({assetId:uuid,start:z.number().min(0).max(3600),end:z.number().positive().max(3600),fit:z.enum(['fit','crop']).default('fit')}).strict().refine(c=>c.end>c.start)).min(1).max(5),
 captions:z.array(caption).max(500).default([]),
 wordsPerCaption:z.number().int().min(1).max(4).optional(),
 captionStyle:captionStyle.default('classic'),
}).strict().superRefine((p,ctx)=>{
 const duration=p.clips.reduce((n,c)=>n+c.end-c.start,0);
 if(duration>180)ctx.addIssue({code:'custom',message:'Maximum final duration is 180 seconds'});
 if(p.captions.some(c=>c.end>duration))ctx.addIssue({code:'custom',message:'Caption exceeds timeline duration'});
 p.captions.forEach((c,i)=>{const m=c.style&&fontIssue(resolveStyle(p.captionStyle,c.style));if(m)ctx.addIssue({code:'custom',path:['captions',i,'style'],message:m});});
});
export async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
