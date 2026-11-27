import { browserRuntime } from './runtime';
import { invalidateWorkspace, workspaceHeaders, workspaceSignal } from './projects';
import { restoreAssetFonts, type AssetSnapshot } from './cardAssetSnapshot';
import { type ProjectCard } from './model';
import { downloadBlob } from './io';

export interface CardAssetSummary {
  id:string; name:string; version:number; updatedAt:number;
  projectId:string; cardId:string; digest:string; cover:string; backCover?:string;
  widthMm:number; heightMm:number; singleSided:boolean;
  versions?:number[];
  origin?:ProjectCard['communityOrigin'];
}
export interface CardAssetVersion extends AssetSnapshot { assetId:string; version:number; name:string; authorId?:string; author?:string }
export type AssetSource = {kind:'owned';asset:string;assetVersion:number} | {kind:'received';work:string;edition:number};
export type RestoredAsset = {kind:'owned';assetId:string;assetVersion:number} | {kind:'received';work:string;edition:number};
export type AssetPackagePreview = {kind:'owned'|'received';name:string;author:string;edition:number;
  widthMm:number;heightMm:number;singleSided:boolean;cover?:string;backCover?:string;fontWarnings?:string[];
  faceSources?:{face:'front'|'back';author:string;version:number}[]};
async function request<T>(path:string, body?:object):Promise<T> {
  if(browserRuntime)throw new Error('当前站点未连接账号服务');
  const signal=workspaceSignal();
  const response = await fetch('/api/card-assets'+path,{
    method:body?'POST':'GET', headers:{...workspaceHeaders(),...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(45000)]),
  });
  signal.throwIfAborted();
  invalidateWorkspace(response.status,response.headers.get('X-Prism-Workspace'));
  signal.throwIfAborted();
  if (!response.ok) {
    const error = await response.json().catch(()=>({}));
    signal.throwIfAborted();
    invalidateWorkspace(response.status,response.headers.get('X-Prism-Workspace'));
    throw new Error(error.error || '账号资产无法读取，请重试。');
  }
  const data=await response.json();signal.throwIfAborted();return data;
}

export async function listCardAssets(includeBackCovers = false):Promise<CardAssetSummary[]> {
  const rows=await request<CardAssetSummary[]>(includeBackCovers?'?backCovers=1':'');
  return rows.sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function readCardAsset(id:string, version?:number):Promise<CardAssetVersion> {
  const signal=workspaceSignal();
  if (!version) version = (await listCardAssets()).find(item=>item.id===id)?.version;
  signal.throwIfAborted();
  if (!version) throw new Error('找不到这份资产。');
  const record=await request<CardAssetVersion>('/'+encodeURIComponent(id)+'/'+version);
  signal.throwIfAborted();
  await restoreAssetFonts(record);
  signal.throwIfAborted();
  return record;
}

export async function saveCardAsset(id:string, expected:number, projectId:string, snapshot:AssetSnapshot, name:string) {
  name=name.trim();
  if(!name) throw new Error('请填写资产名称。');
  return request<CardAssetSummary>('/'+encodeURIComponent(id)+'/save',{expected,projectId,cardId:snapshot.card.id,name,snapshot});
}

async function packRequest(path:'download'|'inspect-asset'|'import-asset',body:BodyInit,json=false) {
  if(browserRuntime)throw new Error('当前站点未连接账号服务');
  const signal=workspaceSignal();
  const result=await fetch('/api/community/'+path,{method:'POST',credentials:'same-origin',cache:'no-store',body,
    headers:{...workspaceHeaders(),'Content-Type':json?'application/json':'application/octet-stream'},
    signal:AbortSignal.any([signal,AbortSignal.timeout(90_000)])});
  signal.throwIfAborted();
  if(!result.ok){
    const detail=await result.json().catch(()=>({}));signal.throwIfAborted();invalidateWorkspace(result.status,result.headers.get('X-Prism-Workspace'));
    throw new Error(detail.error||'资产包操作未完成，请重试。');
  }
  return {result,signal};
}

export async function downloadAssetPackage(source:AssetSource,name:string) {
  const body=source.kind==='owned'?{asset:source.asset,assetVersion:source.assetVersion}:{work:source.work,edition:source.edition};
  const {result,signal}=await packRequest('download',JSON.stringify(body),true);
  if(!result.headers.get('content-type')?.includes('application/zip'))throw new Error('无法下载资产包，请重试。');
  const blob=await result.blob();signal.throwIfAborted();
  const edition=source.kind==='owned'?source.assetVersion:source.edition;
  downloadBlob(blob,`${name.slice(0,100)}-v${edition}.prismasset`);
}

export async function inspectAssetPackage(file:File):Promise<AssetPackagePreview> {
  const {result,signal}=await packRequest('inspect-asset',file);
  const data=await result.json();signal.throwIfAborted();return data;
}

export async function importAssetPackage(file:File):Promise<RestoredAsset> {
  const {result,signal}=await packRequest('import-asset',file);
  const data=await result.json();signal.throwIfAborted();return data;
}
export async function manageCardAsset(item:CardAssetSummary,action:'rename'|'remove',name?:string) {
  return request('/'+encodeURIComponent(item.id)+'/'+action,{expected:item.version,name:name?.trim()});
}
