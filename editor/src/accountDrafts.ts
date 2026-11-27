import { createStore, del, get, set } from 'idb-keyval';
import { hydrateProject, serializeProject, type Project, type StoredProjectDocument } from './model';

const store=createStore('prism-account-drafts','drafts');
const key=(account:string,project:string)=>account+'/'+project;

export async function retainAccountDraft(account:string,project:Project,revision:number) {
  await set(key(account,project.id),{document:serializeProject(project),revision},store);
}

export async function findAccountDraft(account:string,project:string) {
  const saved=await get<{document:StoredProjectDocument;revision:number}>(key(account,project),store);
  return saved?{project:hydrateProject(saved.document),revision:saved.revision}:undefined;
}

export function discardAccountDraft(account:string,project:string) {
  return del(key(account,project),store);
}
