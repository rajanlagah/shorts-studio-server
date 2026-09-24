// Caption style object shared by api and worker. Keep api/src/style.js and
// worker/src/style.js byte-identical (tests fail if they drift). The frontend
// mirrors this shape in src/lib/captionStyle.ts.
import {z} from 'zod';
// Bundled fonts (worker/fonts). `family` is the ASS Fontname / CSS family.
export const FONTS={
 'noto-sans':{family:'Noto Sans',bold:true,italic:true},
 montserrat:{family:'Montserrat',bold:true,italic:true},
 poppins:{family:'Poppins',bold:true,italic:true},
 oswald:{family:'Oswald',bold:true,italic:false},
 anton:{family:'Anton',bold:false,italic:false},
 'bebas-neue':{family:'Bebas Neue',bold:false,italic:false},
 bangers:{family:'Bangers',bold:false,italic:false},
 'permanent-marker':{family:'Permanent Marker',bold:false,italic:false},
};
const hex=z.string().regex(/^#[0-9A-F]{6}$/i);
const opacity=z.number().min(0).max(1);
const shape=z.object({
 font:z.enum(Object.keys(FONTS)),
 weight:z.union([z.literal(400),z.literal(700)]),
 italic:z.boolean(),
 size:z.number().min(24).max(160),
 color:hex,
 uppercase:z.boolean(),
 letterSpacing:z.number().min(-5).max(20),
 outline:z.object({width:z.number().min(0).max(12),color:hex}).strict(),
 shadow:z.object({depth:z.number().min(0).max(12),color:hex,opacity}).strict(),
 box:z.object({enabled:z.boolean(),color:hex,opacity,padding:z.number().min(0).max(40)}).strict(),
 position:z.object({anchor:z.enum(['top','middle','bottom']),offset:z.number().min(-600).max(600)}).strict(),
 highlight:z.object({
 enabled:z.boolean(),
 color:hex,
 background:z.object({enabled:z.boolean(),color:hex,opacity}).strict(),
 scale:z.number().min(100).max(130),
 dimOpacity:z.number().min(0.2).max(1),
 }).strict(),
}).strict();
// Message if the style asks for a face its font doesn't ship, else null.
export function fontIssue(s){
 const f=FONTS[s.font];
 if(s.weight===700&&!f.bold)return `Font ${s.font} has no bold weight`;
 if(s.italic&&!f.italic)return `Font ${s.font} has no italic`;
 return null;
}
export const captionStyleSchema=shape.superRefine((s,ctx)=>{const m=fontIssue(s);if(m)ctx.addIssue({code:'custom',message:m});});
export const captionStyleOverride=shape.deepPartial();
const classic={
 font:'noto-sans',weight:700,italic:false,size:58,color:'#FFFFFF',uppercase:false,letterSpacing:0,
 outline:{width:3,color:'#000000'},
 shadow:{depth:0,color:'#000000',opacity:0.5},
 box:{enabled:false,color:'#000000',opacity:0.6,padding:16},
 position:{anchor:'bottom',offset:0},
 highlight:{enabled:false,color:'#FFD60A',background:{enabled:false,color:'#7C3AED',opacity:1},scale:100,dimOpacity:1},
};
export const LEGACY={classic,highlight:{...classic,size:66,color:'#FFD60A'}};
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function merge(base,over){
 const out={...base};
 for(const [k,v] of Object.entries(over)){if(v!==undefined)out[k]=isObj(v)&&isObj(base[k])?merge(base[k],v):v;}
 return out;
}
// Effective style of a caption: global style with the caption's partial override on top.
export const resolveStyle=(global,override)=>override?merge(global,override):global;
