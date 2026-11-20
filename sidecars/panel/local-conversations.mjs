// Discover IDs only. Conversation bodies and SQLite contents are never read.
import {opendir,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const conversationId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=value=>createHash('sha256').update(value).digest('hex');
async function statInfo(file,directory=false){
 try{const s=await lstat(file,{bigint:true});if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()))return null;
  return {token:[s.size,s.mtimeNs,s.ctimeNs,s.ino].map(String).join(':'),mtimeMs:Number(s.mtimeNs/1000000n)};
 }catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}
}
const stamp=async(file,directory=false)=>(await statInfo(file,directory))?.token??null;
export async function discoverLocalConversations({host,home=homedir(),limit=20000}={}){
 if(!['app','ide'].includes(host))throw Error('Explicit conversation host is required');
 const base=join(home,'.gemini',host==='ide'?'antigravity-ide':'antigravity');
 const files=new Map();let errors=0,visited=0;
 for(const [name,directory] of [['conversations',false],['brain',true]]){
  const root=join(base,name);
  try{
   // Do not follow a redirected host root into another installation.
   if(!await stamp(base,true)||!await stamp(root,true))continue;
   const dir=await opendir(root);
   for await(const entry of dir){
    if(++visited>limit)throw Error('Conversation discovery budget exceeded');
    if(entry.isSymbolicLink()||!(directory?entry.isDirectory():entry.isFile()))continue;
    const id=directory?entry.name:entry.name.endsWith('.db')?entry.name.slice(0,-3):'';
    if(!conversationId.test(id))continue;
    const key=id.toLowerCase(),parts=files.get(key)||[];
    parts.push({file:join(root,entry.name),directory});files.set(key,parts);
   }
  }catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))errors++;}
  if(visited>limit)break;
 }
 const conversations=[];
 for(const [id,parts]of files){
  const hasDb=parts.some(p=>!p.directory),brainOnly=!hasDb;
  const readInfo=async()=>{
   const values=[];let modifiedAtMs=null;
   for(const {file,directory}of parts){const info=await statInfo(file,directory);if(!info)return null;
    values.push([directory?'brain':'db',info.token]);
    if(!directory){
     modifiedAtMs=modifiedAtMs===null?info.mtimeMs:Math.max(modifiedAtMs,info.mtimeMs);
     const wal=await statInfo(file+'-wal');
     values.push(['wal',wal?.token??null]);
     if(wal)modifiedAtMs=Math.max(modifiedAtMs,wal.mtimeMs);
    }
   }
   return {signature:digest(JSON.stringify(values)),modifiedAtMs};
  };
  const readSignature=async()=>(await readInfo())?.signature??null;
  try{const info=await readInfo();if(info)conversations.push({id,signature:info.signature,readSignature,hasDb,brainOnly,modifiedAtMs:info.modifiedAtMs});}
  catch{errors++;}
 }
 return {conversations,errors};
}
