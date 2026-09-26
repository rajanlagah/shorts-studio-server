// Object storage behind a provider-agnostic interface. Any S3-compatible
// service works (Backblaze B2 in production); the DB stores provider +
// bucket + key, never URLs. Kept byte-identical in api/ and worker/.
import {S3Client,CreateMultipartUploadCommand,UploadPartCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,HeadObjectCommand,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectsCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {Upload} from '@aws-sdk/lib-storage';
import {createWriteStream,createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id=v=>{if(!UUID.test(v))throw new Error('Storage keys are built from UUIDs only');return v.toLowerCase();};
// UUIDs only: no filenames or emails in keys. Internalizing an asset flips a
// DB flag; the key never changes.
export function keyFor({userId,projectId,assetId,kind}){
 const base=`u/${id(userId)}/p/${id(projectId)}`;
 if(kind==='source')return `${base}/a/${id(assetId)}`;
 if(kind==='export')return `${base}/x/${id(assetId)}.mp4`;
 throw new Error(`Unknown asset kind: ${kind}`);
}
// RFC 6266: ASCII fallback plus the UTF-8 name.
export function contentDisposition(disposition,filename){
 const ascii=filename.replace(/[^\x20-\x7e]/g,'').replace(/["\\]/g,'').trim()||'short.mp4';
 return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
const notConfigured=()=>Object.assign(new Error('Cloud storage is not configured on the server'),{statusCode:503});
export function createStorage(env=process.env){
 const configured=Boolean(env.S3_ENDPOINT&&env.S3_BUCKET&&env.S3_ACCESS_KEY_ID&&env.S3_SECRET_ACCESS_KEY);
 const provider=env.STORAGE_PROVIDER||'b2',bucket=env.S3_BUCKET||'';
 if(!configured){
  const off=async()=>{throw notConfigured();};
  return {configured,provider,bucket,keyFor,createMultipart:off,presignPart:off,completeMultipart:off,abortMultipart:off,head:off,presignGet:off,download:off,upload:off,remove:off,list:async function*(){throw notConfigured();}};
 }
 const s3=new S3Client({
  endpoint:env.S3_ENDPOINT,region:env.S3_REGION||'us-east-1',forcePathStyle:env.S3_FORCE_PATH_STYLE==='true',
  credentials:{accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY},
  // Presigned part URLs must not carry SDK checksum params the browser can't
  // compute; B2 also rejects some of the SDK's default checksum headers.
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
 });
 const Bucket=bucket;
 return {
  configured,provider,bucket,keyFor,
  async createMultipart(key,contentType){
   const r=await s3.send(new CreateMultipartUploadCommand({Bucket,Key:key,ContentType:contentType}));
   return r.UploadId;
  },
  // One key + one upload id + one part number; nothing else (plan 013, decision 9).
  presignPart:(key,uploadId,partNumber,expiresSec=900)=>getSignedUrl(s3,new UploadPartCommand({Bucket,Key:key,UploadId:uploadId,PartNumber:partNumber}),{expiresIn:expiresSec}),
  async completeMultipart(key,uploadId,parts){
   await s3.send(new CompleteMultipartUploadCommand({Bucket,Key:key,UploadId:uploadId,MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.partNumber,ETag:p.etag}))}}));
  },
  async abortMultipart(key,uploadId){
   try{await s3.send(new AbortMultipartUploadCommand({Bucket,Key:key,UploadId:uploadId}));}
   catch(e){if(e.name!=='NoSuchUpload'&&e.$metadata?.httpStatusCode!==404)throw e;}
  },
  async head(key){
   try{const r=await s3.send(new HeadObjectCommand({Bucket,Key:key}));return {bytes:Number(r.ContentLength),contentType:r.ContentType||null};}
   catch(e){if(e.name==='NotFound'||e.$metadata?.httpStatusCode===404)return null;throw e;}
  },
  presignGet:(key,{disposition='inline',filename='short.mp4',expiresSec=3600}={})=>getSignedUrl(s3,new GetObjectCommand({Bucket,Key:key,ResponseContentDisposition:contentDisposition(disposition,filename)}),{expiresIn:expiresSec}),
  async download(key,localPath,signal){
   const r=await s3.send(new GetObjectCommand({Bucket,Key:key}),{abortSignal:signal});
   await pipeline(r.Body,createWriteStream(localPath),{signal});
  },
  async upload(localPath,key,contentType){
   await new Upload({client:s3,params:{Bucket,Key:key,Body:createReadStream(localPath),ContentType:contentType},partSize:16*1024*1024,queueSize:3}).done();
  },
  // A plain DeleteObject only hides a versioned object (B2 keeps billing it),
  // so delete every version and delete marker of this exact key.
  async remove(key){
   let KeyMarker,VersionIdMarker;
   do{
    const r=await s3.send(new ListObjectVersionsCommand({Bucket,Prefix:key,KeyMarker,VersionIdMarker}));
    const objects=[...(r.Versions||[]),...(r.DeleteMarkers||[])].filter(v=>v.Key===key).map(v=>({Key:v.Key,VersionId:v.VersionId}));
    if(objects.length){
     const d=await s3.send(new DeleteObjectsCommand({Bucket,Delete:{Objects:objects,Quiet:true}}));
     if(d.Errors?.length)throw new Error(`Delete failed for ${key}: ${d.Errors[0].Code}`);
    }
    ({NextKeyMarker:KeyMarker,NextVersionIdMarker:VersionIdMarker}=r);
    if(!r.IsTruncated)break;
   }while(true);
  },
  async *list(prefix=''){
   let ContinuationToken;
   do{
    const r=await s3.send(new ListObjectsV2Command({Bucket,Prefix:prefix,ContinuationToken}));
    for(const o of r.Contents||[])yield {key:o.Key,bytes:Number(o.Size)};
    ContinuationToken=r.IsTruncated?r.NextContinuationToken:undefined;
   }while(ContinuationToken);
  },
 };
}
