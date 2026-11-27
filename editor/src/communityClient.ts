import { validateCardDesign } from './io';
import type { ProjectCard } from './model';
import { accountWorkspace, changeWorkspace, invalidateWorkspace, workspaceHeaders, workspaceSignal } from './projects';

export type Account = {id:string; handle:string;displayName?:string;email?:string|null;emailVerified?:boolean};
export const accountName=(account?:Account|null)=>account?.displayName||account?.handle||'';
export const COMMUNITY_CATEGORIES = {card:'整卡', set:'套卡', component:'组件', process:'工艺', other:'其他'} as const;
export type CommunityCategory = keyof typeof COMMUNITY_CATEGORIES;
export const PUBLISHABLE_COMMUNITY_CATEGORIES = ['card', 'process', 'other'] as const satisfies readonly CommunityCategory[];

export type Work = {
  id:string; edition:number; currentEdition:number; name:string; description:string; author:string; ownedAsset?:string;
  assetVersion?:number; authorId?:string; publishedAuthor?:string; license?:{version:string;scope:string}; coverFace?:'front'|'back';
  width:number; height:number; single:number; mine:boolean; held:boolean; state:'public'|'withdrawn'|'blocked';
  category?:CommunityCategory;
  resourcesRestricted?:number;
  resourcesPending?:number;
};
export type CommunityResource = {id:string; labels:string[]; reason?:string|null; replaced:boolean};

const pendingCopyKey='prism-pending-copy';
export function pendingCopy(work?:Work):Pick<Work,'id'|'edition'>|undefined {
  try {
    if(work)sessionStorage.setItem(pendingCopyKey,JSON.stringify({id:work.id,edition:work.edition}));
    const raw=sessionStorage.getItem(pendingCopyKey);
    return raw?JSON.parse(raw) as Pick<Work,'id'|'edition'>:undefined;
  } catch {return undefined;}
}

export function clearPendingCopy() {
  try {sessionStorage.removeItem(pendingCopyKey);} catch {/* The open work keeps the action in memory. */}
}

export function accountLink(hash=location.hash) {
  const [path,search]=hash.split('?');
  if(path!=='#/account/verify'&&path!=='#/account/reset')return undefined;
  return {mode:path.endsWith('/verify')?'verify' as const:'reset' as const,token:new URLSearchParams(search).get('token')??''};
}

const api = '/api/community/';
export const holdingImage = (w: Work, face: string) => api + 'image/' + w.id + '/' + w.edition + '/' + face;

export class CommunityRequestError extends Error {
  constructor(message:string,readonly status:number) { super(message); }
}

const identityActions=new Set([
  'login','register','verify-email','resend-verification','request-password-reset','reset-password',
  'request-email-code','login-email-code','request-password-code','verify-password-code','reset-password-code',
]);
export async function communityRequest<T>(path:string, body?:object):Promise<T> {
  const signal=workspaceSignal();
  const identity=identityActions.has(path);
  const r = await fetch(api + path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache:'no-store',
    signal:identity?AbortSignal.timeout(45_000):AbortSignal.any([signal,AbortSignal.timeout(45_000)]),
    headers: {...(!identity&&path!=='session'?workspaceHeaders():{}), ...(body?{'Content-Type':'application/json'}:{})},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.headers.get('content-type')?.includes('application/json')) throw Error('当前站点未连接社区服务，请打开运行 Prism 服务的工作台。');
  const data = await r.json();
  if(!identity)signal.throwIfAborted();
  if (!r.ok) {
    if(!identity&&path!=='bind-email'&&path!=='change-password')invalidateWorkspace(r.status,r.headers.get('X-Prism-Workspace'));
    throw new CommunityRequestError(data.error || '操作失败，请重试',r.status);
  }
  if(path==='session'&&!data&&accountWorkspace())changeWorkspace('guest');
  return data as T;
}

export async function holdingCard(work:Work) {
  const card=await communityRequest<ProjectCard>('card/'+work.id+'/'+work.edition);
  validateCardDesign(card);
  if (!work.mine) card.communityOrigin={workId:work.id,edition:work.edition,author:work.author,
    authorId:work.authorId,publishedAuthor:work.publishedAuthor,licenseVersion:work.license?.version};
  return card;
}
