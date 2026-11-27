import { isValidElement, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement, type ReactNode, type Ref } from 'react';
import { Layers3, ChevronDown, ChevronRight, Plus, ImagePlus, Type, Square, SquareDashed, Circle, Hand, Paintbrush, Eraser, Undo2, EyeOff, Lock, Copy, Trash2, Download, Upload, X, Check, SlidersHorizontal, ScanLine, CheckCircle2, Pentagon, Pipette } from 'lucide-react';
import JSZip from 'jszip';
import CardManager from './CardManager';
import { LanShare } from './LanShare';
import {alignArtwork} from './artworkAlignment';
import { PublishCardAsset, PickCardAsset } from './CardAssetDialogs';
import { AccountForm } from './AccountForm';
import { accountLink, communityRequest, pendingCopy, type Account } from './communityClient';
import { discardAccountDraft, findAccountDraft } from './accountDrafts';
import { physicalCardFace, projectForFaceOutput, blankCardAfter, cloneProjectCard, lastOpenedCard, rememberCurrentCard } from './cardMembers';
import { projectCards, projectAtCard, projectWithMembers, serializeProject, type PathPoint, type ProjectCard } from './model';
import { DeliveryHistory, saveDelivery } from './DeliveryHistory';
import CanvasCardTool from './CanvasCardTool';
import CanvasToolMenu from './CanvasToolMenu';
import {
 canCombineCanvasFaces, canCopyCanvasFaces, canDeleteCanvasFaces, canReplaceCanvasFaces, canSwapCanvasFaces, canvasFaceKey,
 canUnlinkCanvasFace, combineCanvasFaces, copyCanvasFaces, decodeClipboardFace, deleteCanvasFaces, encodeClipboardFace,
 insertCanvasCard, preserveCanvasLayout, replaceCanvasFaces, swapCanvasFaces, translateCanvasFaces, unlinkCanvasFace, type CanvasFace,
} from './canvasFaces';
import { canvasLayoutSnapshot } from './canvasLayout';
import type { CanvasMarqueeSelection } from './canvasMarquee';
import type { Camera } from './canvasNavigation';
import EditorCanvas, { ZOOM_STEP, type CanvasNavigation, type CreatedVector, type EditorTool } from './EditorCanvas';
import { readPasteEvent, readSystemClipboard, type ClipboardPayload } from './editorClipboard';
import { PrintGuideLegend, PrintCornerPreview } from './PrintGuides';
import { PlateProof, type ProofSettings } from './PlateProof';
import { dependentRegions, maskConsumers, removalForLayerUnits, removeRegion, removeSelection, sourceMaskImpact, type Removal } from './maskConsumers';
import CropEditor from './CropEditor';
import { StockPicker, StockFinishControls, StockFinishMatchForm, LayerMaskField, LayerTypeField, MaskContentEditor, imageMaskNode, type MaskShape } from './ProductionControls';
import { STOCKS, changeStockSpec, effectiveStockSpec, resetStockFinishMatch, stockPreset, stockKeys, stockDelivery } from './stockMaterials';
import { LAYER_KINDS, classifyLayer, createArtwork, makeProcess, type LayerKind } from './layers';
import { CanvasColorSamplingActiveContext, CanvasColorSamplingContext, LayerAppearanceEditor, LayerGeometry, StyleAction, StyleSection } from './LayerStylePanel';
import InspectorMenu from './InspectorMenu';
import LayerTypography, { type FontPreviewStyle } from './LayerTypography';
import type { TextDraft } from './textStyles';
import { activeImageFill, copyAppearance, pasteAppearance, type LayerAppearance } from './layerAppearance';
import AlbumPreview from './AlbumPreview';
import { renderStill, type StillView } from './stillExport';
import ProductionPlanEditor from './ProductionPlanEditor';
import { encodeDigitalImage } from './digitalImage';
import { AutoLayoutProperties, LayoutItemProperties } from './AutoLayoutProperties';
import { applyAutoLayout, autoLayoutOverflow, createAutoLayout, layoutParent, offsetLayoutItem, scaleAutoLayout, setAutoLayout } from './autoLayout';
import ProjectWorkbench from './ProjectWorkbench';
import { factoryProductionOrder, reflectionCount, type ProductionStep } from './production';
import { isRasterProfile, printSubmissionSides, projectPrintProfile, type TechnicalPrintProfile } from './printProfiles';
import { exportFactoryRaster, orientPrintCanvas, printPreflight, type PreflightIssue, type PreflightTarget } from './printPreflight';
import { PRINT_CHANNELS } from './model';
import { createProject, copyProject, uid, TEMPLATE_NAMES, MAX_PROJECT_NOTE_LENGTH, MAX_LAYOUT_ITEM_OFFSET, PROCESS_LABELS, FLASH_STYLES, getFlashStyle, getStockReflection, getStockFinish, getCardCornerRadiusMm, plateFor, processKind, effectInProduction, type Project, type SideName, type CardSide, type CardNode, type Region, type Effect, type ProcessKind, type EffectType, type ImageCrop, type StockSpec, type StockFinish, type FlashStyle } from './model';
import { cropForImageReplacement, renderCard } from './render';
import { ensureProjectFonts, projectFontProblems } from './artworkFonts';
import { buildVectorArtwork, printNodeBounds, vectorPlateContours } from './vectorPrint';
import { rasterizeLocalSvg, readEditableSvg } from './svgImport';
import { buildProjectArchive, exportProject, inspectProjectArchive, downloadBlob, readImage } from './io';
import { accountWorkspace, archiveProject, changeWorkspace, currentWorkspace, createStoredProject, listProjects, openLibrary, projectWorkspace, ProjectRequestError, readProject, recordAssetUse, workspaceHeaders, workspaceSignal, type ProjectSummary, type StoredProject } from './projects';
import { useProjectSave } from './useProjectSave';
import { LayerContextMenu, type LayerCommand, type MenuPoint } from "./LayerContextMenu";
import { frozenRegionCopies, pasteLayerSelection, moveArtworkGroup, moveCanvasLayerUnits, transferArtwork, transferGroup, transferProcess } from './transferLayer';
import { buildLayerTree, findLayerGroup, groupLayers, layerGroupAncestors, layerGroupMembers, pruneLayerGroups, renameLayerGroup, reorderLayerUnits, ungroupLayer, type LayerTreeItem, type LayerUnitRef as LayerUnit } from './layerGroups';
import FigmaIcon from './FigmaIcon';
import { browserRuntime } from './runtime';
import './project-library.css';
import './export-model-preview.css';
import { supportsMaterialModel, type ModelShading } from './modelMaterialSupport';
import { mapVectorPoints } from './vectorPaths';

const MATERIALS = STOCKS;
const PROCESS_MENU_OPTIONS = LAYER_KINDS.filter(([kind]) => kind !== 'artwork')
 .map(([value, label]) => ({ value, label }));
const LAYER_DRAG_TYPE = 'application/x-prism-layer';
const PROCESS_VIEWS = [
 {id:'all',label:'全部',plate:null},
 {id:'foil',label:'箔版',plate:'foil'},
 {id:'white',label:'白墨',plate:'white'},
 {id:'varnish',label:'光油',plate:'clear'},
 {id:'reflection',label:'闪光',plate:null},
] as const;
type ProcessView = typeof PROCESS_VIEWS[number]['id'];
const ARTWORK_LAYER_ICONS = {
 empty:'layer-default',image:'layer-default',text:'layer-text',rect:'layer-rectangle',
 polygon:'layer-polygon',line:'layer-line',path:'layer-pen',
} as const;
const processName=(effect:Effect)=>PROCESS_LABELS[processKind(effect)];
const acceptsNativePaste=(target:EventTarget|null)=>target instanceof Element&&Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
const sameCanvasFace=(a:CanvasFace|undefined,b:CanvasFace)=>a?.cardId===b.cardId&&a.face===b.face;
const canvasFaceLockedIn=(project:Project,target:CanvasFace)=>Boolean(projectCards(project).find(card=>card.id===target.cardId)?.[target.face].canvasLocked);
const layerRemovalLocked=(face:CardSide,target:Removal)=>face.canvasLocked||
 face.nodes.some(node=>node.locked&&target.artworkIds.includes(node.id));
const layerInSelection=(face:CardSide,units:LayerUnit[],item:LayerUnit,parent?:string)=>
 units.some(unit=>unit.kind===item.kind&&unit.id===item.id)||
 layerGroupAncestors(face,parent).some(group=>units.some(unit=>unit.kind==='group'&&unit.id===group.id));
type EditorCommandId='copy'|'paste'|'replace'|'group'|'swap-faces'|'add'|'cover'|'mask'|'lock'|'ungroup'|'flipX'|'flipY'|'delete';
type EditorCommand=LayerCommand&{id:EditorCommandId};
const boardTargets=(cardId:string,singleSided?:boolean):CanvasFace[]=>singleSided
 ? [{cardId,face:'front'}] : [{cardId,face:'back'},{cardId,face:'front'}];
function canvasPixel(container: HTMLElement, x: number, y: number) {
 const canvas=container.querySelector<HTMLCanvasElement>('.konvajs-content canvas');
 const bounds=canvas?.getBoundingClientRect();
 if(!canvas||!bounds?.width||!bounds.height||x<bounds.left||x>=bounds.right||y<bounds.top||y>=bounds.bottom)return null;
 try {
  const pixel=canvas.getContext('2d')?.getImageData(Math.floor((x-bounds.left)*canvas.width/bounds.width),Math.floor((y-bounds.top)*canvas.height/bounds.height),1,1).data;
  if(!pixel?.[3])return null;
  return '#'+Array.from(pixel.slice(0,3),value=>value.toString(16).padStart(2,'0')).join('');
 }catch{return null}
}
function Button({children,title,onClick,active=false,disabled=false,className=''}:{children:ReactNode,title?:string,onClick?:()=>void,active?:boolean,disabled?:boolean,className?:string}){return <button type="button" title={title} aria-label={title} aria-pressed={active||undefined} disabled={disabled} className={`button ${active?'active':''} ${className}`} onClick={onClick}>{children}</button>}
function IconButton({icon,...props}:{icon:typeof Plus|ReactElement,title:string,onClick:()=>void,active?:boolean,disabled?:boolean}) {
 if (isValidElement(icon)) return <Button {...props} className="icon-button">{icon}</Button>;
 const Icon = icon;
 return <Button {...props} className="icon-button"><Icon size={17} strokeWidth={1.65}/></Button>;
}

function LayerGroupName({name,onRename}:{name:string;onRename:(name:string)=>void}){
 const [draft,setDraft]=useState<string|null>(null);
 return <input className="inspector-layer-name" aria-label="图层组名称" maxLength={100} value={draft??name} title={name}
  onChange={event=>setDraft(event.target.value)}
  onBlur={()=>{if(draft!==null)onRename(draft);setDraft(null)}}
  onKeyDown={event=>{
   if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}
   if(event.key==='Escape'){event.stopPropagation();setDraft(null)}
  }} data-undo-draft={draft!==null||undefined}/>;
}
let activeModalCount=0;
let pageOverflowBeforeDialogs='';
function Modal({title,children,onClose,wide=false,drawer=false,className='',closeDisabled=false,contentRef}:{
 title:string;children:ReactNode;onClose:()=>void;wide?:boolean;drawer?:boolean;className?:string;closeDisabled?:boolean;
 contentRef?:Ref<HTMLDivElement>
}) {
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  const dialog=ref.current!;
  const trigger=document.activeElement;
  dialog.showModal();
  if(!activeModalCount)pageOverflowBeforeDialogs=document.body.style.overflow;
  activeModalCount++;
  document.body.style.overflow='hidden';
  return ()=>{
   dialog.close();
   if(!--activeModalCount)document.body.style.overflow=pageOverflowBeforeDialogs;
   if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus({preventScroll:true});
  };
 },[]);
 return <dialog ref={ref} className={`modal ${wide?'wide':''} ${drawer?'drawer':''} ${className}`} aria-label={title}
   onCancel={event=>{event.preventDefault();onClose()}}
   onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div className="modal-content" ref={contentRef}>
   <div className="modal-head"><h2>{title}</h2><IconButton icon={X} title="关闭" onClick={onClose} disabled={closeDisabled}/></div>
   {children}
  </div>
 </dialog>;
}
function Range({label,value,onChange,min=0,max=100,step=1,unit='%'}:{label:string,value:number,onChange:(n:number)=>void,min?:number,max?:number,step?:number,unit?:string}){return <label className="range-field"><span>{label}<b>{Math.round(value*10)/10}{unit}</b></span><input type="range" aria-label={label} value={value} min={min} max={max} step={step} onChange={e=>onChange(+e.target.value)}/></label>}

function FlashStyles({value,onChange,disabled=false}:{value:FlashStyle;onChange:(style:FlashStyle)=>void;disabled?:boolean}) {
 return <fieldset className="flash-styles" disabled={disabled}>
  <legend>闪光样式</legend>
  <div className="flash-style-grid">
   {(Object.keys(FLASH_STYLES) as FlashStyle[]).map(style=><label className="flash-style" key={style}>
    <input type="radio" name="flash-style" className="sr-only" checked={value===style} onChange={()=>onChange(style)}/>
    <span className={`flash-swatch ${style}`} aria-hidden="true"/>
    <span>{FLASH_STYLES[style].label}</span>
   </label>)}
  </div>
 </fieldset>;
}

const RECENT_PROJECTS_KEY = 'prism-recent-projects';
const RECENT_PROJECTS_LIMIT = 20;
const MAGIC_MOUSE_ZOOM_KEY = 'prism-magic-mouse-zoom';

function readRecentProjects(scope: string): string[] {
 if(!projectWorkspace(scope))return [];
 try {
  const values: unknown = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY+':'+scope) || '[]');
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string'))].slice(0, RECENT_PROJECTS_LIMIT) : [];
 } catch { return []; }
}

type CopiedLayers = { origin:CardSide;units:LayerUnit[];marker:string;projectId:string;source:CanvasFace };

export default function App() {
 const [items,setItems]=useState<ProjectSummary[]>([]);
 const [recentIds,setRecentIds]=useState<string[]>([]);
 const [workspace,setWorkspace]=useState(currentWorkspace);
 const [entry,setEntry]=useState<{record:StoredProject;key:string;preview:boolean}|null>(null);
 const [copied,setCopied]=useState<CopiedLayers>();
 const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 const [failure,setFailure]=useState('');
 const [archived,setArchived]=useState(false);
 const [newOpen,setNewOpen]=useState(false);
 const [operation,setOperation]=useState('');
 const [workbenchVersion,setWorkbenchVersion]=useState(0);
 const [link,setLink]=useState(accountLink);
 const [loginRequired,setLoginRequired]=useState(false);
 const [importDraft,setImportDraft]=useState<{project:Project;name:string;fonts:string[];install:()=>Promise<void>}>();
 const [archiveTarget,setArchiveTarget]=useState<ProjectSummary|null>(null);
 const fileInput=useRef<HTMLInputElement>(null);
 const workbench=useRef<HTMLDivElement>(null);
 const returnScroll=useRef<number|null>(null);
 const opening=useRef(false);
 const restoreEntry=useRef<{id:string;scope:string;preview:boolean}|undefined>(undefined);
 const projectLink=useRef(new URLSearchParams(location.search));
 const loginAction=useRef<(()=>void)|undefined>(undefined);
 const accountReturnHash=useRef<string|undefined>(undefined);

 useEffect(()=>{
  const changed=(event:HashChangeEvent)=>{
   const next=accountLink();
   if(next&&event.oldURL){
    const before=new URL(event.oldURL).hash;
    if(!accountLink(before))accountReturnHash.current=before;
   }
   setLink(next);
  };
  window.addEventListener('hashchange',changed);
  return()=>window.removeEventListener('hashchange',changed);
 },[]);
 const closeAccountLink=()=>{
  setLink(undefined);setLoginRequired(false);
  if(accountLink()){
   const intended=pendingCopy();
   const hash=accountReturnHash.current??(intended?'#/community/'+encodeURIComponent(intended.id):'');
   accountReturnHash.current=undefined;
   window.history.replaceState(null,'',location.pathname+location.search+hash);
   window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
 };
 const cancelAccountLink=()=>{
  loginAction.current=undefined;
  projectLink.current=new URLSearchParams();
  closeAccountLink();
 };
 const completeAccount=(user:Account)=>{
  const pending=loginAction.current;
  loginAction.current=undefined;
  changeWorkspace(user.id);
  closeAccountLink();
  pending?.();
 };
 const requireAccount=(action?:()=>void)=>{
  if(projectWorkspace()){action?.();return;}
  if(browserRuntime){setFailure('当前站点未连接账号服务');return;}
  restoreEntry.current=undefined;
  loginAction.current=action;
  setLoginRequired(true);
 };

 const enter=useCallback((record:StoredProject,preview=false)=>{
  if(record.archivedAt!==null)throw new Error('此卡牌已归档，恢复后即可编辑。');
  if(workbench.current)returnScroll.current=window.scrollY;
  const params=new URLSearchParams({project:record.id});
  if(preview)params.set('preview','1');
  window.history.replaceState(null,'','?'+params);
  setEntry({record,key:uid(),preview});
  const scope=currentWorkspace();
  const recent = [...new Set([record.id,...readRecentProjects(scope)])].slice(0,RECENT_PROJECTS_LIMIT);
  setRecentIds(recent);
  try { localStorage.setItem(RECENT_PROJECTS_KEY+':'+scope,JSON.stringify(recent)); } catch { /* Keep the workbench usable without storage access. */ }
 },[]);

 const refresh=useCallback(async()=>{
  const guard=workspaceSignal();
  setStatus('loading');setFailure('');
  try {
   const loaded=await openLibrary();
   if(guard.aborted)return;
   const scope=currentWorkspace();
   setWorkspace(scope);setItems(loaded);setRecentIds(readRecentProjects(scope));setStatus('ready');
   const linked=projectLink.current.get('project');
   const preview=projectLink.current.has('preview');
   if(!projectWorkspace(scope)){
    if(linked||preview){
     window.history.replaceState(null,'',location.pathname+location.hash);
     if(browserRuntime)setFailure('当前站点未连接账号服务');
     else if(!accountLink())setLoginRequired(true);
    }
    return;
   }
   if(!accountLink()){
    const pending=loginAction.current;
    loginAction.current=undefined;
    setLoginRequired(false);
    pending?.();
   }
   const returning=restoreEntry.current?.scope===scope?restoreEntry.current:undefined;
   const target=linked||returning?.id||(preview?loaded.find(item=>item.archivedAt===null)?.id:undefined);
   projectLink.current=new URLSearchParams();
   if(target){
    restoreEntry.current=undefined;
    try {
     const record=await readProject(target);
     if(!guard.aborted)enter(record,preview||!!returning?.preview);
    } catch(error) {
     if(!guard.aborted){
      window.history.replaceState(null,'',location.pathname+location.hash);
      setFailure((error as Error).message);
     }
    }
   }
  } catch(error) {
   if(!guard.aborted){setFailure((error as Error).message);setStatus('error');}
  }
 },[enter]);
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{
  const changed=(event:Event)=>{
   const {previous,scope}=(event as CustomEvent<{previous:string;scope:string}>).detail;
   if(entry){
    if(accountWorkspace(previous))restoreEntry.current={id:entry.record.id,scope:previous,preview:entry.preview};
    setEntry(null);
    window.history.replaceState(null,'',location.pathname+location.hash);
   }
   if(projectWorkspace(previous)){
    loginAction.current=undefined;
    setLoginRequired(false);
    setWorkbenchVersion(n=>n+1);
   }
   setWorkspace(scope);setCopied(undefined);setItems([]);setRecentIds([]);setArchived(false);
   setFailure('');setImportDraft(undefined);setArchiveTarget(null);setNewOpen(false);
   void refresh();
  };
  const external=(event:StorageEvent)=>{
   if(event.key!=='prism-account-switch')return;
   changeWorkspace('',false,true);
  };
  window.addEventListener('prism-workspace-changed',changed);
  window.addEventListener('storage',external);
  return()=>{window.removeEventListener('prism-workspace-changed',changed);window.removeEventListener('storage',external);};
 },[entry,refresh]);
 useEffect(()=>{
  if(browserRuntime)return;
  const check=()=>{
   if(!accountWorkspace()||document.hidden)return;
   void communityRequest<Account|null>('session').then(account=>{
    if(account&&account.id!==currentWorkspace()&&accountWorkspace())changeWorkspace('',false);
   }).catch(()=>{});
  };
  window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);
  const timer=window.setInterval(check,30_000);
  return()=>{window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check);window.clearInterval(timer);};
 },[]);
 const backToLibrary=()=>{
  restoreEntry.current=undefined;
  window.history.replaceState(null,'',location.pathname);
  setEntry(null);setFailure('');
  void refresh();
 };
 const openSavedAsset=(id:string,version:number)=>{
  const hash='#/assets?'+new URLSearchParams({asset:id,v:String(version)});
  window.history.replaceState(null,'',location.pathname+hash);
  setEntry(null);setFailure('');void refresh();
 };
 useLayoutEffect(()=>{
  if(entry) {
   window.scrollTo(0,0);
   return;
  }
  if(status==='loading'||returnScroll.current===null)return;
  const scroll=returnScroll.current;
  returnScroll.current=null;
  if(status==='ready')window.scrollTo(0,scroll);
 },[entry,status]);
 const perform=async(label:string,action:(guard:AbortSignal)=>Promise<void>)=>{
  if(opening.current)return;
  const guard=workspaceSignal();
  opening.current=true;setOperation(label);setFailure('');
  try {await action(guard)}
  catch(error){if(!guard.aborted)setFailure((error as Error).message)}
  finally{opening.current=false;setOperation('')}
 };
 const open=(item:ProjectSummary)=>void perform('正在打开项目…',async guard=>{
  const record=await readProject(item.id);
  guard.throwIfAborted();
  enter(record);
 });
 const importFile=(file:File)=>void perform('正在读取项目包…',async guard=>{
  const archive=await inspectProjectArchive(file);
  guard.throwIfAborted();
  const fonts=await archive.fontIssues();
  guard.throwIfAborted();
  const project=copyProject(archive.project);
  setImportDraft({project,name:project.name,fonts,install:archive.installFonts});
 });
 const duplicate=(item:ProjectSummary)=>void perform('正在复制项目…',async guard=>{
  const {project}=await readProject(item.id);
  guard.throwIfAborted();
  const record=await createStoredProject(copyProject(project,project.name.slice(0,494)+' 副本',1));
  guard.throwIfAborted();
  enter(record);
 });
 const changeArchived=(item:ProjectSummary,archived:boolean)=>void perform(archived?'正在归档…':'正在恢复…',async()=>{
  try {
   const updated=await archiveProject(item,archived);
   setItems(all=>all.map(row=>row.id===updated.id?updated:row));
   setArchiveTarget(null);
  } catch(error) {
   if(error instanceof ProjectRequestError&&error.status===409){
    const latest=await listProjects().catch(()=>null);
    if(latest){setItems(latest);setArchiveTarget(null);}
   }
   throw error;
  }
 });
 const accountDialog=!browserRuntime&&(link||loginRequired)?<AccountForm key={link?.token??'reauth'} initial={link?.mode??'login'} token={link?.token}
  onDone={completeAccount} onClose={cancelAccountLink} onMailLink={()=>setLoginRequired(false)}/>:null;
 if(entry)return <><Editor key={entry.key} record={entry.record} initialPreview={entry.preview}
  copied={copied} setCopied={setCopied} onBack={backToLibrary} onOpen={enter} onViewAsset={openSavedAsset}/>{accountDialog}</>;

 const filtered=items.filter(item=>(item.archivedAt!==null)===archived);
 return <div className="project-library" ref={workbench}>
  <input ref={fileInput} type="file" accept=".cardproj" hidden onChange={event=>{
   const file=event.target.files?.[0];event.target.value='';if(file&&projectWorkspace())importFile(file);
  }}/>
  <ProjectWorkbench key={workbenchVersion} items={filtered} recent={[...filtered].sort((a,b)=>{
    const ar=recentIds.indexOf(a.id),br=recentIds.indexOf(b.id);
    return (ar<0?Infinity:ar)-(br<0?Infinity:br)||b.updatedAt-a.updatedAt;
   }).slice(0,4)}
   archived={archived} ready={status==='ready'} offline={status==='error'} workspace={workspace}
   busy={!!operation} message={failure||operation} error={!!failure}
   onSetArchived={setArchived} requireAccount={requireAccount}
   onRefresh={()=>void refresh()} onImport={()=>requireAccount(()=>fileInput.current?.click())}
   onCreate={()=>requireAccount(()=>{setFailure('');setNewOpen(true)})} onOpen={open}
   onArchive={setArchiveTarget} onRestore={item=>changeArchived(item,false)} onDuplicate={duplicate}
   onExport={item=>void perform('正在打包项目…',async guard=>{
    const {project}=await readProject(item.id);
    guard.throwIfAborted();
    await exportProject(project);
   })}/>
  {accountDialog}
  {newOpen&&<NewProject pending={operation!==''} error={failure} onClose={()=>{if(!operation){setFailure('');setNewOpen(false)}}} onCreate={project=>void perform('正在创建项目…',async guard=>{
   const record=await createStoredProject(project);guard.throwIfAborted();
   setNewOpen(false);enter(record);
  })}/>}
  {importDraft&&<Modal title="导入项目副本" className="member-modal" onClose={()=>{if(!operation)setImportDraft(undefined)}}>
   <form className="card-manager-body" onSubmit={event=>{
    event.preventDefault();const draft=importDraft,name=draft.name.trim();if(!name)return;
    void perform('正在导入…',async guard=>{
     guard.throwIfAborted();
     await draft.install();
     guard.throwIfAborted();
     const record=await createStoredProject({...draft.project,name});
     guard.throwIfAborted();
     setImportDraft(undefined);enter(record);
    });
   }}>
    <label className="field">项目名称<input maxLength={500} value={importDraft.name} onChange={event=>setImportDraft({...importDraft,name:event.target.value})}/></label>
    <p>{projectCards(importDraft.project).length} 张卡</p>
    {importDraft.fonts.map(message=><p key={message}>{message}</p>)}
    {failure&&<p role="alert">{failure}</p>}
    <div className="member-bar"><button type="button" disabled={!!operation} onClick={()=>setImportDraft(undefined)}>取消</button>
    <button type="submit" disabled={!!operation||!importDraft.name.trim()}>导入副本</button></div>
   </form>
  </Modal>}
  {archiveTarget&&<Modal title="归档卡牌" onClose={()=>{if(!operation)setArchiveTarget(null)}}>
   <div className="new-content"><p className="library-dialog-copy">「{archiveTarget.name}」会移到「已归档」，可随时恢复。</p>{failure&&<p className="library-error" role="alert">{failure}</p>}</div>
   <div className="modal-footer"><Button disabled={!!operation} onClick={()=>setArchiveTarget(null)}>取消</Button><Button className="primary" disabled={!!operation} onClick={()=>changeArchived(archiveTarget,true)}>归档卡牌</Button></div>
  </Modal>}
 </div>;
}

function Editor({record,initialPreview,copied,setCopied,onBack,onOpen,onViewAsset}:{
 record:StoredProject;
 initialPreview:boolean;
 copied:CopiedLayers|undefined;
 setCopied:(value:CopiedLayers|undefined)=>void;
 onBack:()=>void;
 onOpen:(record:StoredProject)=>void;
 onViewAsset:(id:string,version:number)=>void;
}) {
 const [project,setProject]=useState(()=>lastOpenedCard(record.project));
 const [retainedDraft,setRetainedDraft]=useState<Awaited<ReturnType<typeof findAccountDraft>>>();
 const [memberBusy,setMemberBusy]=useState(false);
 const [conflictLatest,setConflictLatest]=useState<StoredProject>();
 const memberLock=useRef(false);
 const memberViews=useRef(new Map<string,{face:SideName;selected:string|null;units:LayerUnit[];camera?:Camera}>());
 const [boardSelection,setBoardSelection]=useState<CanvasFace[]>([]);
 const [canvasSelection,setCanvasSelection]=useState<CanvasMarqueeSelection>();
 const [cardSelection,setCardSelection]=useState<string>();
 const [boardDisclosure,setBoardDisclosure]=useState<Record<string,boolean>>({});
 const singleBoard=boardSelection.length===1?boardSelection[0]:undefined;
 const multiBoard=boardSelection.length>1;
 const [faceMenu,setFaceMenu]=useState<{screen:MenuPoint;canvas?:boolean;target?:CanvasFace}>();
 const [copiedFace,setCopiedFace]=useState<ProjectCard>();
 const closeFaceMenu=useCallback(()=>setFaceMenu(undefined),[]);
 const focusMember=useRef<{id:string;view?:Camera}|null>(null);
 const [selectedSide,setSide]=useState<SideName>('front'),[selectedId,setSelected]=useState<string|null>(null);
 const side=project.singleSided?'front':selectedSide;
 const [inspectorTab,setInspectorTab]=useState<'design'|'properties'>('design');
 const [processView,setProcessView]=useState<ProcessView>('all');
 const [tool,setTool]=useState<EditorTool>('select');
 const [finishedView,setFinishedView]=useState(false);
 const [magicMouseZoom,setMagicMouseZoom]=useState(()=>{
  try { return localStorage.getItem(MAGIC_MOUSE_ZOOM_KEY)==='1'; }
  catch { return false; }
 });
 function toggleMagicMouseZoom(){
  const next=!magicMouseZoom;
  setMagicMouseZoom(next);
  try {
   if(next)localStorage.setItem(MAGIC_MOUSE_ZOOM_KEY,'1');
   else localStorage.removeItem(MAGIC_MOUSE_ZOOM_KEY);
  } catch { /* Keep the setting usable for this session when storage is unavailable. */ }
 }
 const navigationRef=useRef<CanvasNavigation>(null);
 const [spaceHeld,setSpaceHeld]=useState(false);
 const usedSpaceForPan=useRef(false);
 const startSpacePan=useCallback(()=>{usedSpaceForPan.current=true},[]);
 const [layerSelection,setLayerSelection]=useState<LayerUnit[]>([]);
 const [textEdit,setTextEdit]=useState<{face:SideName;id:string}>();
 const [fontPreview,setFontPreview]=useState<{cardId?:string;face:SideName;node:CardNode;style:FontPreviewStyle}>();
 const [closedGroups,setClosedGroups]=useState<Set<string>>(()=>new Set());
 const [showLayerMask,setShowLayerMask]=useState(false);
 const [gradientEditing,setGradientEditing]=useState<string|null>(null);
 const [appearanceClipboard,setAppearanceClipboard]=useState<LayerAppearance|null>(null);
 const [radialEditing,setRadialEditing]=useState<{layerId:string;effectId:string}>();
 const [layerPlate,setLayerPlate]=useState<string>();
 const [replaceCrop,setReplaceCrop]=useState(true);
 const [layerQuery,setLayerQuery]=useState('');
 const [layerSearchOpen,setLayerSearchOpen]=useState(false);
 const layerSearchInput=useRef<HTMLInputElement>(null);
 const [regionDraft,setRegionDraft]=useState<Region|null>(null),[brushSize,setBrushSize]=useState(32);
 const [maskSelection,setMaskSelection]=useState<PathPoint[]|null>(null);
 const maskSelectionTool=tool==='mask-marquee'||tool==='mask-pen';
 const [modal,setModal]=useState<'members'|'deliveryHistory'|'lanShare'|'publishAsset'|'pickAsset'|'rename'|'preview'|'size'|'export'|'crop'|'maskContent'|'maskUnion'|'production'|'stockMatch'|null>(initialPreview?'preview':null);
 const [exportEntry,setExportEntry]=useState<'image'|'print'>('image');
 const [proof,setProof]=useState<ProofSettings>();
 const [proofOpen,setProofOpen]=useState(false),[proofReturn,setProofReturn]=useState(false);
 useEffect(()=>{setProof(undefined);setProofOpen(false);setProofReturn(false)},[project.cardId]);
 const [maskScope,setMaskScope]=useState(false);
 const [removeMask,setRemoveMask]=useState<{id:string;users:string[];fixed?:ReturnType<typeof frozenRegionCopies>}>();
 const [stillView,setStillView]=useState<StillView>();
 const [stockChange,setStockChange]=useState<{material:string;stockSpec:StockSpec}>();
 const [returnToPlan,setReturnToPlan]=useState(false);
 const [proposedSize,setProposedSize]=useState<Partial<CardSpecification>>();
 const [toast,setToast]=useState('');
 const [leaving,setLeaving]=useState(false);
 const [readingImages,setReadingImages]=useState(0);
 const [imageIssue,setImageIssue]=useState<{message:string;replacement:string|null}|null>(null);
 const [svgRasterChoice,setSvgRasterChoice]=useState<{reason:string;resolve:(allow:boolean)=>void}>();
 const pendingSvgChoice=useRef<typeof svgRasterChoice>(undefined);
 useEffect(()=>()=>{
  pendingSvgChoice.current?.resolve(false);
  pendingSvgChoice.current=undefined;
 },[]);
 const finishSvgRasterChoice=(allow:boolean)=>{
  const choice=pendingSvgChoice.current;
  pendingSvgChoice.current=undefined;
  setSvgRasterChoice(undefined);
  choice?.resolve(allow);
 };
 const [sampler,setSampler]=useState<{id:string;side:SideName;apply:(color:string)=>void}|null>(null);
 const [sampleColor,setSampleColor]=useState<string|null>(null);
 const [dragged,setDragged]=useState<string|null>(null);
 const [dropAt,setDropAt]=useState<{id:string;placement:'before'|'inside'|'after'}|null>(null);
 const sidebarDrag=useRef<(LayerUnit&{face:SideName;locked?:boolean})|null>(null);
 const [sidebarDropFace,setSidebarDropFace]=useState<SideName>();
 const [collapsedLeft,setCollapsedLeft]=useState(false),[collapsedRight,setCollapsedRight]=useState(false);
 const [confirmDelete,setConfirmDelete]=useState<Removal|null>(null);
 const [confirmMove,setConfirmMove]=useState<{side:SideName;names:string[];apply:()=>void}>();
 const history=useRef<Project[]>([]),future=useRef<Project[]>([]),current=useRef(project);
 const fileInput=useRef<HTMLInputElement>(null),replaceId=useRef<string|null>(null);
 const whiteInput=useRef<HTMLInputElement>(null);
 const whiteUploadTarget=useRef<{id:string;face:SideName}|null>(null);
 const layerList=useRef<HTMLDivElement>(null);
 const pastedLayerFocus=useRef<LayerUnit|undefined>(undefined);
 const inLayerList=(target:EventTarget|null)=>target instanceof Node&&Boolean(layerList.current?.contains(target));
 const sidebarLayer=(unit:LayerUnit)=>layerList.current?.querySelector(
  `[${unit.kind==='group'?'data-layer-group-id':'data-layer-id'}="${CSS.escape(unit.id)}"]`);
 const {state:save,queueSave,saveNow,refresh:refreshProject}=useProjectSave(record,current);
 const editorAccount=useRef(currentWorkspace());
 useEffect(()=>{
  const account=editorAccount.current;
  if(!accountWorkspace(account))return;
  let live=true;
  void findAccountDraft(account,record.id).then(draft=>{
   if(!live||!draft)return;
   const savedDocument=serializeProject(record.project);
   const draftDocument=serializeProject({...draft.project,version:record.project.version,updatedAt:record.project.updatedAt});
   if(draft.revision===record.revision||JSON.stringify(draftDocument)!==JSON.stringify(savedDocument))setRetainedDraft(draft);
   else void discardAccountDraft(account,record.id).catch(()=>{});
  }).catch(()=>{});
  return()=>{live=false;};
 },[record.id,record.project,record.revision]);
 const editorHasDraft=useRef(false);
 editorHasDraft.current=Boolean(modal||regionDraft||textEdit||readingImages||leaving||proofOpen);
 useEffect(()=>{
  let alive=true;
  const check=()=>{
   if(document.hidden||!alive)return;
   void refreshProject(()=>!alive||editorHasDraft.current||Boolean(navigationRef.current?.hasPathDraft()),row=>{
    if(!alive)return;
    const id=current.current.cardId;
    const next=id&&projectCards(row.project).some(card=>card.id===id)?projectAtCard(row.project,id):row.project;
    history.current=[];future.current=[];current.current=next;setProject(next);
    setSelected(null);setCardSelection(undefined);setBoardSelection([]);setCanvasSelection(undefined);setFaceMenu(undefined);setLayerSelection([]);setProcessView('all');setLayerPlate(undefined);
   }).catch(()=>{/* Keep the local draft available while offline. */});
  };
  window.addEventListener('focus',check);window.addEventListener('online',check);
  document.addEventListener('visibilitychange',check);
  return()=>{alive=false;window.removeEventListener('focus',check);window.removeEventListener('online',check);document.removeEventListener('visibilitychange',check)};
 },[refreshProject]);
 const saveError=save.status==='error'||save.status==='conflict';
 const saveState=save.status==='saved'?(browserRuntime?'已保存到此浏览器':'已保存到本机'):save.status==='saving'?'正在保存…':save.status==='conflict'?'有更新冲突':'保存失败';
 const active=project[side],selected=active.nodes.find(n=>n.id===selectedId&&n.type!=='empty'),effect=active.effects.find(e=>e.id===selectedId);
 const selectedUnits=layerSelection.filter(unit=>unit.kind==='group'?findLayerGroup(active,unit.id):
  unit.kind==='artwork'?active.nodes.some(node=>node.id===unit.id&&node.type!=='empty'):active.effects.some(entry=>entry.id===unit.id));
 const selectedGroup=selectedUnits.length===1&&selectedUnits[0].kind==='group'?findLayerGroup(active,selectedUnits[0].id):undefined;
 const parentLayout=layoutParent(active,selected?.id??selectedGroup?.id??'')?.autoLayout;
 const selectionUnits:LayerUnit[]=selected? [{kind:'artwork',id:selected.id}]
  :effect?[{kind:'process',id:effect.id}]:selectedUnits;
 const selectionParts={
  artworkIds:selectionUnits.filter(item=>item.kind==='artwork').map(item=>item.id),
  effectIds:selectionUnits.filter(item=>item.kind==='process').map(item=>item.id),
  groupIds:selectionUnits.filter(item=>item.kind==='group').map(item=>item.id),
 };
 const groupMembers=selectionParts.groupIds.map(id=>layerGroupMembers(active,id));
 const selectedArtworkIds=[...new Set([...selectionParts.artworkIds,...groupMembers.flatMap(group=>group.artworkIds)])];
 const selectedCount=selectedArtworkIds.length+new Set([...selectionParts.effectIds,...groupMembers.flatMap(group=>group.effectIds)]).size;
 const hasDesign=Boolean(selected&&!regionDraft);
 const designLayer=hasDesign&&inspectorTab==='design'?selected:undefined;
 const radialEffectId=radialEditing?.layerId===designLayer?.id?radialEditing?.effectId:undefined;
 const rightTab=canvasSelection?'multi':designLayer?'design':effect?'effects':selected?'layerProperties':selectedGroup?'group'
  :selectedCount?'multi':cardSelection&&cardSelection===project.cardId?'card':singleBoard?'face':'empty';
 const cropFill=modal==='crop'&&selected?activeImageFill(selected):undefined;
 const targetRegion=active.regions.find(r=>r.id===(effect?.regionId||selected?.clipRegionId));
 const sharedUsers = targetRegion ? maskConsumers(active, dependentRegions(active,[targetRegion.id])).filter(item=>item.id!==selectedId) : [];
 const maskRegions=active.regions.filter(region=>!selected||region.nodeId!==selected.id);
 const maskHighlight=showLayerMask&&!!targetRegion&&!regionDraft;
 const isolatedPlate=effect&&layerPlate===effect.id?plateFor(effect):undefined;
 const plate=regionDraft||maskHighlight?null:isolatedPlate??PROCESS_VIEWS.find(view=>view.id===processView)?.plate??null;
 const flashOnly=processView==='reflection'&&!regionDraft&&!maskHighlight;
 const previewOnCanvas=fontPreview&&fontPreview.cardId===project.cardId&&fontPreview.face===side&&fontPreview.node===designLayer&&
  !modal&&!collapsedRight&&!active.canvasLocked&&!plate&&!flashOnly&&!leaving ? fontPreview : undefined;
 const sampling=Boolean(sampler&&sampler.id===designLayer?.id&&sampler.side===side&&!plate&&!flashOnly&&!modal&&!collapsedRight&&!leaving);
 useEffect(()=>{if(sampler&&!sampling)setSampler(null)},[sampler,sampling]);
 const startSampling=(apply:(color:string)=>void)=>{
  if(!designLayer||designLayer.locked||plate||flashOnly)return;
  setSampleColor(null);setSampler({id:designLayer.id,side,apply});
 };
 useEffect(()=>{
  if(!sampling)return;
  const cancel=(event:KeyboardEvent)=>{
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){setSampler(null);return}
   if(event.key!=='Escape')return;
   event.preventDefault();event.stopImmediatePropagation();setSampler(null);
  };
  const cancelOutside=(event:PointerEvent)=>{
   if(event.target instanceof Element&&!event.target.closest('.canvas-area,.canvas-color-sample,[data-canvas-view-toggle]'))setSampler(null);
  };
  window.addEventListener('keydown',cancel,true);
  document.addEventListener('pointerdown',cancelOutside,true);
  return()=>{window.removeEventListener('keydown',cancel,true);document.removeEventListener('pointerdown',cancelOutside,true)};
 },[sampling]);
 const hasModeNotice=Boolean(regionDraft||plate||flashOnly||maskHighlight);
 const query=layerQuery.trim().toLocaleLowerCase();
 const matchesQuery=(face:CardSide,item:{name:string;groupId?:string})=>!query||item.name.toLocaleLowerCase().includes(query)
  ||layerGroupAncestors(face,item.groupId).some(group=>group.name.toLocaleLowerCase().includes(query));
 const cardTrees=useMemo(()=>projectCards(project).map(card=>{
  const faces=(card.singleSided?['front'] as const:BOTH_FACES).map(slot=>{
   const label=physicalCardFace(card,slot)==='front'?'正面':'背面';
   const face=card[slot];
   const matches=(item:{name:string;groupId?:string})=>card.name.toLocaleLowerCase().includes(query)||label.includes(query)||matchesQuery(face,item);
   const tree=buildLayerTree(face,{
    artwork:processView==='all'?(node:CardNode)=>node.type!=='empty'&&matches(node):false,
    process:(item:Effect)=>(processView==='all'||processKind(item)===processView)&&matches(item),
   });
   return {slot,label,tree};
  }).filter(face=>!query||face.tree.length>0||card.name.toLocaleLowerCase().includes(query)||face.label.includes(query));
  return {card,faces};
 }).filter(entry=>entry.faces.length>0),[project,processView,query]);
 const revealLayer=(face:CardSide,id:string,target:CanvasFace={cardId:current.current.cardId!,face:activeFace.current})=>{
  const {cardId}=target;
  const key=canvasFaceKey(target);
  const inactive=cardId!==current.current.cardId||target.face!==activeFace.current;
  setBoardDisclosure(previous=>previous['card:'+cardId]===false||previous[key]===false||inactive&&previous[key]!==true?
   {...previous,['card:'+cardId]:true,[key]:true}:previous);
  const groupId=face.nodes.find(node=>node.id===id)?.groupId??face.effects.find(item=>item.id===id)?.groupId??findLayerGroup(face,id)?.parentId;
  if(!groupId)return;
  const ancestors=layerGroupAncestors(face,groupId);
  if(ancestors.length)setClosedGroups(previous=>{
   const keys=ancestors.flatMap(group=>[group.id,processView+':'+group.id]);
   if(!keys.some(key=>previous.has(key)))return previous;
   const next=new Set(previous);keys.forEach(key=>next.delete(key));return next;
  });
 };
 const selectLayer=(id:string|null, kind?:LayerKind)=>{
  setCardSelection(undefined);setBoardSelection([]);setCanvasSelection(undefined);setSelected(id);setTextEdit(undefined);setShowLayerMask(false);setLayerSelection([]);setLayerPlate(undefined);
  if(id!==selectedId){
   setGradientEditing(null);
  }
  if(id){
   setCollapsedRight(false);
   if(processView!=='all'&&kind!==processView)setProcessView('all');
   const face=current.current[activeFace.current];
   revealLayer(face,id);
  }
 };
 const changeProcessView=(view:ProcessView)=>{
  setProcessView(view);setLayerPlate(undefined);setShowLayerMask(false);
  setTool('select');
  if(view!=='all'){
   setCollapsedRight(false);
   if(canvasSelection||selectedCount&&(!effect||processKind(effect)!==view))selectLayer(null);
  }
 };
 const activateCanvasTool=(next:EditorTool)=>{
  if(next==='line'||next==='pen'){
   setProcessView('all');setLayerPlate(undefined);setShowLayerMask(false);
  }
  setTool(next);
 };
 useEffect(()=>{
  const focus=pastedLayerFocus.current;
  const unit=focus??(selectedGroup?{kind:'group',id:selectedGroup.id}:selectedId?{kind:effect?'process':'artwork',id:selectedId}:undefined);
  if(!unit)return;
  const row=sidebarLayer(unit);
  row?.scrollIntoView({block:'nearest'});
  if(focus){
   row?.querySelector<HTMLButtonElement>('.layer-select')?.focus({preventScroll:true});
   pastedLayerFocus.current=undefined;
  }
 },[project.cardId,side,selectedId,selectedGroup?.id,layerSelection,boardDisclosure,processView,effect?processKind(effect):undefined]);
 useEffect(()=>{if(layerSearchOpen)layerSearchInput.current?.focus()},[layerSearchOpen]);
 const notify=useCallback((message:string)=>setToast(message),[]);
 useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),3600);return()=>clearTimeout(t)},[toast]);
 const cardBoundsRef=useRef<HTMLDivElement>(null);
 const activeFace=useRef(side);
 const coalesce=useRef<{key:string,time:number}|null>(null);
 const commit=useCallback((next:Project,key?:string,continuous=false)=>{
  const now=Date.now();
  if(!key||coalesce.current?.key!==key||(!continuous&&now-coalesce.current.time>700)){
   history.current.push(current.current);
   history.current=history.current.slice(-60);
  }
  coalesce.current=key?{key,time:now}:null;
  future.current=[];
  const prepare=(face:SideName)=>{
   const previous=current.current,draft=next[face];
   if(next.cardId!==previous.cardId||draft===previous.front||draft===previous.back||
      draft.canvasLocked!==previous[face].canvasLocked)return draft;
   return applyAutoLayout(pruneLayerGroups(draft));
  };
  const updated={...next,front:prepare('front'),back:prepare('back'),version:current.current.version+1,updatedAt:now};
  current.current=updated;
  setProject(updated);
  queueSave();
 },[queueSave]);
 const changeCanvasSide=useCallback((next:CardSide,face:SideName)=>{
  if(!current.current[face].canvasLocked)commit({...current.current,[face]:next});
 },[commit]);
 const changeSide=useCallback((next:CardSide)=>changeCanvasSide(next,side),[changeCanvasSide,side]);
 const changeCardSpecification=(patch:Partial<CardSpecification>)=>{
  const doc=current.current;
  if(doc.front.canvasLocked||doc.back.canvasLocked){notify('请先解锁卡面');return}
  const next={...doc,...patch};
  if(next.widthMm===doc.widthMm&&next.heightMm===doc.heightMm&&next.bleedMm===doc.bleedMm&&
   getCardCornerRadiusMm(next)===getCardCornerRadiusMm(doc))return;
  if((next.widthMm!==doc.widthMm||next.heightMm!==doc.heightMm)&&
      [doc.front,doc.back].some(face=>face.nodes.some(node=>node.type!=='empty')||face.effects.length)){
    setProposedSize(patch);setReturnToPlan(false);setModal('size');return;
  }
  commit({...next,cornerRadiusMm:getCardCornerRadiusMm(next)});
 };
 const changeBase=(material:string,stockSpec:StockSpec)=>{
  const doc=current.current;
  if(doc.front.canvasLocked||doc.back.canvasLocked){notify('请先解锁卡面');return}
  const next={...doc,material,stockSpec};
  if(stockKeys(doc).stockKey===stockKeys(next).stockKey)return;
  if(next.production)next.production={...next.production,stockCode:undefined};
  for(const face of BOTH_FACES){
   const review=doc[face].effects.some(effect=>effectInProduction(effect)&&plateFor(effect));
   next[face]=resetStockFinishMatch(doc,face,review);
  }
  commit(next);
 };
 const changeFinish=(finish:StockFinish,continuous=false)=>{
  const doc=current.current;
  if(!doc[side].canvasLocked)commit({...doc,[side]:{...doc[side],stockFinish:finish}},continuous?'stock-opacity-'+side:undefined,continuous);
 };
 const patchNode=(patch:Partial<CardNode>,continuous=false)=>{
  if(!selectedId)return;
  const doc=current.current;
  const face=doc[side];
  const node=face.nodes.find(item=>item.id===selectedId);
  const keys=Object.keys(patch) as (keyof CardNode)[];
  if(!node||node.locked||face.canvasLocked||keys.every(key=>node[key]===patch[key]))return;
  const next={...node,...patch};
  const delta={x:next.x-node.x,y:next.y-node.y};
  if((delta.x||delta.y)&&layoutParent(face,node.id)){
   next.layoutItem=offsetLayoutItem(next.layoutItem,delta);
   next.x=node.x;next.y=node.y;
  }
  commit({...doc,[side]:{...face,nodes:face.nodes.map(n=>n.id===selectedId?next:n)}},selectedId+keys.join(),continuous);
 };
 const startStyleEdit=()=>{coalesce.current=null};
 const patchStyle=(patch:Partial<CardNode>)=>{
  if(patch.fillHidden||('fillMode' in patch&&patch.fillMode!=='gradient')||('gradient' in patch&&!patch.gradient))setGradientEditing(null);
  patchNode(patch,true);
 };
 const copyStyle=()=>{
  if(!selected)return;
  setAppearanceClipboard(copyAppearance(selected));notify('已复制图层样式');
 };
 const pasteStyle=()=>{
  if(!selected||selected.locked||!appearanceClipboard)return;
  startStyleEdit();patchStyle(pasteAppearance(selected,appearanceClipboard));notify('已粘贴');
 };
 const toggleGradient=()=>{
  if(!selected?.gradient||selected.locked)return;
  setRadialEditing(undefined);
  setGradientEditing(value=>value===selected.id?null:selected.id);
  setTool('select');setShowLayerMask(false);setProcessView('all');setLayerPlate(undefined);
 };
 const alignNode=(axis:'x'|'y',fraction:number)=>{
  if(!selected||selected.locked||parentLayout)return;
  const angle=selected.rotation*Math.PI/180;
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const corners=[[0,0],[selected.width,0],[0,selected.height],[selected.width,selected.height]];
  const coordinates=corners.map(([x,y])=>axis==='x'?x*cos-y*sin:x*sin+y*cos);
  const low=Math.min(...coordinates),high=Math.max(...coordinates);
  const available=(axis==='x'?project.widthMm:project.heightMm)*10;
  patchNode({[axis]:Math.round((available-high+low)*fraction-low)});
 };
 const patchEffect=(patch:Partial<Effect>)=>{
  if(!effect)return;
  const face=current.current[side];
  changeSide({...face,effects:face.effects.map(item=>item.id===effect.id?{...item,...patch}:item)});
 };
 const changeKind=(kind:LayerKind)=>{
  if(!selectedId||selected?.locked||regionDraft)return;
  const doc=current.current;
  const face=doc[side];
  const next=classifyLayer(doc,face,selectedId,kind);
  if(next===face){
   if(effect&&kind==='artwork')notify('此工艺层没有可转换为彩稿的内容');
   return;
  }
  changeSide(next);
  selectLayer(selectedId,kind);
 };
 const visitMember=(next:Project)=>{
  if(next.cardId===current.current.cardId)return;
  const previous=current.current.cardId;
  if(previous)memberViews.current.set(previous,{face:side,selected:selectedId,units:layerSelection,
   camera:navigationRef.current?.captureView(previous)??undefined});
  const view=memberViews.current.get(next.cardId!);
  const face=next.singleSided?'front':view?.face??'front';
  const contents=next[face];
  const valid=new Set([...contents.nodes,...contents.effects,...(contents.groups??[])].map(item=>item.id));
  activeFace.current=face;setSide(face);setSelected(view?.selected&&valid.has(view.selected)?view.selected:null);
  setLayerSelection(view?.units.filter(unit=>valid.has(unit.id))??[]);
  setLayerQuery('');setProcessView('all');setRegionDraft(null);setMaskSelection(null);setTextEdit(undefined);
  setGradientEditing(null);setRadialEditing(undefined);setLayerPlate(undefined);setShowLayerMask(false);
  setCardSelection(undefined);setBoardSelection([]);setCanvasSelection(undefined);setFaceMenu(undefined);setTool('select');setMenu(undefined);setProofReturn(false);
  rememberCurrentCard(next.id,next.cardId!);
 };
 const saveBeforeMemberAction=async(action:()=>void)=>{
  if(memberLock.current)return;
  memberLock.current=true;setMemberBusy(true);
  try {
   if(await saveNow())action();
   else {setModal(null);notify('当前卡尚未保存，请处理保存问题后重试')}
  } catch(error){notify((error as Error).message)}
  finally{memberLock.current=false;setMemberBusy(false)}
 };
 const editMembers=(next:Project)=>{
  setFaceMenu(undefined);visitMember(next);
  if(next.singleSided){activeFace.current='front';setSide('front')}
  commit(next);
 };
 const activateProjectMember=(id:string)=>{
  const next=projectAtCard(current.current,id);
  if(next!==current.current){
   visitMember(next);coalesce.current=null;current.current=next;setProject(next);
  }
 };
 const selectBoards=(boards:CanvasFace[])=>{
  const target=boards.at(-1);
  if(target){
   activateProjectMember(target.cardId);
   if(activeFace.current!==target.face)coalesce.current=null;
   activeFace.current=target.face;setSide(target.face);
   setCollapsedRight(false);
  }
  selectLayer(null);setBoardSelection(boards);
  if(cardSelection&&boards.length===2&&boards.every(board=>board.cardId===cardSelection))setCardSelection(cardSelection);
 };
 const selectCardCombination=(cardId:string)=>{
  const next=projectAtCard(current.current,cardId);
  selectBoards(boardTargets(cardId,next.singleSided));setCardSelection(cardId);
 };
 const addMember=(card:ProjectCard,at?:MenuPoint,selectPair=false)=>{
  let next=insertCanvasCard(current.current,card);
  if(at){
   const origin=canvasLayoutSnapshot(next)[canvasFaceKey({cardId:card.id,face:'front'})];
   next=translateCanvasFaces(next,boardTargets(card.id,card.singleSided),{x:at.x-origin.x,y:at.y-origin.y});
   navigationRef.current?.pinView();
  }else focusMember.current={id:card.id};
  editMembers(next);
  if(selectPair&&!card.singleSided)selectCardCombination(card.id);
  else selectBoards(boardTargets(card.id,true));
 };
 useLayoutEffect(()=>{
  const focus=focusMember.current;
  if(!focus||focus.id!==project.cardId)return;
  focusMember.current=null;
  navigationRef.current?.focusCard(focus.id,focus.view);
 },[project.cardId,project.version]);
 const canChangeBoards=()=>{
  if(regionDraft||readingImages||leaving||memberLock.current)return false;
  if(navigationRef.current?.hasPathDraft()){notify('请按回车完成路径，或按 Esc 取消');return false}
  return true;
 };
 const addBlankOnCanvas=()=>{
  if(!canChangeBoards())return;
  setTool('select');addMember(blankCardAfter(current.current));
 };
 const switchMember=(id:string)=>void saveBeforeMemberAction(()=>{
  const previous=current.current;
  const next=projectAtCard(previous,id);
  setCardSelection(undefined);setBoardSelection([]);setCanvasSelection(undefined);
  if(next===previous){navigationRef.current?.focusCard(id);return}
  focusMember.current={id,view:memberViews.current.get(id)?.camera};
  visitMember(next);coalesce.current=null;current.current=next;setProject(next);
 });
 const reorderMember=(id:string,to:number)=>{
  const doc=current.current,cards=projectCards(doc),from=cards.findIndex(card=>card.id===id);
  if(from<0||from===to||to<0||to>=cards.length)return;
  cards.splice(to,0,cards.splice(from,1)[0]);
  editMembers(preserveCanvasLayout(doc,projectWithMembers(doc,cards,doc.cardId!)));
 };
 const removeMember=()=>{
  const doc=current.current,cards=projectCards(doc),index=doc.activeCardIndex??0;
  if(cards.length<2)return;
  const card=cards[index];
  applyBoardRemoval(boardTargets(card.id,card.singleSided));
 };
 const openMembers=()=>{
  if(navigationRef.current?.hasPathDraft()){notify('请按回车完成路径，或按 Esc 取消');return}
  setModal('members');
 };
 const restoreHistory=(snapshot:Project)=>{
  setCardSelection(undefined);setBoardSelection([]);setCanvasSelection(undefined);setFaceMenu(undefined);visitMember(snapshot);
  if(snapshot.singleSided){activeFace.current='front';setSide('front')}
  const updated={...snapshot,version:current.current.version+1,updatedAt:Date.now()};
  current.current=updated;setProject(updated);queueSave();
 };
 const undo=()=>{
  const previous=history.current.pop();if(!previous)return;
  coalesce.current=null;future.current.push(current.current);restoreHistory(previous);
 };
 const redo=()=>{
  const next=future.current.pop();if(!next)return;
  coalesce.current=null;history.current.push(current.current);restoreHistory(next);
 };
 const leave=async()=>{
  if(leaving||regionDraft||readingImages)return;
  setLeaving(true);
  if(await saveNow())onBack();
  else setLeaving(false);
 };
 const saveCopy=async()=>{
  if(leaving||readingImages)return;
  setLeaving(true);
  try {
   const snapshot=current.current;
   onOpen(await createStoredProject(copyProject(snapshot,snapshot.name.slice(0,494)+' 副本',1)));
  } catch(error) {notify((error as Error).message);setLeaving(false)}
 };
 const viewLatest=async()=>{
  try {setConflictLatest(await readProject(record.id))}
  catch(error){notify((error as Error).message)}
 };
 const openLatest=async()=>{
  if(!conflictLatest||leaving)return;
  setLeaving(true);
  try{
   await exportProject(current.current);
   const latest=await readProject(record.id);
   onOpen(latest);
  }catch(error){notify((error as Error).message);setLeaving(false)}
 };
 const deleteLayers=(target:Removal,removeRelated:boolean)=>{
  changeSide(removeSelection(current.current[side],target,removeRelated));selectLayer(null);setConfirmDelete(null);
 };
 const requestDelete=()=>{
  if(!canChangeBoards())return;
  const doc=current.current;
  if(!canvasSelection){
   const face=doc[side];
   const removal=removalForLayerUnits(face,selectionUnits,selectedGroup?.name??selected?.name??effect?.name);
   if(!removal||face.canvasLocked)return;
   if(layerRemovalLocked(face,removal)){notify('请先解锁选中的图层');return}
   if(selectionUnits.length===1&&sourceMaskImpact(face,removal).ids.size)setConfirmDelete(removal);
   else deleteLayers(removal,false);
   return;
  }
  const cards=projectCards(doc);
  const byId=new Map(cards.map(card=>[card.id,card]));
  const changed=new Map<string,ProjectCard>();
  const activeId=doc.cardId??doc.id+'_1';
  for(const target of canvasSelection.layers){
   const card=changed.get(target.cardId)??byId.get(target.cardId);
   if(!card||target.face==='back'&&card.singleSided)continue;
   const face=card[target.face];
   const removal=removalForLayerUnits(face,target.units);
   if(!removal)continue;
   if(layerRemovalLocked(face,removal)){
    notify('请先解锁选中的图层');return;
   }
   const next=removeSelection(face,removal,false);
   changed.set(card.id,{...card,[target.face]:card.id===activeId?next:applyAutoLayout(pruneLayerGroups(next))});
  }
  if(!changed.size)return;
  commit(projectWithMembers(doc,cards.map(card=>changed.get(card.id)??card),activeId));
  selectLayer(null);
 };
 const duplicateLayer=()=>{
  if(effect){
   const copy={...structuredClone(effect),id:uid(),name:effect.name.slice(0,96)+' 副本'};
   const grouped=findLayerGroup(active,effect.groupId);
   const effects=grouped?active.effects.flatMap(item=>item.id===effect.id?[item,copy]:[item]):[...active.effects,copy];
   changeSide({...active,effects});
   selectLayer(copy.id,processKind(copy));
  }else if(selected){
   const copy={...structuredClone(selected),id:uid(),name:selected.name.slice(0,96)+' 副本',x:selected.x+15,y:selected.y+15,locked:false};
   const grouped=findLayerGroup(active,selected.groupId);
   const nodes=grouped?active.nodes.flatMap(item=>item.id===selected.id?[item,copy]:[item]):[...active.nodes,copy];
   changeSide({...active,nodes});
   selectLayer(copy.id,'artwork');
  }
 };
 const formLayerGroup=()=>{
  if(regionDraft||leaving||selectionUnits.length<2)return;
  const grouped=groupLayers(current.current[side],selectionParts);
  if(!grouped){notify('请选择同一层级的图层或图层组');return}
  changeSide(grouped.side);
  selectLayer(null);
  setLayerSelection([{kind:'group',id:grouped.groupId}]);setCollapsedRight(false);
  setLayerQuery('');
 };
 const dissolveLayerGroup=()=>{
  if(!selectedGroup||regionDraft||leaving)return;
  const next=ungroupLayer(current.current[side],selectedGroup.id);
  if(next===current.current[side])return;
  changeSide(next);
  selectLayer(null);
 };
 const [menu,setMenu]=useState<{screen:MenuPoint;point?:MenuPoint;target?:CanvasFace;sidebar?:boolean}>();
 const closeMenu=useCallback(()=>setMenu(undefined),[]);
 const selectedNodes=active.nodes.filter(node=>selectedArtworkIds.includes(node.id));
 const artworkOnly=selectedNodes.length>0&&selectedNodes.length===selectedCount;
 const editableArtwork=artworkOnly&&!active.canvasLocked&&selectedNodes.every(node=>!node.locked);
 const canAddLayout=editableArtwork&&(Boolean(selectedGroup)||selectionUnits.length>1);
 const toggleAutoLayout=()=>{
  if(regionDraft||leaving)return;
  const face=current.current[side];
  if(selectedGroup?.autoLayout){changeSide(setAutoLayout(face,selectedGroup.id,undefined));return}
  if(!canAddLayout)return;
  const grouped=selectedGroup?{side:face,groupId:selectedGroup.id}:groupLayers(face,selectionParts);
  if(!grouped){notify('请选择同一层级的彩稿图层');return}
  const layout=createAutoLayout(grouped.side,grouped.groupId);
  if(!layout)return;
  changeSide(setAutoLayout(grouped.side,grouped.groupId,layout));
  selectLayer(null);
  setLayerSelection([{kind:'group',id:grouped.groupId}]);setCollapsedRight(false);setLayerQuery('');
 };
 const copySelection=(clipboard?:DataTransfer)=>{
  const marker=`prism-layer:${uid()}`;
  setCopiedFace(undefined);setCopied({origin:active,units:selectionUnits.map(({kind,id})=>({kind,id})),marker,
   projectId:project.id,source:{cardId:project.cardId!,face:side}});
  if(menu?.sidebar&&selectionUnits[0])sidebarLayer(selectionUnits[0])?.querySelector<HTMLButtonElement>('.layer-select')?.focus({preventScroll:true});
  if(clipboard)clipboard.setData('text/plain',marker);
  else void navigator.clipboard?.writeText(marker).catch(()=>{});
 };
 const copyBoards=(clipboard?:DataTransfer)=>{
  const card=copyCanvasFaces(current.current,boardSelection);
  setCopiedFace(card);setCopied(undefined);
  const data=encodeClipboardFace(card);
  if(clipboard)clipboard.setData('text/plain',data);
  else void navigator.clipboard?.writeText(data).catch(()=>{});
 };
 const pasteBoard=(card:ProjectCard,at?:MenuPoint)=>{
  if(!canChangeBoards())return;
  addMember(cloneProjectCard(card),at,true);
 };
 const replaceBoards=(card:ProjectCard)=>{
  if(!canChangeBoards())return;
  try{editMembers(replaceCanvasFaces(current.current,boardSelection,card))}
  catch(error){notify((error as Error).message)}
 };
 const applyBoardRemoval=(targets:CanvasFace[])=>{
  try{
   const next=deleteCanvasFaces(current.current,targets);
   editMembers(next);selectBoards([]);
  }catch(error){notify((error as Error).message)}
 };
 const removeBoards=(targets:CanvasFace[])=>{if(canChangeBoards())applyBoardRemoval(targets)};
 const lockBoards=()=>{
  if(!canChangeBoards())return;
  const doc=current.current;
  const lock=boardSelection.some(target=>!canvasFaceLockedIn(doc,target));
  const cards=projectCards(doc).map(card=>{
   const next={...card};
   for(const {cardId,face} of boardSelection)if(cardId===card.id)next[face]={...card[face],canvasLocked:lock||undefined};
   return next;
  });
  commit(projectWithMembers(doc,cards,doc.cardId!));
 };
 const setProjectCover=(target:CanvasFace)=>{
  const doc=current.current;
  if(!sameCanvasFace(doc.projectCover,target))commit({...doc,projectCover:target});
  notify('已设为项目封面');
 };
 const menuWorldPoint=()=>{
  const screen=faceMenu?.canvas?faceMenu.screen:menu?.point?menu.screen:undefined;
  return screen?navigationRef.current?.worldAt(screen):undefined;
 };
 const separateBoard=(target:CanvasFace)=>{
  if(!canChangeBoards())return;
  try {
   const next=unlinkCanvasFace(current.current,target);
   focusMember.current={id:next.cardId!};editMembers(next);selectBoards([{cardId:next.cardId!,face:'front'}]);
  }catch(error){notify((error as Error).message)}
 };
 const combineBoards=()=>{
  if(!canChangeBoards())return;
  try {
   const next=combineCanvasFaces(current.current,boardSelection);
   if(next!==current.current)editMembers(next);
   selectCardCombination(next.cardId!);
  }catch(error){notify((error as Error).message)}
 };
 const swapBoards=()=>{
  if(!canChangeBoards()||!canSwapCanvasFaces(current.current,boardSelection))return;
  const card=projectAtCard(current.current,boardSelection[0].cardId);
  const next=swapCanvasFaces(current.current,boardSelection);
  const boards=card.singleSided?boardSelection:boardSelection.map(({cardId,face}):CanvasFace=>({
   cardId,face:face==='front'?'back':'front',
  }));
  editMembers(next);selectBoards(boards);
 };
 const moveBoards=(boards:CanvasFace[],delta:{x:number;y:number})=>{
  if(!canChangeBoards()||boards.some(target=>canvasFaceLockedIn(current.current,target)))return;
  const next=translateCanvasFaces(current.current,boards,delta);
  if(next!==current.current)commit(next);
 };
 const moveMarquee=(selection:CanvasMarqueeSelection,delta:MenuPoint)=>{
  if(!canChangeBoards())return;
  const doc=current.current;
  if(selection.boards.some(board=>canvasFaceLockedIn(doc,board)))return;
  let changed=false;
  const cards=projectCards(doc).map(card=>{
   const targets=selection.layers.filter(target=>target.cardId===card.id);
   if(!targets.length)return card;
   const member=projectAtCard(doc,card.id);
   let next=card;
   for(const target of targets){
    if(selection.boards.some(board=>sameCanvasFace(board,target)))continue;
    const face=moveCanvasLayerUnits(member,target.face,target.units,delta);
    if(face!==card[target.face]){next={...next,[target.face]:face};changed=true}
   }
   return next;
  });
  const moved=changed?projectWithMembers(doc,cards,doc.cardId!):doc;
  const next=translateCanvasFaces(moved,selection.boards,delta);
  if(next!==doc)commit(next);
 };
 const pasteSelection=(replace:boolean,destination:SideName,at?:MenuPoint,sidebar=false)=>{
  if(!copied)return;
  const doc=current.current,face=doc[destination];
  if(face.canvasLocked){notify('请先解锁卡面');return}
  const effectIds=[...new Set([...selectionParts.effectIds,...groupMembers.flatMap(group=>group.effectIds)])];
  const target=replace?{artworkIds:selectedArtworkIds,effectIds,parentId:selected?.groupId??effect?.groupId??selectedGroup?.parentId}:undefined;
  const anchors=[...selectedNodes,...active.effects.filter(entry=>effectIds.includes(entry.id)).map(entry=>{
   const region=active.regions.find(item=>item.id===entry.regionId);
   return region?.bounds??active.nodes.find(node=>node.id===region?.nodeId)??{x:0,y:0};
  })];
  const inPlace=sidebar&&!replace&&!at&&copied.projectId===doc.id&&sameCanvasFace(copied.source,{cardId:doc.cardId!,face:destination});
  const point=replace?{x:Math.min(...anchors.map(node=>node.x)),y:Math.min(...anchors.map(node=>node.y))}:at??{x:(selected?.x??0)+15,y:(selected?.y??0)+15};
  const pasted=pasteLayerSelection(doc,copied.origin,face,copied.units,inPlace?'above-original':point,target);
  if(inPlace)pastedLayerFocus.current=pasted.units[0];
  changeCanvasSide(pasted.side,destination);selectUnits(pasted.units,destination);
 };
 const duplicateSidebarLayers=()=>{
  const doc=current.current,face=doc[side];
  if(face.canvasLocked||!selectionUnits.length)return;
  const pasted=pasteLayerSelection(doc,face,face,selectionUnits,'above-original');
  const copy=pasted.units.length===1?pasted.units[0]:undefined;
  const named=<T extends {id:string;name:string}>(item:T):T=>item.id===copy?.id?{...item,name:item.name.slice(0,96)+' 副本'}:item;
  pastedLayerFocus.current=pasted.units[0];
  changeSide({...pasted.side,nodes:pasted.side.nodes.map(node=>node.id===copy?.id?{...named(node),locked:false}:node),
   effects:pasted.side.effects.map(named),groups:pasted.side.groups?.map(named)});
  selectUnits(pasted.units,side);
 };
 const makeSelectionMask=()=>{
  const source=selectedNodes[0];
  if(!source)return;
  const region={...contourRegion(source),maskSource:true as const};
  const targets=new Set(selectedNodes.slice(1).map(node=>node.id));
  if(!targets.size){
   const next=active.nodes.slice(active.nodes.indexOf(source)+1).find(node=>node.groupId===source.groupId&&node.type!=='empty'&&node.visible);
   if(next&&!next.locked)targets.add(next.id);
  }
  changeSide({...active,regions:[...active.regions.filter(item=>item.id!==region.id),region],
   nodes:active.nodes.map(node=>targets.has(node.id)?{...node,clipRegionId:region.id}:node.id===source.id&&targets.size?{...node,visible:false}:node)});
  if(!targets.size)notify('图层轮廓已加入蒙版列表');
 };
 const flipSelection=(axis:'flipX'|'flipY')=>{
  if(selectedNodes.length===1){
   changeSide({...active,nodes:active.nodes.map(node=>node.id===selectedNodes[0].id?{...node,[axis]:!node[axis]}:node)});
   return;
  }
  const corners=selectedNodes.flatMap(node=>{
   const a=node.rotation*Math.PI/180;
   return [[0,0],[node.width,0],[0,node.height],[node.width,node.height]].map(([x,y])=>
    axis==='flipX'?node.x+x*Math.cos(a)-y*Math.sin(a):node.y+x*Math.sin(a)+y*Math.cos(a));
  });
  const sum=Math.min(...corners)+Math.max(...corners);
  changeSide({...active,nodes:active.nodes.map(node=>{
   if(!selectedArtworkIds.includes(node.id))return node;
   const a=node.rotation*Math.PI/180;
   return axis==='flipX'?{...node,x:sum-node.x-node.width*Math.cos(a),y:node.y+node.width*Math.sin(a),rotation:-node.rotation,flipX:!node.flipX}
    :{...node,x:node.x-node.height*Math.sin(a),y:sum-node.y-node.height*Math.cos(a),rotation:-node.rotation,flipY:!node.flipY};
  })});
 };
 const mac=/Mac|iPhone|iPad/.test(navigator.platform), cmd=mac?'⌘':'Ctrl';
 const addCardCommand:EditorCommand={id:'add',label:'添加卡牌',shortcut:'⇧ N',enabled:!regionDraft&&!readingImages&&!leaving&&!memberBusy,run:addBlankOnCanvas};
 const coverCommand=(target?:CanvasFace):EditorCommand=>({
  id:'cover',label:'设为封面',shortcut:'⇧ '+cmd+' K',enabled:!!target,run:()=>{if(target)setProjectCover(target)},
 });
 const canDeleteSelectedLayers=()=>{
  if(!menu||regionDraft||textEdit||sampling||leaving||readingImages||memberBusy)return false;
  if(!canvasSelection)return !!selectedCount&&!active.canvasLocked&&selectedNodes.every(node=>!node.locked);
  const cards=projectCards(project);
  return canvasSelection.layers.length>0&&canvasSelection.layers.every(target=>{
   const face=cards.find(card=>card.id===target.cardId)?.[target.face];
   const removal=face&&removalForLayerUnits(face,target.units);
   return !!(face&&removal&&!layerRemovalLocked(face,removal));
  });
 };
 const commands:EditorCommand[]=[
  {id:'copy',label:'复制',shortcut:cmd+' C',enabled:!!selectedCount,run:()=>copySelection()},
  {id:'paste',label:'粘贴到这里',enabled:true,run:()=>void pasteClipboard(readSystemClipboard())},
  {id:'replace',label:'粘贴替换',shortcut:'⇧ '+cmd+' R',enabled:!!copied&&!!selectedCount&&!active.canvasLocked&&selectedNodes.every(node=>!node.locked),run:()=>void pasteClipboard(readSystemClipboard(),true)},
  {id:'group',label:'编组所选图层',shortcut:cmd+' G',enabled:selectionUnits.length>=2&&!active.canvasLocked,run:formLayerGroup},
  addCardCommand,
  coverCommand(selectedCount?{cardId:project.cardId!,face:side}:undefined),
  {id:'mask',label:'设为蒙版',shortcut:mac?'⌃ ⌘ M':'Ctrl Alt M',enabled:editableArtwork,run:makeSelectionMask},
  {id:'lock',label:'锁定/解锁',shortcut:'⇧ '+cmd+' L',enabled:artworkOnly&&!active.canvasLocked,run:()=>{
   const lock=selectedNodes.some(node=>!node.locked);
   changeSide({...active,nodes:active.nodes.map(node=>selectedArtworkIds.includes(node.id)?{...node,locked:lock}:node)});
  }},
  {id:'flipX',label:'水平翻转',shortcut:'⇧ H',enabled:editableArtwork,run:()=>flipSelection('flipX')},
  {id:'flipY',label:'垂直翻转',shortcut:'⇧ V',enabled:editableArtwork,run:()=>flipSelection('flipY')},
  {id:'delete',label:'删除选中图层',shortcut:mac?'⌫':'Delete',enabled:canDeleteSelectedLayers(),run:requestDelete},
 ];
 const copyableBoards=canCopyCanvasFaces(project,boardSelection);
 const primaryBoard=singleBoard??(copyableBoards?boardSelection.find(board=>board.face==='front'):undefined);
 const boardCommands:EditorCommand[]=[
  {id:'copy',label:'复制',shortcut:cmd+' C',enabled:copyableBoards,run:()=>copyBoards()},
  {id:'paste',label:'粘贴到这里',enabled:true,run:()=>void pasteClipboard(readSystemClipboard())},
  {id:'replace',label:'粘贴替换',shortcut:'⇧ '+cmd+' R',enabled:!!copiedFace&&canReplaceCanvasFaces(project,boardSelection,copiedFace),run:()=>void pasteClipboard(readSystemClipboard(),true)},
  {id:'group',label:'组合卡牌',shortcut:cmd+' G',enabled:canCombineCanvasFaces(project,boardSelection),run:combineBoards},
  {id:'swap-faces',label:'设为正面/反面',shortcut:'⇧ F',enabled:canSwapCanvasFaces(project,boardSelection),run:swapBoards},
  addCardCommand,
  coverCommand(primaryBoard),
  {id:'lock',label:'锁定/解锁',shortcut:'⇧ '+cmd+' L',enabled:!!boardSelection.length,run:lockBoards},
  {id:'ungroup',label:'解除组合',shortcut:'⇧ '+cmd+' G',enabled:!!primaryBoard&&canUnlinkCanvasFace(project,primaryBoard),
   run:()=>{if(primaryBoard)separateBoard(primaryBoard)}},
  {id:'delete',label:'删除',shortcut:'⌫',enabled:!!boardSelection.length&&canDeleteCanvasFaces(project,boardSelection),run:()=>removeBoards(boardSelection)},
 ];
 useEffect(()=>{
  const handler=(e:KeyboardEvent)=>{
   if(modal||stockChange||confirmDelete||leaving||e.defaultPrevented||e.isComposing||document.querySelector('dialog[open]'))return;
   const mod=e.metaKey||e.ctrlKey,key=e.key.toLowerCase();
   const target=e.target instanceof HTMLElement?e.target:null;
   if(mod&&key==='s'){e.preventDefault();void saveNow();return}
   const typing=target?.closest('input,textarea,select,[contenteditable]');
   if(!typing&&!mod&&!e.altKey){
    if(e.code==='Space'){
     if(!e.repeat)usedSpaceForPan.current=false;
     if(!target?.closest('button:focus-visible,a:focus-visible,[role="button"]:focus-visible'))e.preventDefault();
     setSpaceHeld(true);return;
    }
    if(['+','=','-','0'].includes(key)){
     e.preventDefault();
     if(key==='0')navigationRef.current?.fit();
     else navigationRef.current?.zoomBy(key==='-'?1/ZOOM_STEP:ZOOM_STEP);
     return;
    }
   }
   if(mod&&!e.altKey&&key==='z'){
    if(regionDraft||target?.isContentEditable||target?.closest('input[type="search"],[data-undo-draft]'))return;
    e.preventDefault();
    e.shiftKey?redo():undo();
    return;
   }
   if(typing)return;
   if(!regionDraft&&!textEdit&&!sampling){
    let action:EditorCommandId|undefined;
    if(mod&&e.shiftKey&&!e.altKey){
     if(key==='r')action='replace';
     if(key==='l')action='lock';
     if(key==='k')action='cover';
     if(key==='g'&&boardSelection.length)action='ungroup';
    }else if(mod&&!e.shiftKey&&!e.altKey&&key==='g')action='group';
    else if(key==='m'&&(mac?e.metaKey&&e.ctrlKey:e.ctrlKey&&e.altKey))action='mask';
    else if(!mod&&!e.altKey&&e.shiftKey){
     if(key==='n')action='add';
     if(key==='f')action='swap-faces';
     if(key==='h')action='flipX';
     if(key==='v')action='flipY';
    }
    if(action){
     const command=(boardSelection.length?boardCommands:commands).find(item=>item.id===action);
     if(command){
      e.preventDefault();
      if(command.enabled)command.run();
      closeMenu();closeFaceMenu();return;
     }
    }
   }
   if(regionDraft&&key!=='escape')return;
   if(['line','pen'].includes(tool)&&['enter','escape','delete','backspace'].includes(key))return;
   if(mod&&e.shiftKey&&!e.altKey&&key==='g'){
    e.preventDefault();dissolveLayerGroup();
   }
   else if(!mod&&!e.altKey&&e.shiftKey&&key==='a'&&canAddLayout&&!selectedGroup?.autoLayout){
    e.preventDefault();toggleAutoLayout();
   }
   else if(mod&&e.altKey&&e.code==='KeyC'&&selected){e.preventDefault();copyStyle()}
   else if(mod&&e.altKey&&e.code==='KeyV'&&selected){e.preventDefault();pasteStyle()}
   else if(mod&&key==='d'){e.preventDefault();if(inLayerList(target))duplicateSidebarLayers();else duplicateLayer()}
   else if(!mod&&!e.altKey&&key==='enter'&&selected?.type==='text'&&selected.visible&&!selected.locked&&
    (!target?.closest('button')||target.closest('.layer-select'))){
    e.preventDefault();editText(side,selected.id);
   }
   else if(!mod&&!e.altKey&&(key==='delete'||key==='backspace')){
    e.preventDefault();
    if(!textEdit&&!sampling){
     if(boardSelection.length)removeBoards(boardSelection);else requestDelete();
     closeMenu();closeFaceMenu();
    }
   }
   else if(key==='escape'){
    if(regionDraft){cancelRegion();return}
    else if(gradientEditing){setGradientEditing(null)}
    else if(radialEffectId){setRadialEditing(undefined)}
    else selectLayer(null);
    setTool('select');
   }
   else if(!mod&&!e.altKey&&!e.shiftKey&&key==='v')setTool('select');
   else if(!mod&&!e.altKey&&!e.shiftKey&&key==='h')setTool('hand');
   else if(!mod&&!e.altKey&&!e.shiftKey&&(key==='l'||key==='p'))activateCanvasTool(key==='l'?'line':'pen');
   else if(!mod&&!e.altKey&&e.key.startsWith('Arrow')&&canvasSelection){
    e.preventDefault();const step=e.shiftKey?10:1;
    moveMarquee(canvasSelection,{x:(key==='arrowright'?step:key==='arrowleft'?-step:0),y:(key==='arrowdown'?step:key==='arrowup'?-step:0)});
   }
   else if(!mod&&e.key.startsWith('Arrow')&&selected&&!selected.locked){
    e.preventDefault();const delta=e.shiftKey?10:1;
    patchNode({x:selected.x+(e.key==='ArrowRight'?delta:e.key==='ArrowLeft'?-delta:0),y:selected.y+(e.key==='ArrowDown'?delta:e.key==='ArrowUp'?-delta:0)});
   }else if(!mod&&e.key.startsWith('Arrow')&&selectedGroup&&!current.current[side].canvasLocked){
    const step=e.shiftKey?10:1;
    const delta={x:e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,y:e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0};
    if(delta.x||delta.y){
     e.preventDefault();
     const next=moveArtworkGroup(current.current,side,selectedGroup.id,delta);
     if(next)commit({...current.current,[side]:next},'group-position-'+selectedGroup.id);
    }
   }
  };
  window.addEventListener('keydown',handler);
  return()=>window.removeEventListener('keydown',handler);
 });
 useEffect(()=>{
  const release=()=>{usedSpaceForPan.current=false;setSpaceHeld(false)};
  const onKeyUp=(event:KeyboardEvent)=>{
   if(event.code!=='Space')return;
   if(usedSpaceForPan.current)event.preventDefault();
   release();
  };
  const onVisibilityChange=()=>{if(document.hidden)release()};
  window.addEventListener('keyup',onKeyUp,true);
  window.addEventListener('blur',release);
  document.addEventListener('visibilitychange',onVisibilityChange);
  return()=>{
   window.removeEventListener('keyup',onKeyUp,true);
   window.removeEventListener('blur',release);
   document.removeEventListener('visibilitychange',onVisibilityChange);
  };
 },[]);
 useEffect(()=>{if(modal||stockChange||confirmDelete||leaving)setSpaceHeld(false)},[modal,stockChange,confirmDelete,leaving]);
 const addNode=(type:'text'|'rect'|'ellipse'|'polygon')=>{
  if(regionDraft||leaving)return;
  const doc=current.current;
  const face=doc[side];
  if(face.canvasLocked){notify('请先解锁卡面');return}
  const width=Math.min(doc.widthMm*7,330),height=Math.min(doc.heightMm*5,type==='text'?70:180);
  const node:CardNode={
   ...createArtwork(face,type),x:(doc.widthMm*10-width)/2,y:(doc.heightMm*10-height)/2,width,height,
   groupId:editableArtwork&&selectedGroup?.autoLayout?selectedGroup.id:undefined,
   fill:type==='text'?'#27332b':'#d2b87e',text:type==='text'?'新文字':undefined,
   fontSize:36,fontFamily:'Work Sans, PingFang SC, sans-serif',
  };
  changeSide({...face,nodes:[...face.nodes,node]});
  setInspectorTab('design');setLayerQuery('');selectLayer(node.id,'artwork');setTool('select');
  if(type==='text')setTextEdit({face:side,id:node.id});
 };
 const chooseImage=(replacement:string|null=null)=>{
  if(leaving||regionDraft)return;
  if(current.current[side].canvasLocked){notify('请先解锁卡面');return}
  replaceId.current=replacement;
  fileInput.current?.click();
 };
 const editText=(face:SideName,id:string)=>{
  if(regionDraft||leaving||modal||readingImages||current.current[face].canvasLocked)return;
  const node=current.current[face].nodes.find(item=>item.id===id);
  if(node?.type!=='text'||!node.visible||node.locked)return;
  switchSide(face);
  setInspectorTab('design');
  selectLayer(id,'artwork');setTool('select');
  if(face!==side)revealLayer(current.current[face],id);
  setTextEdit({face,id});
 };
 const finishTextEdit=(face:SideName,id:string,draft:TextDraft)=>{
  setTextEdit(edit=>edit?.id===id&&edit.face===face?undefined:edit);
  const card=current.current[face];
  const layer=card.nodes.find(item=>item.id===id);
  if(layer?.type!=='text'||layer.locked||!layer.visible||
    (draft.text===(layer.text??'')&&JSON.stringify(draft.textStyles)===JSON.stringify(layer.textStyles)))return;
  changeCanvasSide({...card,nodes:card.nodes.map(item=>item.id===id?{...item,...draft}:item)},face);
 };
 const cancelTextEdit=useCallback(()=>setTextEdit(undefined),[]);
 const uploadImage=async(file:File,replace:string|null=null,paste?:{face:SideName;point?:MenuPoint})=>{
  const {id:projectId,cardId}=current.current;
  const destination=paste?.face??side;
  const cardStillOpen=(doc:Project)=>doc.id===projectId&&doc.cardId===cardId&&(destination==='front'||!doc.singleSided);
  if(leaving||regionDraft||pendingSvgChoice.current)return;
  if(current.current[destination].canvasLocked){notify('请先解锁卡面');return}
  setImageIssue(null);setReadingImages(count=>count+1);
  const svg=/^(?:image|application)\/svg\+xml(?:;|$)/i.test(file.type)||/\.svg$/i.test(file.name);
  try {
   const draft=current.current;
   const target={width:draft.widthMm*10,height:draft.heightMm*10};
   const sizing=paste?'actual':'fit';
   let rasterReason='';
   const imported=svg&&!replace?await readEditableSvg(file,target,sizing).catch((error:unknown)=>{
    rasterReason=error instanceof Error?error.message:'无法保留可编辑路径。';
    return undefined;
   }):undefined;
   if(imported){
    const doc=current.current;
    if(!cardStillOpen(doc))return;
    const face=doc[destination];
    if(face.canvasLocked){notify('请先解锁卡面');return}
    const point=paste?.point;
    const dx=point?point.x-Math.min(...imported.nodes.map(node=>node.x)):0;
    const dy=point?point.y-Math.min(...imported.nodes.map(node=>node.y)):0;
    const nodes=point?imported.nodes.map(node=>({...node,x:node.x+dx,y:node.y+dy})):imported.nodes;
    commit({...doc,[destination]:{...face,nodes:[...face.nodes,...nodes],groups:[...face.groups??[],...imported.groups]}});
    if(paste||activeFace.current===destination){
     selectUnits([{kind:'group',id:imported.groupId}],destination);setTool('select');setLayerQuery('');
     if(paste)setProcessView('all');
    }
    notify(paste?'已粘贴':'已导入可编辑 SVG');return;
   }
   if(!cardStillOpen(current.current))return;
   const rendered=svg?await rasterizeLocalSvg(file,target,sizing):undefined;
   if(rasterReason){
    if(!cardStillOpen(current.current)||pendingSvgChoice.current)return;
    const allow=await new Promise<boolean>(resolve=>{
     const choice={reason:rasterReason,resolve};
     pendingSvgChoice.current=choice;
     setSvgRasterChoice(choice);
    });
    if(!allow)return;
   }
   const image=await readImage(rendered?.file??file);
   const doc=current.current;
   if(!cardStillOpen(doc))return;
   const face=doc[destination];
   if(face.canvasLocked){notify('请先解锁卡面');return}
   const previous=replace?face.nodes.find(node=>node.id===replace):undefined;
   if(replace&&(!previous||previous.locked||previous.type!=='image')){
    notify('所选图层已变更，请重新选择');return;
   }
   if(previous?.type==='image'){
    const crop=replaceCrop?await cropForImageReplacement(previous):undefined;
    const live=current.current,liveFace=live[destination];
    if(!cardStillOpen(live)||liveFace.canvasLocked||liveFace.nodes.find(n=>n.id===replace)!==previous){notify('所选图层已变更，请重新选择');return}
    commit({...live,[destination]:{...liveFace,nodes:liveFace.nodes.map(n=>n.id===replace?{...n,src:image.src,crop,
     ...(n.imageFill?{imageFill:{...n.imageFill,src:image.src,crop,presetId:undefined}}:{})}:n)}});
    if(activeFace.current!==side){notify('图片已替换到'+(side==='front'?'正面':'背面'));return}
    selectLayer(previous.id,'artwork');setTool('select');
    notify('已替换图片，保留当前布局');
    return;
   }
   const scale=Math.min(doc.widthMm*8.8/image.width,doc.heightMm*8.8/image.height,1);
   const width=rendered?.width??image.width*scale,height=rendered?.height??image.height*scale;
   const node:CardNode={
    ...createArtwork(face,'image'),x:paste?.point?.x??(doc.widthMm*10-width)/2,y:paste?.point?.y??(doc.heightMm*10-height)/2,
    groupId:!rendered&&!paste?.point&&destination===side&&editableArtwork&&selectedGroup?.autoLayout&&findLayerGroup(face,selectedGroup.id)?.autoLayout?selectedGroup.id:undefined,
    width,height,fill:'#fff',src:image.src,
   };
   commit({...doc,[destination]:{...face,nodes:[...face.nodes,node]}});
   if(!paste&&activeFace.current!==destination){notify('图片已加入'+(destination==='front'?'正面':'背面'));return}
   setInspectorTab('design');setLayerQuery('');
   if(paste)selectUnits([{kind:'artwork',id:node.id}],destination);else selectLayer(node.id,'artwork');
   setTool('select');notify(paste?'已粘贴':rendered?'已将 SVG 的外观保留为透明图片图层':'图片已加入卡面');
  } catch(error){
   if(paste){
    if(cardStillOpen(current.current))notify(svg?`无法读取剪贴板中的 SVG。${(error as Error).message}`:'无法读取剪贴板内容');
    return;
   }
   if(cardStillOpen(current.current)){setCollapsedLeft(false);setImageIssue({message:`「${file.name}」${(error as Error).message}`,replacement:replace})}
  }
  finally {setReadingImages(count=>count-1)}
 };
 const pasteClipboard=async(pending:Promise<ClipboardPayload>,replace=false,fromLayerList=false)=>{
  const before=current.current,previousFace=activeFace.current;
  const target=replace?undefined:faceMenu?.target??menu?.target;
  const destination=target?.face??previousFace;
  const world=menuWorldPoint();
  const origin=world&&target&&canvasLayoutSnapshot(before)[canvasFaceKey(target)];
  const point=menu?.point??(world&&origin?{x:world.x-origin.x,y:world.y-origin.y}:undefined);
  const sidebar=Boolean(menu?.sidebar||fromLayerList&&!menu&&!faceMenu);
  closeMenu();closeFaceMenu();
  try{
   const data=await pending;
   const live=current.current;
   if(data.kind==='empty'||live.id!==before.id||live.cardId!==before.cardId||activeFace.current!==previousFace)return;
   if(replace&&live!==before)return;
   if(data.kind==='text'){
    const card=decodeClipboardFace(data.text);
    if(card&&(!replace||boardSelection.length)){
     if(replace)replaceBoards(card);else pasteBoard(card,world);
     return;
    }
    if(copied&&data.text===copied.marker&&(!replace||!boardSelection.length)){
     if(target)activateProjectMember(target.cardId);
     pasteSelection(replace,destination,point,sidebar);return;
    }
   }
   if(!replace&&(data.kind==='svg'||data.kind==='image')){
    if(target)activateProjectMember(target.cardId);
    const file=data.kind==='svg'?new File([data.text],'剪贴板 SVG.svg',{type:'image/svg+xml'}):data.file;
    await uploadImage(file,null,{face:destination,point});return;
   }
   notify('无法读取剪贴板内容');
  }catch{notify('无法读取剪贴板内容')}
 };
 useEffect(()=>{
  const available=(event:ClipboardEvent)=>!modal&&!regionDraft&&!textEdit&&!leaving&&!stockChange&&!confirmDelete&&!sampling&&!document.querySelector('dialog[open]')&&!acceptsNativePaste(event.target);
  const onCopy=(event:ClipboardEvent)=>{
   if(!available(event)||!event.clipboardData)return;
   if(copyableBoards){event.preventDefault();copyBoards(event.clipboardData);closeFaceMenu();return}
   if(!selectedCount)return;
   event.preventDefault();copySelection(event.clipboardData);closeMenu();
  };
  const onPaste=(event:ClipboardEvent)=>{
   if(!available(event))return;
   event.preventDefault();
   void pasteClipboard(readPasteEvent(event.clipboardData,event.isTrusted),false,inLayerList(event.target));
  };
  window.addEventListener('copy',onCopy);window.addEventListener('paste',onPaste);
  return()=>{window.removeEventListener('copy',onCopy);window.removeEventListener('paste',onPaste)};
 });
 const applyCrop=(crop:ImageCrop)=>{
  if(!selected||selected.locked||!cropFill)return;
  if(selected.type==='image'&&!selected.imageFill)patchNode({crop});
  else patchNode({imageFill:{...cropFill,fit:'cover',crop}});
  setModal(null);
 };
 const uploadWhitePNG=async(file:File,target:{id:string;face:SideName})=>{
  setReadingImages(count=>count+1);
  try{
   const image=await readImage(file);
   if(!image.src.startsWith('data:image/png;'))throw Error('请选择 PNG 白墨蒙版。');
   const doc=current.current,face=doc[target.face];
   const entry=face.effects.find(layer=>layer.id===target.id);
   if(!entry||processKind(entry)!=='white')return;
   const previous=entry.maskContent?.find(node=>node.type==='image');
   const input=imageMaskNode(doc,face,entry,image,file.name);
   const next=previous?{...previous,src:input.src,name:input.name,crop:undefined,maskInk:'alpha' as const}:input;
   const maskContent=previous?entry.maskContent!.map(node=>node.id===previous.id?next:node):[...(entry.maskContent||[]),next];
   commit({...doc,[target.face]:{...face,effects:face.effects.map(layer=>layer.id===entry.id?{...layer,maskContent}:layer)}});
   notify('已将 PNG 的不透明区域用作白墨');
  }catch(error){notify((error as Error).message)}
  finally{setReadingImages(count=>count-1)}
 };
 const chooseProcess=(entry:Effect)=>selectLayer(entry.id,processKind(entry));
 const contourRegion=(node:CardNode):Region=>active.regions.find(region=>
  region.kind==='node'&&region.nodeId===node.id&&region.binding==='follow'&&!region.strokes.length&&!region.inverted
 )??{id:uid(),name:node.name+'轮廓',kind:'node',nodeId:node.id,binding:'follow',inverted:false,strokes:[]};
 const createProcessFromArtwork=(node:CardNode,kind:ProcessKind)=>{
  const region=contourRegion(node);
  const entry=makeProcess(kind,region,(node.name+' · '+PROCESS_LABELS[kind]).slice(0,100));
  changeSide({...active,regions:active.regions.includes(region)?active.regions:[...active.regions,region],effects:[...active.effects,entry]});
  setLayerQuery('');chooseProcess(entry);
 };
 const startRegion=(region?:Region,kind:MaskShape='paint')=>{
  if(!selected&&!effect)return;
  if(regionDraft||readingImages){notify(regionDraft?'请先完成或取消当前蒙版':'正在读取图片，请稍候');return}
  const label={paint:'手绘',rect:'矩形',ellipse:'椭圆',polygon:'多边形'}[kind];
  const draft:Region=region||{id:uid(),name:label+'蒙版 '+(active.regions.filter(item=>item.kind===kind).length+1),kind,binding:'fixed',inverted:false,strokes:[]};
  setRegionDraft(structuredClone(draft));setMaskSelection(null);setCollapsedLeft(false);
  setTool(['rect','ellipse','polygon'].includes(draft.kind)?'geometry':'brush');setLayerPlate(undefined);
 };
 const cancelRegion=()=>{setRegionDraft(null);setMaskSelection(null);setShowLayerMask(false);setTool('select')};
 const chooseMaskTool=(next:EditorTool)=>{
  if(next===tool)return;
  setMaskSelection(null);setTool(next);
 };
 const applyMaskSelection=(erase:boolean)=>{
  if(!maskSelection)return;
  setRegionDraft(draft=>draft&&({...draft,strokes:[...draft.strokes,
   {kind:'selection',pathPoints:maskSelection,erase:erase!==draft.inverted},
  ]}));
  setMaskSelection(null);
 };
 const undoRegion=()=>setRegionDraft(draft=>{
  if(!draft)return draft;
  if(draft.strokes.length)return {...draft,strokes:draft.strokes.slice(0,-1)};
  return {...draft,points:draft.points?.slice(0,-2)};
 });
 const deleteMask=(keep:boolean)=>{
  if(!removeMask || keep&&!removeMask.fixed)return;
  changeSide(removeRegion(active,removeMask.id,keep?removeMask.fixed:undefined));
  setRemoveMask(undefined);cancelRegion();selectLayer(null);
 };
 const bindRegion=(region?:Region)=>{
  if(effect&&!region)return;
  const known=active.regions.some(item=>item.id===region?.id);
  const regions=!region?active.regions:known
   ?active.regions.map(item=>item.id===region.id?region:item)
   :[...active.regions,region];
  changeSide({
   ...active,regions,
   nodes:selected?active.nodes.map(item=>item.id===selected.id?{...item,clipRegionId:region?.id}:item):active.nodes,
   effects:effect&&region?active.effects.map(item=>item.id===effect.id
    ?{...item,regionId:region.id,maskContent:item.maskContent?.length===0?undefined:item.maskContent}:item):active.effects,
  });
  setShowLayerMask(Boolean(region));setLayerPlate(undefined);
 };
 const selectMask=(value:string)=>{
  if(value==='union:'){setModal('maskUnion');return}
  if(value.startsWith('draw:')){startRegion(undefined,value.slice(5) as MaskShape);return}
  if(value.startsWith('node:')){
   const source=active.nodes.find(node=>node.id===value.slice(5));
   if(source)bindRegion(contourRegion(source));
   return;
  }
  bindRegion(active.regions.find(region=>region.id===value));
 };
 const maskActions=()=>targetRegion&&<div className="inline-actions mask-actions">
  <Button active={showLayerMask} onClick={()=>{setShowLayerMask(value=>!value);setLayerPlate(undefined)}}>
   <FigmaIcon name="inspector-mask-eye"/>{showLayerMask?'隐藏蒙版范围':'显示蒙版范围'}
  </Button>
  <Button disabled={selected?.locked} onClick={()=>sharedUsers.length?setMaskScope(true):startRegion(targetRegion)}><FigmaIcon name="inspector-mask-edit"/>编辑蒙版</Button>
 </div>;
 const applyRegion=()=>{
  if(!regionDraft)return;
  if((regionDraft.kind==='polygon'&&(regionDraft.points?.length||0)<6)||
     (['rect','ellipse'].includes(regionDraft.kind)&&!regionDraft.bounds)||
     (regionDraft.kind==='paint'&&!regionDraft.strokes.length)){
   notify('先在卡面上绘制一个蒙版');return;
  }
  bindRegion(regionDraft);setRegionDraft(null);setMaskSelection(null);setTool('select');
 };
 const regionHint=maskSelection?'选区已就绪':tool==='mask-marquee'?'拖动框选蒙版区域':tool==='mask-pen'?'点击添加锚点，拖动调整曲线，点击起点或按 Enter 闭合':
  tool==='geometry'?(regionDraft?.kind==='polygon'?'点击卡面添加顶点，完成后自动闭合':'在卡面拖动绘制形状'):'正在编辑作用区域';
 const displayedProject=regionDraft?{...project,[side]:{...active,regions:active.regions.some(r=>r.id===regionDraft.id)?active.regions.map(r=>r.id===regionDraft.id?regionDraft:r):[...active.regions,regionDraft]}}:project;
 const closeModal=useCallback(()=>setModal(null),[]);
 const openProof=(settings:Partial<ProofSettings>={})=>{
  setProof({side,artwork:true,showGuides:true,showOverlap:false,selected:[],applyFactory:false,technical:'standard',dpi:300,vector:false,...settings});
  setProofReturn(false);setProofOpen(true);
 };
 const locatePreflight=(target:PreflightTarget)=>{
  setProcessView('all');setLayerQuery('');
  switchSide(target.side);
  const face=project[target.side];
  if(target.groupId)selectUnits([{kind:'group',id:target.groupId}],target.side);
  else if(face.effects.some(item=>item.id===target.effectId))selectUnits([{kind:'process',id:target.effectId!}],target.side);
  else if(face.nodes.some(item=>item.id===target.nodeId))selectUnits([{kind:'artwork',id:target.nodeId!}],target.side);
  else selectLayer(null);
  if(target.reflection)selectBoards([{cardId:project.cardId!,face:target.side}]);
  else if(target.material)openCardProperties();
  else if(target.nodeId)setInspectorTab('design');
  setCollapsedRight(false);setModal(null);
 };
 const openCardProperties=()=>{
  selectCardCombination(current.current.cardId!);
 };
 const openPlan=()=>setModal('production');
 const openExport=(mode:'image'|'print'='image',view?:StillView)=>{
  setExportEntry(mode);setStillView(view);setModal('export');
 };
 const closeSize=()=>{setProposedSize(undefined);setModal(returnToPlan?'production':null);setReturnToPlan(false)};
 const switchSide=(face:SideName)=>{
  if(face===activeFace.current||(face==='back'&&current.current.singleSided))return;
  coalesce.current=null;
  activeFace.current=face;setSide(face);selectLayer(null);setImageIssue(null);
  if(tool!=='line'&&tool!=='pen')setTool('select');
  setLayerQuery('');setLayerPlate(undefined);setGradientEditing(null);
  setDragged(null);setDropAt(null);
 };
 const canvasFaceLocked=leaving||Boolean(regionDraft)||readingImages>0;
 const selectCanvasFace=(face:SideName,nodeId?:string,direct=false)=>{
  if(canvasFaceLocked)return;
  switchSide(face);
  const node=nodeId?current.current[face].nodes.find(item=>item.id===nodeId):undefined;
  if(node&&node.type!=='empty')pickUnit(canvasArtworkUnit(face,node,direct),false,face);
  else selectBoards([{cardId:current.current.cardId!,face}]);
 };
 const activateMemberFace=(id:string,face:SideName,nodeId?:string,direct=false)=>{
  if(!canChangeBoards())return;
  activateProjectMember(id);
  selectCanvasFace(face,nodeId,direct);
 };
 const showFaceMenu=(id:string,face:SideName,screen:MenuPoint,canvas=true)=>{
  if(!canChangeBoards())return;
  const target={cardId:id,face};
  if(!boardSelection.some(board=>sameCanvasFace(board,target)))selectBoards([target]);
  setMenu(undefined);setFaceMenu({screen,canvas,target});
 };
 const showCardMenu=(id:string,screen:MenuPoint)=>{
  if(!canChangeBoards())return;
  selectCardCombination(id);
  setMenu(undefined);setFaceMenu({screen});
 };

 const createVector=(face:SideName,geometry:CreatedVector)=>{
  if(canvasFaceLocked||current.current[face].canvasLocked)return;
  const card=current.current[face];
  const closed=geometry.type==='path'&&geometry.pathClosed;
  const node:CardNode={
   ...createArtwork(card,geometry.type),...geometry,
   groupId:face===side&&editableArtwork&&selectedGroup?.autoLayout?selectedGroup.id:undefined,
   fill:closed?'#d2b87e':'transparent',
   stroke:'#237ac2',strokeWidth:2,strokeAlign:'center',
  };
  changeCanvasSide({...card,nodes:[...card.nodes,node]},face);
  switchSide(face);
  setInspectorTab('design');setLayerQuery('');selectLayer(node.id,'artwork');setTool('select');
 };
 const selectUnits=(units:LayerUnit[],face:SideName)=>{
  if(canvasFaceLocked)return;
  if(current.current[face].canvasLocked){selectBoards([{cardId:current.current.cardId!,face}]);return}
  switchSide(face);
  const unit=units.length===1?units[0]:undefined;
  if(unit?.kind==='artwork'){
   selectLayer(unit.id,'artwork');
   if(face!==side)revealLayer(current.current[face],unit.id);
   return;
  }
  if(unit?.kind==='process'){
   const entry=current.current[face].effects.find(item=>item.id===unit.id);
   if(entry){
    selectLayer(entry.id,processKind(entry));
    if(face!==side)revealLayer(current.current[face],entry.id);
    return;
   }
  }
  selectLayer(null);
  if(unit?.kind==='group')revealLayer(current.current[face],unit.id);
  if(units.length){setLayerSelection(units);setCollapsedRight(false)}
 };
 const selectMarquee=(hits:CanvasMarqueeSelection,additive:boolean)=>{
  const doc=current.current;
  const previous=additive ? canvasSelection??{boards:boardSelection,layers:selectionUnits.length?
   [{cardId:project.cardId!,face:side,units:selectionUnits}]:[]} : {boards:[],layers:[]};
  if(additive&&!hits.boards.length&&!hits.layers.length)return;
  const members=new Map(projectCards(doc).map(card=>[card.id,card]));
  const validFace=(target:CanvasFace)=>{
   const member=members.get(target.cardId);
   return !!member&&(target.face==='front'||!member.singleSided);
  };
  const boards=[...new Map([...previous.boards,...hits.boards].filter(validFace).map(board=>[canvasFaceKey(board),board])).values()];
  const layers=new Map<string,CanvasMarqueeSelection['layers'][number]>();
  for(const target of [...previous.layers,...hits.layers]){
   const key=canvasFaceKey(target);
   if(!validFace(target))continue;
   const units=[...(layers.get(key)?.units??[]),...target.units];
   layers.set(key,{...target,units:[...new Map(units.map(unit=>[unit.id,unit])).values()]});
  }
  if(!layers.size){selectBoards(boards);return}
  setLayerQuery('');setProcessView('all');
  for(const target of layers.values()){
   const face=members.get(target.cardId)![target.face];
   const groups=new Set(target.units.filter(unit=>unit.kind==='group').map(unit=>unit.id));
   target.units=target.units.filter(unit=>{
    const parent=unit.kind==='group'?findLayerGroup(face,unit.id)?.parentId:unit.kind==='artwork'?
     face.nodes.find(node=>node.id===unit.id)?.groupId:face.effects.find(effect=>effect.id===unit.id)?.groupId;
    return !layerGroupAncestors(face,parent).some(group=>groups.has(group.id));
   });
   for(const unit of target.units)revealLayer(face,unit.id,target);
  }
  if(!boards.length&&layers.size===1){
   const target=layers.values().next().value!;
   activateProjectMember(target.cardId);selectUnits(target.units,target.face);return;
  }
  selectLayer(null);setCollapsedRight(false);setCanvasSelection({boards,layers:[...layers.values()]});
 };
 const pickUnit=(unit:LayerUnit,additive:boolean,face=side)=>{
  const previous=additive&&face===activeFace.current?selectionUnits:[];
  const existing=previous.some(item=>item.kind===unit.kind&&item.id===unit.id);
  selectUnits(existing?previous.filter(item=>item.kind!==unit.kind||item.id!==unit.id):[...previous,unit],face);
 };
 const canvasArtworkUnit=(face:SideName,node:CardNode,direct=false):LayerUnit=>{
  if(direct)return {kind:'artwork',id:node.id};
  const ancestors=layerGroupAncestors(current.current[face],node.groupId);
  const group=ancestors.find(item=>face===side&&item.id===selectedGroup?.id)??ancestors.at(-1);
  return group&&(face!==side||node.id!==selectedId)?{kind:'group',id:group.id}:{kind:'artwork',id:node.id};
 };
 const drillCanvasArtwork=(face:SideName,id:string)=>{
  if(canvasFaceLocked||face!==side||!selectedGroup)return false;
  const card=current.current[face];
  const node=card.nodes.find(item=>item.id===id);
  if(card.canvasLocked||!node?.visible||node.locked)return false;
  const ancestors=layerGroupAncestors(card,node.groupId);
  const depth=ancestors.findIndex(item=>item.id===selectedGroup.id);
  if(depth<0)return false;
  const child=ancestors[depth-1];
  selectUnits([child?{kind:'group',id:child.id}:{kind:'artwork',id}],face);
  return true;
 };
 const finishTransfer=(from:SideName,to:SideName,members:Pick<Removal,'artworkIds'|'effectIds'>,next:Project,unit:LayerUnit)=>{
  const snapshot=current.current;
  const apply=()=>{
   setConfirmMove(undefined);
   if(current.current!==snapshot){notify('卡牌已更新，请重新拖动');return}
   commit(next);selectUnits([unit],to);
  };
  const affected=sourceMaskImpact(snapshot[from],members).users;
  if(affected.length)setConfirmMove({side:from,names:affected.map(item=>item.name),apply});else apply();
 };
 const moveArtwork=(from:SideName,to:SideName,id:string,position:{x:number;y:number},groupId?:string)=>{
  if(canvasFaceLocked||current.current[from].canvasLocked||current.current[to].canvasLocked)return false;
  const result=transferArtwork(current.current,from,to,id,position,groupId);
  if(!result)return false;
  const members=groupId?layerGroupMembers(current.current[from],groupId):{artworkIds:[id],effectIds:[]};
  finishTransfer(from,to,members,result.project,result.groupId?{kind:'group',id:result.groupId}:{kind:'artwork',id:result.layerId});
  return true;
 };
 const endLayerDrag=()=>{
  sidebarDrag.current=null;
  setSidebarDropFace(undefined);
  setDragged(null);setDropAt(null);
 };
 const beginLayerDrag=(event:DragEvent,id:string,kind:LayerUnit['kind'],locked=false)=>{
  if(canvasFaceLocked||active.canvasLocked||locked){event.preventDefault();return}
  sidebarDrag.current={face:side,id,kind,locked};
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData(LAYER_DRAG_TYPE,id);
  setDragged(id);
 };
 const layerDropTarget=(event:DragEvent<HTMLElement>,origin:SideName)=>{
  const face:SideName=origin==='front'?'back':'front';
  if(current.current[face].canvasLocked)return;
  const bounds=event.currentTarget.querySelector(`[data-card-face="${face}"]`)?.getBoundingClientRect();
  if(!bounds||event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)return;
  return {face,bounds};
 };
 const dragOverWorkspace=(event:DragEvent<HTMLElement>)=>{
  const layer=sidebarDrag.current;
  if(layer){
   const target=!layer.locked&&!canvasFaceLocked?layerDropTarget(event,layer.face):undefined;
   setSidebarDropFace(target?.face);
   if(target){event.preventDefault();event.dataTransfer.dropEffect='move'}
  }else if(event.dataTransfer.types.includes('Files'))event.preventDefault();
 };
 const dropOnWorkspace=(event:DragEvent<HTMLElement>)=>{
  const layer=sidebarDrag.current;
  if(layer){
   event.preventDefault();
   endLayerDrag();
   if(layer.locked||canvasFaceLocked)return;
   const target=layerDropTarget(event,layer.face);
   if(!target)return;
   const doc=current.current;
   if(layer.kind==='group'){
    const source=doc[layer.face];
    const ids=new Set(layerGroupMembers(source,layer.id).artworkIds);
    const nodes=source.nodes.filter(item=>ids.has(item.id));
    const center=nodes.length?{
     x:(Math.min(...nodes.map(node=>node.x))+Math.max(...nodes.map(node=>node.x+node.width)))/2,
     y:(Math.min(...nodes.map(node=>node.y))+Math.max(...nodes.map(node=>node.y+node.height)))/2,
    }:undefined;
    const delta=center&&{
     x:(event.clientX-target.bounds.left)/target.bounds.width*doc.widthMm*10-center.x,
     y:(event.clientY-target.bounds.top)/target.bounds.height*doc.heightMm*10-center.y,
    };
    const result=transferGroup(doc,layer.face,target.face,layer.id,delta);
    if(result?.groupId)finishTransfer(layer.face,target.face,layerGroupMembers(source,layer.id),result.project,{kind:'group',id:result.groupId});
   }else if(layer.kind==='artwork'){
    const node=doc[layer.face].nodes.find(item=>item.id===layer.id);
    if(node)moveArtwork(layer.face,target.face,layer.id,{
     x:(event.clientX-target.bounds.left)/target.bounds.width*doc.widthMm*10-node.width/2,
     y:(event.clientY-target.bounds.top)/target.bounds.height*doc.heightMm*10-node.height/2,
    });
   }else{
    const result=transferProcess(doc,layer.face,target.face,layer.id);
    if(!result)return;
    commit(result.project);
    switchSide(target.face);
    selectLayer(result.layerId,processKind(result.project[target.face].effects.find(item=>item.id===result.layerId)!));
   }
  }else{
   const file=event.dataTransfer.files[0];
   if(file){event.preventDefault();void uploadImage(file)}
  }
 };
 const locateProductionLayer=(step:ProductionStep)=>{
  if(step.face==='both')return;
  switchSide(step.face);
  const linked=project[step.face].effects.find(item=>item.id===step.layerId);
  if(linked){selectLayer(linked.id,processKind(linked));setLayerQuery('')}
  closeModal();
 };
 const rowDrag=(unit:LayerUnit,locked=false)=>{
  const placement=(event:DragEvent<HTMLElement>)=>{
   const row=event.currentTarget.getBoundingClientRect();
   const position=(event.clientY-row.top)/row.height;
   return unit.kind==='group'&&position>.24&&position<.76?'inside':position>.5?'after':'before';
  };
  const matchingDrag=(event:DragEvent<HTMLElement>)=>{
   const source=sidebarDrag.current;
   if(!source||source.face!==side||source.locked||source.id===unit.id||query||processView!=='all')return;
   const position=placement(event);
   if(position==='inside'&&locked)return;
   if(source.kind==='group'){
    const parent=unit.kind==='group'?unit.id:active.nodes.find(n=>n.id===unit.id)?.groupId??active.effects.find(e=>e.id===unit.id)?.groupId;
    if(layerGroupAncestors(active,parent).some(g=>g.id===source.id))return;
   }
   if(position!=='inside' && source.kind!=='group' && unit.kind!=='group' && source.kind!==unit.kind)return;
   return source;
  };
  return {
   draggable:!locked,
   onDragStart:(event:DragEvent<HTMLElement>)=>beginLayerDrag(event,unit.id,unit.kind,locked),
   onDragEnd:endLayerDrag,
   onDragOver:(event:DragEvent<HTMLElement>)=>{
    if(!matchingDrag(event)){
     if(dropAt?.id===unit.id)setDropAt(null);
     return;
    }
    event.preventDefault();event.dataTransfer.dropEffect='move';
    const next=placement(event);
    if(dropAt?.id!==unit.id||dropAt.placement!==next)setDropAt({id:unit.id,placement:next});
   },
   onDragLeave:(event:DragEvent<HTMLElement>)=>{
    if(dropAt?.id===unit.id&&(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget)))setDropAt(null);
   },
   onDrop:(event:DragEvent<HTMLElement>)=>{
    const source=matchingDrag(event);
    if(!source)return;
    event.preventDefault();
    const card=current.current[side];
    const next=reorderLayerUnits(card,source,unit,placement(event));
    if(next!==card){
     changeSide(next);
     if(placement(event)==='inside')setClosedGroups(previous=>{const open=new Set(previous);open.delete(unit.id);return open});
    }
    endLayerDrag();
   },
  };
 };
 const layerIndent=(depth:number)=>({'--layer-indent':`${Math.min(depth,9)*12}px`} as CSSProperties);
 const editTreeFace=(target:CanvasFace,update:(face:CardSide)=>CardSide)=>{
  const doc=current.current;
  if(canvasFaceLockedIn(doc,target))return;
  if(doc.cardId===target.cardId){
   changeCanvasSide(update(doc[target.face]),target.face);return;
  }
  const cards=projectCards(doc).map(card=>card.id===target.cardId?
   {...card,[target.face]:applyAutoLayout(update(card[target.face]))}:card);
  commit(projectWithMembers(doc,cards,doc.cardId!));
 };
 const layerSelectionOn=(target:CanvasFace)=>canvasSelection?.layers.find(entry=>sameCanvasFace(entry,target))?.units??
  (target.cardId===project.cardId&&side===target.face?selectionUnits:[]);
 const layerRow=(item:LayerTreeItem,face:CardSide,target:CanvasFace,depth:number):ReactNode=>{
  const editing=project.cardId===target.cardId&&side===target.face;
  const units=layerSelectionOn(target);
  const chosen=units.some(unit=>unit.kind===item.kind&&unit.id===item.id);
  const selectedClass=chosen?' selected':'';
  const dragClass=editing&&dragged===item.id?' dragging':'';
  const dropClass=editing&&dropAt?.id===item.id?` drop-target drop-${dropAt.placement}`:'';
  const className=`layer-row layer-tree-row${selectedClass}${dragClass}${dropClass}`;
  const style=layerIndent(depth);
  const select=(event:React.MouseEvent<HTMLButtonElement>)=>{
   if(!canChangeBoards())return;
   event.currentTarget.focus({preventScroll:true});
   activateProjectMember(target.cardId);
   pickUnit(item,editing&&(event.shiftKey||event.metaKey||event.ctrlKey),target.face);
  };
  const rowMenu=(event:React.MouseEvent)=>{
   event.preventDefault();event.stopPropagation();if(!canChangeBoards())return;
   if(face.canvasLocked){showFaceMenu(target.cardId,target.face,{x:event.clientX,y:event.clientY},false);return}
   const parent=item.kind==='group'?item.group.parentId:item.kind==='artwork'?item.node.groupId:item.effect.groupId;
   if(!layerInSelection(face,units,item,parent)){
    activateProjectMember(target.cardId);
    selectUnits([{kind:item.kind,id:item.id}],target.face);
   }
   setFaceMenu(undefined);setMenu({screen:{x:event.clientX,y:event.clientY},target,sidebar:true});
  };
  if(item.kind==='group'){
   const {group,children}=item;
   const collapseKey=processView==='all'?group.id:processView+':'+group.id;
   const expanded=Boolean(query)||!closedGroups.has(collapseKey);
   const contents=layerGroupMembers(face,group.id);
   const ids=new Set(contents.artworkIds);
   const locked=face.nodes.some(node=>ids.has(node.id)&&node.locked);
   const childrenId=`layer-group-${canvasFaceKey(target)}-${group.id}`;
   return <div className="layer-tree-branch" key={group.id}>
    <div data-layer-group-id={group.id} className={className+' layer-group-row'} style={style} onContextMenu={rowMenu} {...(editing?rowDrag(item,locked):{})}>
     <button type="button" className="layer-disclosure" aria-expanded={expanded} aria-controls={expanded?childrenId:undefined}
      aria-label={(expanded?'收起':'展开')+group.name} title={expanded?'收起组合':'展开组合'} disabled={Boolean(query)}
      onClick={()=>setClosedGroups(previous=>{
       const next=new Set(previous);
       if(next.has(collapseKey))next.delete(collapseKey);else next.add(collapseKey);
       return next;
      })}>
      <FigmaIcon name="layer-chevron"/>
     </button>
     <button type="button" className="layer-select" aria-pressed={chosen} title={group.name} onClick={select}>
      <span className="layer-icon"><FigmaIcon name="layer-group"/></span>
      <span className="layer-name">{group.name}</span>
     </button>
    </div>
    {expanded&&<div id={childrenId} role="group" aria-label={group.name+'的图层'} className="layer-tree-children">
     {children.map(child=>layerRow(child,face,target,depth+1))}
    </div>}
   </div>;
  }
  const node=item.kind==='artwork'?item.node:undefined;
  const entry=item.kind==='process'?item.effect:undefined;
  const layer=node??entry!;
  const kind=entry?' process-layer':'';
  const muted=layer.visible?'':' muted-row';
  return <div key={item.id} data-layer-id={item.id} className={className+kind+muted} style={style} onContextMenu={rowMenu} {...(editing?rowDrag(item,node?.locked):{})}>
   <span className="layer-disclosure-slot" aria-hidden="true"/>
   <button type="button" className="layer-select" aria-pressed={chosen} title={layer.name} onClick={select}>
    <span className="layer-icon">{node?.type==='ellipse'?<Circle size={12}/>:<FigmaIcon name={node?ARTWORK_LAYER_ICONS[node.type]:'layer-default'}/>}</span>
    <span className="layer-name">{layer.name}</span>
   </button>
   {node&&<button type="button" title={node.locked?'解锁图层':'锁定图层'} aria-label={node.name+(node.locked?'解锁':'锁定')}
    className="row-action" disabled={face.canvasLocked}
    onClick={()=>editTreeFace(target,face=>({...face,nodes:face.nodes.map(candidate=>candidate.id===node.id?{...candidate,locked:!candidate.locked}:candidate)}))}>
    {node.locked?<Lock size={12}/>:<FigmaIcon name="layer-unlock"/>}
   </button>}
   <button type="button" title={layer.visible?'隐藏图层':'显示图层'} aria-label={layer.name+(layer.visible?'隐藏':'显示')}
    className="row-action" disabled={face.canvasLocked}
    onClick={()=>editTreeFace(target,face=>node?{...face,nodes:face.nodes.map(candidate=>candidate.id===node.id?{...candidate,visible:!candidate.visible}:candidate)}:
     {...face,effects:face.effects.map(candidate=>candidate.id===item.id?{...candidate,visible:!candidate.visible}:candidate)})}>
    {layer.visible?<FigmaIcon name="layer-eye"/>:<EyeOff size={12}/>}
   </button>
  </div>;
 };
 const discloseBoard=(key:string,name:string,expanded:boolean)=>{
  return <button type="button" className="layer-disclosure" aria-expanded={expanded}
   aria-controls={expanded?'layer-contents-'+key:undefined} aria-label={(expanded?'收起':'展开')+name}
   disabled={Boolean(query)} onClick={()=>setBoardDisclosure(previous=>({...previous,[key]:!expanded}))}>
   <FigmaIcon name="layer-chevron"/>
  </button>;
 };
 const renderCardBranch=({card,faces}:typeof cardTrees[number])=>{
  const faceRows=faces.map(({slot,label,tree})=>{
   const target={cardId:card.id,face:slot};
   const key=canvasFaceKey(target);
   const depth=card.singleSided?0:1;
   const name=card.singleSided?card.name+' · '+label:label;
   const chosen=!cardSelection&&(canvasSelection?.boards??boardSelection).some(board=>canvasFaceKey(board)===key);
   const expanded=tree.length>0&&(Boolean(query)||(boardDisclosure[key]??(project.cardId===card.id&&side===slot)));
   return <div className="card-face-branch" key={key}>
    <div data-card-face-row={slot} data-member-id={card.id} style={layerIndent(depth)}
     className={`layer-row layer-tree-row card-face-row${chosen?' selected':''}`}
     onContextMenu={event=>{event.preventDefault();showFaceMenu(card.id,slot,{x:event.clientX,y:event.clientY},false)}}>
     {tree.length?discloseBoard(key,name,expanded):<span className="layer-disclosure-slot" aria-hidden="true"/>}
     <button type="button" className="layer-select" aria-pressed={chosen} title={name} onClick={event=>{
      if(!canChangeBoards())return;
      const boards=event.shiftKey?(chosen?boardSelection.filter(board=>canvasFaceKey(board)!==key):
       [...boardSelection.filter(board=>canvasFaceKey(board)!==key),target]):[target];
      selectBoards(boards);setCardSelection(undefined);
     }}>
      <span className="layer-icon">{card[slot].canvasLocked?<Lock size={12}/>:<FigmaIcon name="layer-rectangle"/>}</span>
      <span className="layer-name">{name}</span>
     </button>
    </div>
    {expanded&&<div className="layer-tree-children" id={'layer-contents-'+key} role="group" aria-label={name+'的图层'}>
     {tree.map(item=>layerRow(item,card[slot],target,depth+1))}
    </div>}
   </div>;
  });
  if(card.singleSided)return faceRows;
  const key='card:'+card.id;
  const expanded=Boolean(query)||(boardDisclosure[key]??true);
  const chosen=cardSelection===card.id;
  return <div className="layer-tree-branch" key={card.id}>
   <div data-card-member-row={card.id} className={`layer-row layer-tree-row card-member-row${chosen?' selected':''}`}
    onContextMenu={event=>{event.preventDefault();showCardMenu(card.id,{x:event.clientX,y:event.clientY})}}>
    {discloseBoard(key,card.name,expanded)}
    <button type="button" className="layer-select" aria-pressed={chosen} title={card.name} onClick={()=>{
     if(canChangeBoards())selectCardCombination(card.id);
    }}>
     <span className="layer-icon"><FigmaIcon name="card-combination"/></span>
     <span className="layer-name">{card.name}</span>
    </button>
   </div>
   {expanded&&<div className="layer-tree-children" id={'layer-contents-'+key} role="group" aria-label={card.name+'的卡面'}>
    {faceRows}
   </div>}
  </div>;
 };
 const viewToggle=<button type="button" data-canvas-view-toggle className={`button icon-button${finishedView?' active':''}`}
  aria-label="成品视图" aria-pressed={finishedView} title={finishedView?'返回编辑视图':'成品视图'}
  onPointerDown={event=>{if(textEdit&&event.button===0)event.preventDefault()}}
  onClick={()=>{closeMenu();closeFaceMenu();setFinishedView(previous=>!previous)}}><FigmaIcon name="fill-crop"/></button>;
 return <div className={`studio ${collapsedLeft?'left-collapsed':''} ${collapsedRight?'right-collapsed':''}`}>
  <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" onChange={e=>{const f=e.target.files?.[0];const replacement=replaceId.current;replaceId.current=null;if(f)void uploadImage(f,replacement);e.target.value=''}}/>
  <input ref={whiteInput} hidden type="file" accept="image/png" onChange={event=>{
   const file=event.currentTarget.files?.[0],target=whiteUploadTarget.current;
   event.currentTarget.value='';whiteUploadTarget.current=null;
   if(file&&target)void uploadWhitePNG(file,target);
  }}/>
  <aside className="left-panel" aria-label="图层和素材" inert={leaving}>
   <header className="drawer-project-bar">
    <button className="editor-project-logo" title="返回项目库" aria-label="返回项目库" onClick={()=>void leave()} disabled={leaving||!!regionDraft||readingImages>0}>
     <FigmaIcon name="project-mark"/>
    </button>
    <button className="project-name" onClick={()=>setModal('rename')} title={project.name} aria-label="重命名项目" disabled={!!regionDraft||leaving}><span>{project.name}</span></button>
    <button type="button" className="drawer-project-cards" title="项目中的卡牌" aria-label="项目中的卡牌"
     onClick={openMembers} disabled={leaving||!!regionDraft||readingImages>0}>
     <FigmaIcon name="tool-chevron" className="figma-rotate-90"/>
    </button>
    <IconButton icon={<FigmaIcon name="panel-left-close"/>} title="收起左侧面板" onClick={()=>setCollapsedLeft(true)}/>
    <span className="sr-only" role="status">{saveState}</span>
   </header>
   <div className="canvas-modes" role="group" aria-label="工艺视图">
    {PROCESS_VIEWS.map(({id,label})=>
     <button type="button" key={id} className="button" aria-pressed={processView===id} disabled={!!regionDraft}
      onClick={()=>changeProcessView(id)}>{label}</button>
    )}
   </div>
   <div className="panel-toolbar layer-panel-heading">
    <span className="layer-panel-title">图层</span>
    <div className="panel-toolbar-actions">
     {selectionUnits.length>1&&<IconButton icon={<FigmaIcon name="layer-group"/>} title="组合图层" disabled={!!regionDraft} onClick={formLayerGroup}/>}
     <IconButton icon={<FigmaIcon name="layers-search"/>} title="搜索图层" active={layerSearchOpen} disabled={!!regionDraft}
      onClick={()=>{setLayerSearchOpen(open=>!open);if(layerSearchOpen)setLayerQuery('')}}/>
    </div>
   </div>
   {layerSearchOpen&&<div className="layer-search-popover">
    <label className="layer-search"><FigmaIcon name="layers-search"/><input ref={layerSearchInput} type="search" aria-label="搜索图层" placeholder="搜索图层"
     value={layerQuery} onChange={event=>setLayerQuery(event.target.value)}
     onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setLayerQuery('');setLayerSearchOpen(false);event.currentTarget.closest('.left-panel')?.querySelector<HTMLButtonElement>('button[aria-label="搜索图层"]')?.focus()}}}/></label>
   </div>}
   <div className="left-scroll">
    {imageIssue&&<div className="image-issue" role="alert">
     <p>{imageIssue.message}</p>
     <button className="text-button" disabled={!!regionDraft} onClick={()=>chooseImage(imageIssue.replacement)}>重新选择</button>
     <button className="text-button" onClick={()=>setImageIssue(null)}>关闭提示</button>
    </div>}
    <div className="unified-layers" ref={layerList} inert={!!regionDraft}>
     {cardTrees.map(renderCardBranch)}
     {!cardTrees.length&&query&&<p className="panel-description">没有找到匹配的图层。</p>}
    </div>
   </div>
  </aside>
  <main className="workspace" inert={leaving} onDragOver={dragOverWorkspace} onDrop={dropOnWorkspace}
   onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setSidebarDropFace(undefined)}}>
   <h1 className="sr-only">{side==='front'?'正面':'背面'}</h1>
   {collapsedLeft&&<div className="workspace-reopen reopen-left"><IconButton icon={Layers3} title="展开图层面板" onClick={()=>setCollapsedLeft(false)}/></div>}
   {collapsedRight&&<div className="workspace-reopen reopen-right"><IconButton icon={SlidersHorizontal} title="展开属性面板" onClick={()=>setCollapsedRight(false)}/></div>}
   {saveError&&<div className="conflict-banner save-error-banner" role="alert">
    <span>{'message' in save?save.message:''}</span>
    {save.status==='conflict'
     ?<>{(browserRuntime||workspaceHeaders()['X-Prism-Workspace']!=='lan')&&<button disabled={leaving} onClick={()=>void saveCopy()}>另存当前副本</button>}
        <button disabled={leaving} onClick={()=>void viewLatest()}>查看最新版</button></>
     :<button disabled={leaving} onClick={()=>void saveNow()}>重试保存</button>}
    <button onClick={()=>exportProject(current.current).then(()=>notify('项目包已下载')).catch(error=>notify(error.message))}>下载项目包</button>
   </div>}
   <div className={`canvas-area${sampling?' sampling-color':''}`} onPointerMoveCapture={event=>{
    if(sampling)setSampleColor(canvasPixel(event.currentTarget,event.clientX,event.clientY));
   }} onPointerLeave={()=>{if(sampling)setSampleColor(null)}} onPointerDownCapture={event=>{
    const focused=document.activeElement;
    if(focused instanceof HTMLElement&&inLayerList(focused))focused.blur();
    if(sampling){event.preventDefault();event.stopPropagation()}
   }} onClickCapture={event=>{
    if(!sampling||!sampler)return;
    event.preventDefault();event.stopPropagation();
    const color=canvasPixel(event.currentTarget,event.clientX,event.clientY);
    if(color){sampler.apply(color);setSampler(null)}
 }}><EditorCanvas onActivateMember={activateMemberFace} onFaceMenu={showFaceMenu} selectedBoards={boardSelection} hasLayerSelection={selectionUnits.length>0} onSelectBoards={selectBoards} onMoveBoards={moveBoards} cardBoundsRef={cardBoundsRef} project={displayedProject} side={side} selectedId={selected?.id??null} selectedIds={selectedArtworkIds} artworkGroupId={selectedGroup?.id} onSelectFace={selectCanvasFace}
    selectedUnits={selectionUnits} canvasSelection={canvasSelection} onSelectMarquee={selectMarquee} onMoveMarquee={moveMarquee} finishedView={finishedView} magicMouseZoom={magicMouseZoom}
    fontPreview={previewOnCanvas}
    samplingColor={sampling} navigationBlocked={Boolean(modal||stockChange||confirmDelete||leaving)} contextMenuOpen={Boolean(menu||faceMenu)}
    onSelectPath={(face,id)=>selectUnits([{kind:'artwork',id}],face)} onDrillArtwork={drillCanvasArtwork}
    radialEffectId={sampling||plate||flashOnly?undefined:radialEffectId} onRadialCenterChange={(id,center)=>patchStyle({
     visualEffects:designLayer?.visualEffects?.map(effect=>effect.id===id&&effect.kind==='radial-blur'?{...effect,center}:effect),
    })}
    onCanvasMenu={(target,point,screen,nodeId)=>{
     if(!canChangeBoards())return;
     const face=projectCards(current.current).find(card=>card.id===target.cardId)?.[target.face];
     if(!face)return;
     const node=face.nodes.find(item=>item.id===nodeId);
     if(node&&!layerInSelection(face,layerSelectionOn(target),{kind:'artwork',id:node.id},node.groupId)){
      activateProjectMember(target.cardId);
      selectUnits([canvasArtworkUnit(target.face,node)],target.face);
     }else if(!node&&(target.face!==side||processView==='all'))selectUnits([],target.face);
     setFaceMenu(undefined);setMenu({point,screen,target});
    }} onCreateVector={createVector} flashOnly={flashOnly}
    onTransferArtwork={moveArtwork} sidebarDropFace={sidebarDropFace} faceLocked={canvasFaceLocked} onSelect={(id,additive,direct)=>{
    if(regionDraft||plate||flashOnly)return;
    const node=id?active.nodes.find(item=>item.id===id):undefined;
    if(node)pickUnit(canvasArtworkUnit(side,node,direct),Boolean(additive));
    else selectLayer(null);
   }} onChange={changeCanvasSide} tool={tool} spaceHeld={spaceHeld} onStartSpacePan={startSpacePan} navigationRef={navigationRef} showGuides regionId={regionDraft?.id??targetRegion?.id??null} highlightRegion={maskHighlight} regionMode={!!regionDraft} onRegionChange={setRegionDraft}
    maskSelection={maskSelection} onMaskSelectionChange={setMaskSelection}
    textEdit={modal||regionDraft||leaving?undefined:textEdit} onTextEdit={editText} onTextCommit={finishTextEdit} onTextCancel={cancelTextEdit}
    plate={plate} brushSize={brushSize} layerPlate={isolatedPlate?layerPlate:undefined} effectPreviewId={effect?.id} editGradient={rightTab==='design'&&gradientEditing===selected?.id} onGradientChange={gradient=>patchStyle({gradient})} onGradientStart={startStyleEdit}/>
    {sampling&&<div className="canvas-picker-status" role="status"><Pipette size={14}/>{sampleColor?<><i style={{background:sampleColor}}/>{sampleColor}</>:'点击画布取色'}<kbd>Esc</kbd></div>}
   </div>
   {faceMenu&&<LayerContextMenu label="卡面操作" screen={faceMenu.screen} commands={boardCommands} dividers={[3,8]} close={closeFaceMenu}/>}
   {menu&&<LayerContextMenu screen={menu.screen} commands={commands} dividers={[3,8,10]} close={closeMenu}/>}
   {hasModeNotice&&<div className="canvas-notes"><div className="canvas-top-note">{regionDraft?regionHint:plate?(isolatedPlate?'独立工艺层 · 黑色表示施作位置':'按通道合版 · 黑色表示施作位置'):flashOnly?'局部闪光预览':'绿色显示当前蒙版范围'}</div></div>}
   {!finishedView&&!regionDraft&&<div className="canvas-guide-legend"><PrintGuideLegend project={project} face={side} compact/></div>}
   {regionDraft&&<div className="region-bar-dock">
    {!finishedView&&<div className="canvas-guide-legend"><PrintGuideLegend project={project} face={side} compact/></div>}
    <div className="region-bar" role="group" aria-label="蒙版编辑工具">
     <span className="region-bar-name"><Paintbrush size={16}/><span>{regionDraft.name}</span></span>
     <div className="region-bar-controls" role="group" aria-label="绘制工具">
      {['rect','ellipse','polygon'].includes(regionDraft.kind)&&<IconButton icon={Square} title="绘制几何轮廓" active={tool==='geometry'} onClick={()=>{
       if(regionDraft.kind==='polygon')setRegionDraft({...regionDraft,points:[]});
       chooseMaskTool('geometry');
      }}/>}
      <IconButton icon={Paintbrush} title="画笔" active={tool==='brush'} onClick={()=>chooseMaskTool('brush')}/>
      <IconButton icon={Eraser} title="擦除" active={tool==='eraser'} onClick={()=>chooseMaskTool('eraser')}/>
      <IconButton icon={SquareDashed} title="框选" active={tool==='mask-marquee'} onClick={()=>chooseMaskTool('mask-marquee')}/>
      <IconButton icon={<FigmaIcon name="tool-pen"/>} title="钢笔选区" active={tool==='mask-pen'} onClick={()=>chooseMaskTool('mask-pen')}/>
     </div>
     <div className="region-bar-controls">
      {maskSelectionTool?<>
       <Button disabled={!maskSelection} onClick={()=>applyMaskSelection(false)}>填充选区</Button>
       <Button disabled={!maskSelection} onClick={()=>applyMaskSelection(true)}>擦除选区</Button>
      </>:<>
       <input aria-label="笔刷大小" type="range" min="4" max="120" value={brushSize} onChange={e=>setBrushSize(+e.target.value)}/>
       <span>{brushSize}</span>
      </>}
     </div>
     <div className="region-bar-controls">
      <Button title="撤销蒙版编辑" onClick={undoRegion} disabled={!regionDraft.strokes.length&&!regionDraft.points?.length}><Undo2 size={14}/></Button>
      <Button onClick={()=>setRegionDraft({...regionDraft,inverted:!regionDraft.inverted})}>反选</Button>
      <Button onClick={cancelRegion}>取消</Button>
      <Button className="primary" onClick={applyRegion}><Check size={14}/>完成</Button>
      {viewToggle}
     </div>
    </div>
   </div>}
   {!regionDraft&&<div className="canvas-toolbox" role="group" aria-label="画布工具">
    <div className="canvas-tool-group">
     <IconButton icon={tool==='hand'?Hand:<FigmaIcon name="tool-select"/>} title={tool==='hand'?'平移画布 H':'选择 V'} active={tool==='select'||tool==='hand'} onClick={()=>setTool(tool==='hand'?'hand':'select')}/>
     <CanvasToolMenu title="选择画布工具">
      <button onClick={()=>setTool('select')}><FigmaIcon name="tool-select"/>选择 <kbd>V</kbd></button>
      <button onClick={()=>setTool('hand')}><Hand size={15}/>平移 <kbd>H</kbd></button>
      <button type="button" aria-pressed={magicMouseZoom} onClick={toggleMagicMouseZoom}>
       <Check size={15} aria-hidden="true" visibility={magicMouseZoom?'visible':'hidden'}/>妙控鼠标滑动缩放
      </button>
     </CanvasToolMenu>
    </div>
    <CanvasCardTool onAdd={addBlankOnCanvas} onAsset={()=>{if(canChangeBoards())setModal('pickAsset')}} disabled={canvasFaceLocked||memberBusy}/>
    <div className="canvas-tool-group">
     <IconButton icon={<FigmaIcon name="tool-line"/>} title="直线 L" active={tool==='line'} onClick={()=>activateCanvasTool('line')}/>
     <CanvasToolMenu title="直线工具"><button onClick={()=>activateCanvasTool('line')}><FigmaIcon name="tool-line"/>直线 <kbd>L</kbd></button></CanvasToolMenu>
    </div>
    <div className="canvas-tool-group">
     <IconButton icon={<FigmaIcon name="tool-rectangle"/>} title="添加矩形" onClick={()=>addNode('rect')}/>
     <CanvasToolMenu title="形状工具"><button onClick={()=>addNode('rect')}><FigmaIcon name="tool-rectangle"/>矩形</button><button onClick={()=>addNode('ellipse')}><Circle size={15}/>椭圆</button><button onClick={()=>addNode('polygon')}><Pentagon size={15}/>多边形</button><button onClick={()=>chooseImage()}><ImagePlus size={15}/>上传图片</button></CanvasToolMenu>
    </div>
    <div className="canvas-tool-group">
     <IconButton icon={<FigmaIcon name="tool-text"/>} title="添加文字" onClick={()=>addNode('text')}/>
     <CanvasToolMenu title="文字工具"><button onClick={()=>addNode('text')}><FigmaIcon name="tool-text"/>添加文字</button></CanvasToolMenu>
    </div>
    <div className="canvas-tool-group">
     <IconButton icon={<FigmaIcon name="tool-pen"/>} title="钢笔 P" active={tool==='pen'} onClick={()=>activateCanvasTool('pen')}/>
     <CanvasToolMenu title="钢笔工具"><button onClick={()=>activateCanvasTool('pen')}><FigmaIcon name="tool-pen"/>钢笔 <kbd>P</kbd></button></CanvasToolMenu>
    </div>
    {viewToggle}
   </div>}
  </main>
  <aside className={`right-panel ${designLayer?'design-inspector':''}`} aria-label="属性面板" inert={leaving}>
   <header className="drawer-action-bar">
    <img className="editor-avatar" src="/assets/workbench/local-avatar.png" width="24" height="24" alt=""/>
    <div className="drawer-main-actions">
     <IconButton icon={<FigmaIcon name="finished-preview"/>} title="成品预览" onClick={()=>setModal('preview')} disabled={leaving||!!regionDraft||readingImages>0}/>
     <Button className="primary drawer-text-action" onClick={()=>openExport()} disabled={leaving||!!regionDraft||readingImages>0}>导出</Button>
    </div>
   </header>
   <div className="inspector-view-header">
    <div className="inspector-view-tabs" role={hasDesign?'group':undefined} aria-label={hasDesign?'面板选项':undefined}>
     {hasDesign?<>
      <button type="button" aria-pressed={rightTab==='design'} onClick={()=>setInspectorTab('design')}>设计</button>
      <button type="button" aria-pressed={rightTab!=='design'} onClick={()=>setInspectorTab('properties')}>属性</button>
     </>:<span className="inspector-view-label">{rightTab==='group'?'设计':'属性'}</span>}
    </div>
    <Button className="icon-button inspector-collapse" title="收起右侧面板" onClick={()=>setCollapsedRight(true)}>
     <FigmaIcon name="panel-right-close"/>
    </Button>
   </div>
   {(rightTab!=='empty'||regionDraft||multiBoard)&&<div className="panel-toolbar inspector-toolbar">
    {hasDesign&&selected?<>
     <input className="inspector-layer-name" aria-label="图层名称" maxLength={100} value={selected.name}
      title={selected.name} placeholder="图层名称" disabled={selected.locked}
      onChange={event=>patchNode({name:event.target.value})}/>
     <div className="style-section-actions">
      <InspectorMenu ariaLabel="更多图层操作" triggerIcon={<FigmaIcon name="layer-more"/>} variant="action" menuWidth={242} align="end"
       options={[
        { value: 'duplicate', label: '复制图层', action: duplicateLayer },
        { value: 'delete', label: '删除图层', disabled: selected.locked, action: requestDelete },
        ...(['path','line','rect','ellipse','polygon'].includes(selected.type)?[{
         value:'edit-path',label:selected.type==='path'||selected.type==='line'?'编辑路径':'转为路径',
         disabled:selected.locked,action:()=>navigationRef.current?.editPath(side,selected.id),
        }]:[]),
        ...PROCESS_MENU_OPTIONS.map(({value,label}) => ({
         value, label, group: '设为工艺图层', disabled: selected.locked, action: () => changeKind(value),
        })),
       ]}/>
     </div>
    </>:selectedGroup&&!regionDraft?<LayerGroupName key={selectedGroup.id} name={selectedGroup.name} onRename={name=>{
     const next=renameLayerGroup(current.current[side],selectedGroup.id,name);
     if(next!==current.current[side])changeSide(next);
    }}/>:<span>{regionDraft?'蒙版属性':canvasSelection?`已选中 ${canvasSelection.boards.length+canvasSelection.layers.reduce((count,target)=>count+target.units.length,0)} 个对象`:
     rightTab==='card'?'卡牌属性':rightTab==='face'?(physicalCardFace(project,side)==='front'?'正面':'背面'):multiBoard?`已选中 ${boardSelection.length} 个卡面`:rightTab==='layerProperties'?selected?.name:rightTab==='multi'?`已选中 ${selectedCount} 个图层`:'工艺属性'}</span>}
   </div>}
   <div className={`right-scroll${(rightTab==='card'||rightTab==='face')&&!regionDraft?' card-properties-scroll':''}`} key={regionDraft?'mask':rightTab}>
   {proofReturn&&proof&&<Button className="wide-button" onClick={()=>{setProofReturn(false);setProofOpen(true)}}>返回分版核稿</Button>}
   {regionDraft?<div className="region-settings">
    <div className="section-heading">图层蒙版</div>
    <label className="field">蒙版名称<input value={regionDraft.name} onChange={event=>setRegionDraft({...regionDraft,name:event.target.value})}/></label>
    {regionDraft.kind==='node'&&regionDraft.nodeId&&<label className="field">定位方式<select value={regionDraft.binding} onChange={event=>{
     const binding=event.target.value as Region['binding'];
     const linked=active.nodes.find(node=>node.id===regionDraft.nodeId);
     setRegionDraft({...regionDraft,binding,snapshot:binding==='fixed'&&linked?structuredClone(linked):undefined,bounds:undefined});
    }}><option value="follow">跟随图层</option><option value="fixed">固定在卡面</option></select></label>}
    {active.regions.some(region=>region.id===regionDraft.id)&&<Button className="wide-button" onClick={()=>
     setRegionDraft({...regionDraft,id:uid(),name:regionDraft.name.slice(0,96)+' 副本',groupMotionCopy:undefined})
    }><Copy size={14}/>复制为独立蒙版</Button>}
    {active.regions.some(region=>region.id===regionDraft.id)&&<Button className="wide-button" onClick={()=>{
     const users=maskConsumers(active,dependentRegions(active,[regionDraft.id])).map(item=>item.name);
     setRemoveMask({id:regionDraft.id,users,fixed:frozenRegionCopies(project,active,regionDraft.id)});
    }}><Trash2 size={14}/>删除区域</Button>}
   </div>:<>
   {rightTab==='multi'&&!canvasSelection&&selectionUnits.every(unit=>unit.kind==='artwork')&&<StyleSection title="对齐与分布">
    <div className="multi-align-grid">{(['x','y'] as const).map(axis=>
      (['start','center','end','distribute'] as const).map((mode,index)=>{
       const label=(axis==='x'?['左对齐','水平居中','右对齐','水平等间距']:['顶对齐','垂直居中','底对齐','垂直等间距'])[index];
       const disabled=selectedArtworkIds.length<(mode==='distribute'?3:2)||selectedArtworkIds.some(id=>active.nodes.find(n=>n.id===id)?.locked||layoutParent(active,id));
       return <button key={axis+mode} disabled={disabled} onClick={()=>{const next=alignArtwork(active,selectedArtworkIds,axis,mode);if(next!==active)changeSide(next)}}>{label}</button>;
      }))}</div>
   </StyleSection>}
   {rightTab==='group'&&selectedGroup&&<>
    {selectedGroup.autoLayout?<AutoLayoutProperties key={selectedGroup.id} layout={selectedGroup.autoLayout} overflow={autoLayoutOverflow(active,selectedGroup.id)}
     locked={!editableArtwork} onRemove={toggleAutoLayout} onChange={layout=>changeSide(setAutoLayout(current.current[side],selectedGroup.id,layout))}/>
     :canAddLayout&&<Button className="wide-button" onClick={toggleAutoLayout}>添加自动布局</Button>}
    {parentLayout&&selectedGroup.autoLayout&&<LayoutItemProperties item={selectedGroup.layoutItem} parent={parentLayout} renderedSize={selectedGroup.autoLayout} allowHug
     disabled={!editableArtwork} onChange={layoutItem=>changeSide({...active,groups:active.groups?.map(group=>
      group.id===selectedGroup.id?{...group,layoutItem}:group)})}/>}
    <Button className="wide-button" onClick={dissolveLayerGroup}>解组</Button>
   </>}
   {rightTab==='effects'&&effect&&<div className="effect-properties current-process">
    <div className="section-heading"><span>{processName(effect)}</span>
     <div className="panel-toolbar-actions">
      <IconButton icon={Copy} title="复制当前工艺层" onClick={duplicateLayer}/>
      <IconButton icon={Trash2} title="删除当前工艺层" onClick={requestDelete}/>
     </div>
    </div>
    <label className="field">图层名称<input maxLength={100} value={effect.name} onChange={event=>patchEffect({name:event.target.value})}/></label>
    <LayerTypeField kind={processKind(effect)} onChange={changeKind}/>
    <label className="check-field"><input type="checkbox" checked={effectInProduction(effect)}
     onChange={event=>patchEffect({productionEnabled:event.target.checked})}/>纳入印刷输出</label>
    <LayerMaskField name="工艺蒙版" regions={maskRegions} value={targetRegion?.id} noMask={effect.maskContent?.length===0}
     sources={active.nodes.filter(node=>node.type!=='empty'&&node.visible)} onChange={selectMask}/>
    {targetRegion&&<span className="micro-copy">{side==='front'?'正面':'背面'} · {targetRegion.kind==='node'&&targetRegion.binding==='follow'?'跟随图层':'固定在卡面'}</span>}
    {sharedUsers.length>0&&<details className="mask-use-details"><summary>另有 {sharedUsers.length} 处使用此区域</summary><ul>{sharedUsers.map(user=><li key={user.id}>{user.name}</li>)}</ul></details>}
    {processKind(effect)==='reflection'&&<FlashStyles value={getFlashStyle(project,effect)} onChange={flashStyle=>{
     patchEffect({flashStyle,process:'reflection'});setLayerPlate(undefined);setShowLayerMask(false);
    }}/>}
    {processKind(effect)==='foil'&&<label className="field">箔材示意<select value={effect.type} onChange={event=>patchEffect({type:event.target.value as EffectType})}><option value="gold">金箔</option><option value="silver">银箔</option><option value="holo">镭射箔</option></select></label>}
    {['reflection','foil','varnish','emboss','deboss'].includes(processKind(effect))&&<><Range label="预览强度" value={effect.opacity*100} onChange={n=>patchEffect({opacity:n/100})}/><Range label="预览方向" value={effect.angle} min={0} max={360} unit="°" onChange={n=>patchEffect({angle:n})}/></>}
    {['primer','spot','emboss','deboss'].includes(processKind(effect))&&<p className="micro-copy">
     {processKind(effect)==='spot'?'此层输出实地专色蒙版。可在工艺单填写实际油墨色号。':
      processKind(effect)==='primer'?'此层定义底涂施作范围。可在工艺单填写底涂材料。':'此层输出平面施作范围。可在工艺单填写模具及深度要求。'}
    </p>}
    {processKind(effect)==='white'&&<>
     {effect.maskContent===undefined&&targetRegion?.kind==='node'&&active.nodes.find(node=>node.id===targetRegion.nodeId)?.type==='image'&&
      <p className="micro-copy mask-filename">白墨来源 · 跟随彩稿图片的裁切及不透明轮廓</p>}
     <Button className="wide-button" disabled={readingImages>0} onClick={()=>{whiteUploadTarget.current={id:effect.id,face:side};whiteInput.current?.click()}}><Upload size={14}/>{effect.maskContent?.some(node=>node.type==='image')?'替换白墨 PNG':'上传白墨 PNG'}</Button>
     {effect.maskContent?.filter(node=>node.type==='image').map(node=><p className="micro-copy mask-filename" key={node.id}>{node.name} · {node.maskInk==='dark'?'深色区域':'不透明区域'}</p>)}
    </>}
    <Button className="wide-button" onClick={()=>setModal('maskContent')}><Layers3 size={14}/>编辑蒙版内容</Button>
    {!!effect.maskContent?.length&&<Button className="wide-button" onClick={()=>patchEffect({maskContent:undefined})}>改用整个作用区域</Button>}
    {targetRegion&&effect.maskContent?.length!==0&&maskActions()}
    {plateFor(effect)&&<Button className="wide-button" active={Boolean(isolatedPlate)} onClick={()=>{setShowLayerMask(false);setLayerPlate(isolatedPlate?undefined:effect.id)}}>
     <ScanLine size={14}/>{isolatedPlate?'退出本层分版':'查看本层分版'}
    </Button>}
    {plateFor(effect)&&effectInProduction(effect)&&<Button className="wide-button" onClick={()=>openProof({selected:[plateFor(effect)!],artwork:false,
     applyFactory:!!projectPrintProfile(project),dpi:projectPrintProfile(project)?.dpi??300})}>分版核稿</Button>}
   </div>}
   {rightTab==='layerProperties'&&selected&&<>
    <StyleSection title="图层">
     <LayerTypeField kind="artwork" disabled={selected.locked} onChange={changeKind}/>
     {selected.type!=='text'&&<label className="check-field"><input type="checkbox" checked={Boolean(selected.printSafe)}
      disabled={selected.locked} onChange={event=>patchNode({printSafe:event.target.checked})}/>检查正文安全区</label>}
    </StyleSection>
    <StyleSection title="工艺图层" actions={<InspectorMenu ariaLabel="按图层轮廓添加效果" triggerIcon={<FigmaIcon name="section-add"/>}
     variant="action" menuWidth={242} align="end" options={PROCESS_MENU_OPTIONS}
     onChange={kind=>createProcessFromArtwork(selected,kind as ProcessKind)}/>}>
     {active.effects.filter(entry=>active.regions.some(region=>region.id===entry.regionId&&region.nodeId===selected.id))
      .map(entry=><button className="stack-link" type="button" key={entry.id} onClick={()=>chooseProcess(entry)}>
       <span className={'process-dot '+processKind(entry)} aria-hidden="true"/><span>{entry.name}</span><ChevronRight size={13}/>
      </button>)}
    </StyleSection>
    <StyleSection title="蒙版">
     <LayerMaskField name="彩稿蒙版" regions={maskRegions} value={selected.clipRegionId}
      disabled={selected.locked} artwork onChange={selectMask} compact/>
     {targetRegion&&maskActions()}
    </StyleSection>
   </>}
   {rightTab==='design'&&selected&&<>
     {parentLayout&&<LayoutItemProperties key={'layout-'+selected.id} item={selected.type==='text'?{heightMode:'hug',...selected.layoutItem}:selected.layoutItem} parent={parentLayout} renderedSize={selected}
      allowHug={selected.type==='text'} disabled={selected.locked} onChange={layoutItem=>patchNode({layoutItem})}/>}
     <LayerGeometry key={selected.id} node={selected} managedPosition={Boolean(parentLayout)} onChange={patchStyle} onEditStart={startStyleEdit}>
     <div className="style-fields inspector-alignments" aria-label="对齐到卡面">
       <div className="style-segmented">
        <StyleAction label="对齐到卡面右侧" disabled={selected.locked} onClick={()=>alignNode('x',1)}><FigmaIcon name="align-horizontal-end"/></StyleAction>
        <StyleAction label="对齐到卡面左侧" disabled={selected.locked} onClick={()=>alignNode('x',0)}><FigmaIcon name="align-horizontal-start"/></StyleAction>
        <StyleAction label="卡面水平居中" disabled={selected.locked} onClick={()=>alignNode('x',.5)}><FigmaIcon name="align-horizontal-center"/></StyleAction>
       </div>
       <div className="style-segmented">
        <StyleAction label="对齐到卡面顶部" disabled={selected.locked} onClick={()=>alignNode('y',0)}><FigmaIcon name="align-vertical-start"/></StyleAction>
        <StyleAction label="卡面垂直居中" disabled={selected.locked} onClick={()=>alignNode('y',.5)}><FigmaIcon name="align-vertical-center"/></StyleAction>
        <StyleAction label="对齐到卡面底部" disabled={selected.locked} onClick={()=>alignNode('y',1)}><FigmaIcon name="align-vertical-end"/></StyleAction>
       </div>
      </div>
     </LayerGeometry>
     <CanvasColorSamplingContext.Provider value={startSampling}><CanvasColorSamplingActiveContext.Provider value={sampling}>
     <LayerAppearanceEditor key={'appearance-'+selected.id} node={selected} onChange={patchStyle} onEditStart={startStyleEdit}
      editingGradient={gradientEditing===selected.id} onToggleGradient={toggleGradient}
      radialEditingId={radialEffectId} onToggleRadialEditing={effectId=>{
       setGradientEditing(null);
       setRadialEditing(radialEffectId===effectId?undefined:{layerId:selected.id,effectId});
       setTool('select');setShowLayerMask(false);setProcessView('all');setLayerPlate(undefined);
      }}
      stylePresets={project.stylePresets} onStylePresetsChange={stylePresets=>commit({...current.current,stylePresets})}
      onCrop={()=>setModal('crop')} preserveImageCrop={replaceCrop}>
      {selected.type==='text'&&<LayerTypography key={`${project.cardId}:${side}:${selected.id}`} node={selected} onChange={patchStyle} onEditStart={startStyleEdit}
       onPreview={style=>setFontPreview(style&&selected.visible&&!selected.locked?{cardId:project.cardId,face:side,node:selected,style}:undefined)}/>}
     </LayerAppearanceEditor>
     </CanvasColorSamplingActiveContext.Provider></CanvasColorSamplingContext.Provider>
    <StyleSection title="蒙版" className="style-mask-section">
     <LayerMaskField name="彩稿蒙版" regions={maskRegions} value={selected.clipRegionId}
      disabled={selected.locked} artwork onChange={selectMask} compact/>
     {targetRegion&&maskActions()}
    </StyleSection>
   </>}
   {rightTab==='card'&&!regionDraft&&<div className="card-properties">
    <section className="card-property-section">
     <h3 className="section-heading">卡基与底材</h3>
     <StockPicker material={project.material} spec={effectiveStockSpec(project)??{}}
       onMaterial={material=>setStockChange({material,stockSpec:changeStockSpec(material,project.material,effectiveStockSpec(project)??{})})}
       onSpec={spec=>changeBase(project.material,spec)}/>
    </section>
    <CardSpecificationFields project={project} onChange={changeCardSpecification}/>
   </div>}
   {rightTab==='face'&&!regionDraft&&<div className="card-properties">
    <StockFinishControls project={project} side={side} onChange={changeFinish} onMatch={()=>setModal('stockMatch')}/>
   </div>}

   </>}
   </div></aside>
  {toast&&<div className="toast" role="status"><CheckCircle2 size={17}/>{toast}</div>}
  {modal==='maskUnion'&&<MaskUnionModal regions={maskRegions} onClose={closeModal} onApply={(sources,operation)=>{
   bindRegion({id:uid(),name:'组合蒙版',kind:'union',operation,sources,binding:'fixed',inverted:false,strokes:[]});
   closeModal();
  }}/>}
  {modal==='maskContent'&&effect&&<Modal title={effect.name+' · 蒙版内容'} wide onClose={closeModal}><MaskContentEditor project={project} side={active} effect={effect} onClose={closeModal} onApply={maskContent=>{patchEffect({maskContent});closeModal()}}/></Modal>}
  {maskScope&&targetRegion&&<Modal title="编辑共享蒙版" className="prepress-modal" onClose={()=>setMaskScope(false)}>
   <div className="help-content"><strong>{targetRegion.name}</strong><p>同时作用于{sharedUsers.map(item=>'「'+item.name+'」').join('、')}。</p></div>
   <div className="modal-footer"><Button onClick={()=>setMaskScope(false)}>取消</Button><Button onClick={()=>{setMaskScope(false);startRegion(targetRegion)}}>修改共享区域</Button>
    <Button className="primary" onClick={()=>{setMaskScope(false);startRegion({...targetRegion,id:uid(),groupMotionCopy:undefined,name:targetRegion.name.slice(0,96)+' 副本'})}}>只改本层</Button></div>
  </Modal>}
  {removeMask&&<Modal title="删除蒙版区域" className="prepress-modal" onClose={()=>setRemoveMask(undefined)}>
   <div className="help-content"><strong>{side==='front'?'正面':'背面'} · {active.regions.find(region=>region.id===removeMask.id)?.name}</strong>
   <ul>{removeMask.users.map((name,i)=><li key={i}>{name}</li>)}</ul></div>
   <div className="modal-footer"><Button onClick={()=>setRemoveMask(undefined)}>取消</Button><Button onClick={()=>deleteMask(false)}>删除区域与关联引用</Button>
    <Button className="primary" disabled={!removeMask.fixed} onClick={()=>deleteMask(true)}>保留固定轮廓并删除</Button></div>
  </Modal>}
  {conflictLatest&&<Modal title="服务器上的最新版" className="member-modal" onClose={()=>{if(!leaving)setConflictLatest(undefined)}}>
   <div className="card-manager-body"><strong>{conflictLatest.name}</strong>
    <p>{conflictLatest.cardCount} 张卡 · {new Date(conflictLatest.updatedAt).toLocaleString()} · v{conflictLatest.project.version}</p>
    <div className="member-bar"><button disabled={leaving} onClick={()=>setConflictLatest(undefined)}>保留当前草稿</button>
     <button disabled={leaving||conflictLatest.archivedAt!==null} onClick={()=>void openLatest()}>下载草稿并打开最新版</button></div>
   </div></Modal>}
  {modal==='members'&&<Modal title="项目中的卡牌" className="member-modal" onClose={()=>{if(!memberLock.current)closeModal()}}>
   <CardManager project={project} busy={memberBusy} onSwitch={switchMember}
    onCopy={()=>void saveBeforeMemberAction(()=>{
     const doc=current.current,card=projectCards(doc)[doc.activeCardIndex??0];
     addMember(cloneProjectCard(card,card.name.slice(0,495)+' 副本'));
    })} onName={name=>{if(name!==current.current.cardName)commit({...current.current,cardName:name})}}
    onRemove={()=>void saveBeforeMemberAction(removeMember)} onMove={reorderMember}
    onPublish={()=>void saveBeforeMemberAction(()=>setModal('publishAsset'))}
    onAsset={()=>void saveBeforeMemberAction(()=>setModal('pickAsset'))}
    onShare={!browserRuntime&&['localhost','127.0.0.1','[::1]'].includes(location.hostname)?()=>void saveBeforeMemberAction(()=>setModal('lanShare')):undefined}
    onHistory={()=>void saveBeforeMemberAction(()=>setModal('deliveryHistory'))}/>
  </Modal>}
  {modal==='publishAsset'&&<PublishCardAsset project={project} onClose={closeModal} onViewAsset={asset=>onViewAsset(asset.id,asset.version)}/>}
  {modal==='pickAsset'&&<PickCardAsset onClose={closeModal} onPick={card=>{
   const profile=current.current.production?.printProfile;
   addMember(profile?{...card,production:{...card.production,dieShape:card.production?.dieShape??'card',steps:card.production?.steps??[],printProfile:structuredClone(profile)}}:card);
   closeModal();
   void saveNow().then(saved=>{if(saved)return recordAssetUse(record.id,card.id,card);}).catch(()=>{});
  }}/>}
  {retainedDraft&&<Modal title="恢复账号草稿" className="member-modal" onClose={()=>setRetainedDraft(undefined)}>
   <div className="card-manager-body"><p>{retainedDraft.revision===record.revision?'上次未保存的修改可以继续编辑。':'项目已在别处保存更新，可将保留的草稿另存为项目。'}</p></div>
   <div className="modal-footer"><Button disabled={leaving} onClick={()=>setRetainedDraft(undefined)}>稍后</Button>
    <Button className="primary" disabled={leaving} onClick={()=>{
     const draft=retainedDraft;
     if(draft.revision===record.revision&&current.current.version===record.project.version){
      setRetainedDraft(undefined);commit(draft.project);return;
     }
     setLeaving(true);
     void createStoredProject(copyProject(draft.project,draft.project.name.slice(0,494)+' 草稿',1)).then(async saved=>{
      await discardAccountDraft(editorAccount.current,record.id).catch(()=>{});onOpen(saved);
     }).catch(error=>{notify((error as Error).message);setLeaving(false);});
    }}>{retainedDraft.revision===record.revision?'恢复草稿':'另存草稿'}</Button>
   </div>
  </Modal>}

  {modal==='lanShare'&&<Modal title="局域网接力" className="member-modal" onClose={closeModal}>
   <LanShare projectId={project.id} name={project.name}/>
  </Modal>}
  {modal==='deliveryHistory'&&<Modal title="交付版本" className="member-modal" onClose={closeModal}>
   <DeliveryHistory projectId={project.id} onOpen={onOpen}/>
  </Modal>}
  {modal==='rename'&&<RenameProject name={project.name} onClose={closeModal} onRename={name=>{if(name!==project.name)commit({...current.current,name});closeModal()}}/>}
  {modal==='crop'&&selected&&cropFill&&<Modal title="编辑图片裁切" wide onClose={closeModal}><CropEditor key={selected.id}
   node={{...selected,src:cropFill.src,crop:cropFill.crop}} onCancel={closeModal} onApply={applyCrop}
   preserveCrop={{checked:replaceCrop,onChange:setReplaceCrop}}/></Modal>}
  {modal==='preview'&&<AlbumPreview cardBoundsRef={cardBoundsRef} project={project} initialSide={side} material={MATERIALS.find(m=>m.id===project.material)?.name}
   onClose={closeModal} onExport={view=>openExport('image',view)}/>}
  {modal==='production'&&<Modal title="卡牌制作" drawer onClose={closeModal}>
   <ProductionPlanEditor project={project} material={MATERIALS.find(m=>m.id===project.material)?.name||project.material}
    initialTab="spec" onChange={(production,key)=>{
     const doc=current.current;
     const next={...doc,production};
     if(stockKeys(doc).profileKey!==stockKeys(next).profileKey){
      for(const face of BOTH_FACES)if(doc[face].stockFinish?.match)next[face]=resetStockFinishMatch(doc,face);
     }
     commit(next,key);
    }} onArtwork={closeModal}
    onSize={()=>{setReturnToPlan(true);setModal('size')}} onStock={()=>{openCardProperties();closeModal()}}
    onPreflight={()=>openExport('print')} onLocate={locateProductionLayer}/>
  </Modal>}
  <ExportPanel open={modal==='export'} project={project} onClose={closeModal} notify={notify}
   entry={exportEntry} stillView={stillView} onLocate={(target,settings)=>{
    const entry=project[target.side].effects.find(item=>item.id===target.effectId);
    const channel=entry&&plateFor(entry);
    setProof({side:target.side,selected:channel?[channel]:[],artwork:!channel,showGuides:true,showOverlap:false,...settings});
    setProofReturn(true);locatePreflight(target);
   }} onProof={openProof}/>
  {proofOpen&&proof&&<Modal title="分版核稿" wide className="prepress-modal" onClose={()=>setProofOpen(false)}><PlateProof project={project} settings={proof} onChange={setProof}
   onLocate={target=>{setProofOpen(false);setProofReturn(true);locatePreflight(target)}}/></Modal>}
  {modal==='size'&&<SizeModal project={project} initial={proposedSize} onClose={closeSize} onApply={p=>{
   if(p.singleSided&&side==='back')switchSide('front');
   commit(p);closeSize();notify('尺寸已更新');
  }}/>}
  {modal==='stockMatch'&&<Modal title={'匹配反光用料 · '+(side==='front'?'正面':'背面')} onClose={closeModal}>
   <StockFinishMatchForm project={project} side={side} onClose={closeModal} onPlan={openPlan} onApply={match=>{
    changeFinish({...getStockFinish(current.current,side),match,reviewRequired:undefined});
    closeModal();
   }}/>
  </Modal>}
  {stockChange&&<Modal title="确认更换卡基" onClose={()=>setStockChange(undefined)}>
   <div className="new-content spec-list">
    <span>当前<b>{stockPreset(project.material)?.name??project.material}</b></span>
    <span>更换为<b>{stockPreset(stockChange.material)?.name}</b></span>
    {project.production?.stockCode&&<p className="micro-copy">更换后请重新匹配印厂用料。</p>}
   </div>
   <div className="modal-footer"><Button onClick={()=>setStockChange(undefined)}>取消</Button><Button className="primary" onClick={()=>{
    changeBase(stockChange.material,stockChange.stockSpec);setStockChange(undefined);
   }}>应用卡基</Button></div>
  </Modal>}
  {confirmDelete&&<Modal title="删除关联图层" className="prepress-modal" onClose={()=>setConfirmDelete(null)}>
   <div className="help-content"><strong>{side==='front'?'正面':'背面'} · {confirmDelete.name}</strong>
    <ul>{sourceMaskImpact(active,confirmDelete).users.map(item=><li key={item.id}>{item.name}</li>)}</ul></div>
   <div className="modal-footer"><Button onClick={()=>setConfirmDelete(null)}>取消</Button><Button onClick={()=>deleteLayers(confirmDelete,true)}>删除关联区域与效果</Button>
    <Button className="primary" onClick={()=>deleteLayers(confirmDelete,false)}>保留固定轮廓并删除</Button></div>
  </Modal>}
  {confirmMove&&<Modal title="跨面移动图层" className="prepress-modal" onClose={()=>setConfirmMove(undefined)}>
   <div className="help-content"><p>{confirmMove.side==='front'?'正面':'背面'}的以下图层将保留当前位置的蒙版轮廓。</p>
    <ul>{confirmMove.names.map((name,index)=><li key={index}>{name}</li>)}</ul></div>
   <div className="modal-footer"><Button onClick={()=>setConfirmMove(undefined)}>取消</Button><Button className="primary" onClick={confirmMove.apply}>固定轮廓并移动</Button></div>
  </Modal>}
  {svgRasterChoice&&<Modal title="导入 SVG" className="member-modal svg-import-modal" onClose={()=>finishSvgRasterChoice(false)}>
   <div className="help-content">
    <p>{svgRasterChoice.reason}</p>
    <p>可保留外观为一张透明图片，路径将无法单独编辑。</p>
   </div>
   <div className="modal-footer"><Button onClick={()=>finishSvgRasterChoice(false)}>取消</Button>
    <Button className="primary" onClick={()=>finishSvgRasterChoice(true)}>按图片导入</Button></div>
  </Modal>}
 </div>
}

function MaskUnionModal({regions,onClose,onApply}:{regions:Region[];onClose:()=>void;onApply:(ids:string[],operation:NonNullable<Region['operation']>)=>void}) {
 const [ids,setIds]=useState<string[]>([]);
 const [operation,setOperation]=useState<NonNullable<Region['operation']>>('union');
 return <Modal title="组合蒙版" onClose={onClose}>
  <div className="new-content">
   <label className="field">运算方式<select value={operation} onChange={event=>setOperation(event.target.value as NonNullable<Region['operation']>)}>
    <option value="union">并集</option><option value="intersection">相交</option><option value="subtract">相减</option></select></label>
   {regions.map(region=><label key={region.id} className="check-field">
    <input type="checkbox" checked={ids.includes(region.id)} disabled={ids.length>=16&&!ids.includes(region.id)}
     onChange={event=>setIds(items=>event.target.checked?[...items,region.id]:items.filter(id=>id!==region.id))}/>{region.name}{operation==='subtract'&&ids[0]===region.id?' · 保留区域':''}
   </label>)}
  </div>
  <div className="modal-footer"><Button onClick={onClose}>取消</Button>
   <Button className="primary" disabled={ids.length<2} onClick={()=>onApply(ids,operation)}>应用组合蒙版</Button>
  </div>
 </Modal>;
}

function RenameProject({name,onClose,onRename}:{name:string;onClose:()=>void;onRename:(name:string)=>void}) {
 const [value,setValue]=useState(name);
 return <Modal title="重命名项目" onClose={onClose}>
  <form onSubmit={event=>{event.preventDefault();if(value.trim())onRename(value.trim())}}>
   <div className="new-content"><label className="field">项目名称<input autoFocus value={value} maxLength={500} onChange={event=>setValue(event.target.value)}/></label></div>
   <div className="modal-footer"><Button onClick={onClose}>取消</Button><button className="button primary" disabled={!value.trim()}>保存名称</button></div>
  </form>
 </Modal>;
}

function NewProject({onClose,onCreate,pending,error}:{onClose:()=>void;onCreate:(project:Project)=>void;pending:boolean;error:string}){
 const [name,setName]=useState(''),[note,setNote]=useState('');
 const [material,setMaterial]=useState('matte');
 const [stockSpec,setStockSpec]=useState<StockSpec>(()=>stockPreset('matte')!.defaults);
 const [sizeIndex,setSizeIndex]=useState(0);
 const [customSize,setCustomSize]=useState<{width:string;height:string}>();
 const preset=CARD_SIZE_PRESETS[sizeIndex];
 const dimensions=preset?{width:preset.width.toFixed(2),height:preset.height.toFixed(2)}:customSize!;
 const width=Number(dimensions.width),height=Number(dimensions.height);
 const validSize=width>=20&&width<=300&&height>=20&&height<=300;
 const draft=useRef<{key:string;project:Project}|null>(null);
 const submit=()=>{
  if(pending||!validSize)return;
  const title=name.trim()||TEMPLATE_NAMES.blank;
  const remark=note.trim();
  const key=JSON.stringify([title,remark,width,height,material,stockSpec]);
  if(draft.current?.key!==key){
   draft.current={key,project:{
    ...createProject('blank',title),note:remark||undefined,widthMm:width,heightMm:height,material,stockSpec,
   }};
  }
  onCreate(draft.current.project);
 };
 return <Modal title="新建项目" className="new-project-modal" onClose={onClose} closeDisabled={pending}>
  <form className="new-project-form" noValidate onSubmit={event=>{event.preventDefault();submit()}}>
   <div className="new-project-fields">
    <fieldset aria-label="项目设置" disabled={pending}>
     <label className="field">项目名称<input value={name} placeholder={TEMPLATE_NAMES.blank} maxLength={80}
      onChange={event=>setName(event.target.value)}/></label>
     <label className="field">备注<input value={note} placeholder="请输入备注" maxLength={MAX_PROJECT_NOTE_LENGTH}
      onChange={event=>setNote(event.target.value)}/></label>
     <div className="new-project-size">
      <label className="field">卡牌尺寸
       <span className="stock-select">
        <select value={sizeIndex} onChange={event=>{
         const index=Number(event.target.value);
         if(index===-1&&!customSize)setCustomSize(dimensions);
         setSizeIndex(index);
        }}>
         <CardSizePresetOptions/>
         <option value="-1">自定义</option>
        </select>
       </span>
      </label>
      <div className="new-project-dimensions">
       {(['width','height'] as const).map(axis=>{
        const value=Number(dimensions[axis]);
        return <label className="new-project-measure" key={axis}>
         <span aria-hidden="true">{axis==='width'?'宽':'高'}</span>
         <input type="number" aria-label={axis==='width'?'宽度（mm）':'高度（mm）'} min={20} max={300} step="any"
          aria-invalid={value<20||value>300||undefined} disabled={Boolean(preset)} value={dimensions[axis]}
          onChange={event=>setCustomSize({...dimensions,[axis]:event.target.value})}/>
         <span aria-hidden="true">mm</span>
        </label>;
       })}
      </div>
      {!validSize&&<p className="new-project-error" role="alert">宽高须在 20–300 mm 之间。</p>}
     </div>
     <StockPicker material={material} spec={stockSpec} onSpec={setStockSpec} presetMeasurements
      onMaterial={value=>{setStockSpec(changeStockSpec(value,material,stockSpec));setMaterial(value)}}/>
     {error&&<p className="new-project-error" role="alert">{error}</p>}
    </fieldset>
   </div>
   <div className="modal-footer">
    <Button disabled={pending} onClick={onClose}>取消</Button>
    <button type="submit" className="button primary" disabled={pending||!validSize}>{pending?'新建中…':'新建'}</button>
   </div>
  </form>
 </Modal>;
}

const CARD_SIZE_PRESETS = [
 { label: '宝可梦卡牌', width: 63, height: 88 },
 { label: '球星卡', width: 63.5, height: 88.9 },
 { label: '游戏王卡牌', width: 59, height: 86 },
 { label: '塔罗牌', width: 70, height: 120 },
 { label: '万智牌', width: 63, height: 88 },
 { label: '海贼王卡牌', width: 63, height: 88 },
 { label: '迪士尼洛卡纳', width: 63, height: 88 },
 { label: 'Riftbound 符文战场', width: 63, height: 88 },
 { label: '高达卡牌', width: 63, height: 88 },
 { label: 'Union Arena', width: 63, height: 88 },
 { label: '龙珠超 Fusion World', width: 63, height: 88 },
 { label: '数码宝贝卡牌', width: 63, height: 88 },
 { label: 'Star Wars: Unlimited', width: 63, height: 88 },
] as const;

function CardSizePresetOptions() {
 return CARD_SIZE_PRESETS.map(({label,width,height},index)=>
  <option key={label} value={index}>{label} · {width} × {height} mm</option>
 );
}

type CardSpecification = Pick<Project,'widthMm'|'heightMm'|'bleedMm'|'cornerRadiusMm'>;

function CardSpecificationMeasure({label,mark,unit,value,min,max,disabled,onChange}:{
 label:string;mark:string;unit?:string;value:number;min:number;max:number;disabled?:boolean;onChange:(value:number)=>void;
}) {
 const [draft,setDraft]=useState<string>();
 const display=Number(value.toFixed(2))===value?value.toFixed(2):String(value);
 return <label className="new-project-measure card-spec-measure">
  <span aria-hidden="true">{mark}</span>
  <input type="number" aria-label={label} value={draft??display} min={min} max={max} step="any"
   disabled={disabled} data-undo-draft={draft!==undefined||undefined} onChange={event=>setDraft(event.currentTarget.value)}
   onBlur={event=>{
    const field=event.currentTarget;
    if(draft!==undefined&&field.validity.valid&&Number.isFinite(field.valueAsNumber)&&field.valueAsNumber!==value)
     onChange(field.valueAsNumber);
    setDraft(undefined);
   }}
   onKeyDown={event=>{
    if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}
    if(event.key==='Escape'){event.stopPropagation();setDraft(undefined)}
   }}/>
  {unit&&<span aria-hidden="true">{unit}</span>}
 </label>;
}

function CardSpecificationFields({project,onChange}:{project:Project;onChange:(patch:Partial<CardSpecification>)=>void}) {
 const {widthMm,heightMm,bleedMm}=project;
 const [choice,setChoice]=useState<{index:number;width:number;height:number}>();
 const matching=CARD_SIZE_PRESETS.findIndex(preset=>preset.width===widthMm&&preset.height===heightMm);
 const sizeIndex=choice?.width===widthMm&&choice.height===heightMm?choice.index:matching;
 const applySize=(width:number,height:number,index:number)=>{
  setChoice({width,height,index});
  onChange({widthMm:width,heightMm:height});
 };
 return <section className="card-property-section card-specification">
  <h3 className="section-heading">版面规格</h3>
  <div className="card-size-fields">
   <label className="field">卡牌尺寸<span className="stock-select card-size-select">
    <select aria-label="卡牌尺寸" value={sizeIndex} onChange={event=>{
     const index=Number(event.target.value);
     const preset=CARD_SIZE_PRESETS[index];
     if(preset)applySize(preset.width,preset.height,index);
     else setChoice({index:-1,width:widthMm,height:heightMm});
    }}>
     <CardSizePresetOptions/>
     <option value="-1">自定义</option>
    </select>
   </span></label>
   <div className="new-project-dimensions">
    <CardSpecificationMeasure label="宽度（mm）" mark="宽" unit="mm" value={widthMm} min={20} max={300}
     disabled={sizeIndex!==-1} onChange={width=>applySize(width,heightMm,-1)}/>
    <CardSpecificationMeasure label="高度（mm）" mark="高" unit="mm" value={heightMm} min={20} max={300}
     disabled={sizeIndex!==-1} onChange={height=>applySize(widthMm,height,-1)}/>
   </div>
  </div>
  <div className="card-bleed-fields" role="group" aria-label="出血与成品圆角">
   <span>出血与成品圆角</span>
   <div className="new-project-dimensions">
    <CardSpecificationMeasure label="出血（mm）" mark="出血" unit="mm" value={bleedMm} min={0} max={20}
     onChange={bleedMm=>onChange({bleedMm})}/>
    <CardSpecificationMeasure label="成品圆角半径（mm）" mark="成品圆角" value={getCardCornerRadiusMm(project)} min={0}
     max={Math.min(widthMm,heightMm)/2} onChange={cornerRadiusMm=>onChange({cornerRadiusMm})}/>
   </div>
  </div>
 </section>;
}

function resizeCard(project:Project,width:number,height:number,bleed:number,radius:number,fitArtwork:boolean) {
  const next={...project,front:structuredClone(project.front),back:structuredClone(project.back),widthMm:width,heightMm:height,bleedMm:bleed,cornerRadiusMm:radius};
  if(fitArtwork&&(project.widthMm!==width||project.heightMm!==height)){
   const scale=Math.min(width/project.widthMm,height/project.heightMm);
   const dx=(width-project.widthMm*scale)*5,dy=(height-project.heightMm*scale)*5;
   const scaleOffset=(value:number)=>Math.max(-MAX_LAYOUT_ITEM_OFFSET,Math.min(MAX_LAYOUT_ITEM_OFFSET,value*scale));
   const scaleItem=(item:CardNode['layoutItem'])=>item?{...item,
    ...(item.offset?{offset:{x:scaleOffset(item.offset.x),y:scaleOffset(item.offset.y)}}:{}),
    minWidth:item.minWidth===undefined?undefined:Math.max(1,item.minWidth*scale),
    minHeight:item.minHeight===undefined?undefined:Math.max(1,item.minHeight*scale)}:undefined;
   const scaleNode=(node:CardNode)=>{
    node.x=node.x*scale+dx;node.y=node.y*scale+dy;node.width*=scale;node.height*=scale;
    if(node.fontSize)node.fontSize*=scale;
    if(node.strokeWidth)node.strokeWidth*=scale;
    if(node.letterSpacing)node.letterSpacing*=scale;
    if(node.cornerRadius)node.cornerRadius*=scale;
    node.layoutItem=scaleItem(node.layoutItem);
    if(node.visualEffects)node.visualEffects=node.visualEffects.map(effect=>{
     if(effect.kind==='radial-blur')return effect;
     if(effect.kind==='gaussian-blur')return {...effect,radius:Math.min(500,effect.radius*scale)};
     return {...effect,x:Math.max(-500,Math.min(500,effect.x*scale)),y:Math.max(-500,Math.min(500,effect.y*scale)),
      radius:Math.min(500,effect.radius*scale),spread:Math.max(-100,Math.min(100,effect.spread*scale))};
    });
   };
   for(const side of [next.front,next.back]){
    side.nodes.forEach(scaleNode);
    side.effects.forEach(effect=>effect.maskContent?.forEach(scaleNode));
    for(const group of side.groups??[]){
     group.layoutItem=scaleItem(group.layoutItem);
     if(!group.autoLayout)continue;
     group.autoLayout=scaleAutoLayout(group.autoLayout,scale,scale,dx,dy);
    }
    for(const region of side.regions){
     if(region.bounds){region.bounds.x=region.bounds.x*scale+dx;region.bounds.y=region.bounds.y*scale+dy;region.bounds.width*=scale;region.bounds.height*=scale}
     if(region.points)region.points=region.points.map((p,i)=>p*scale+(i%2?dy:dx));
     if(region.snapshot)scaleNode(region.snapshot);
     for(const stroke of region.strokes){
      if(stroke.kind==='selection')stroke.pathPoints=mapVectorPoints(stroke.pathPoints, point=>({x:point.x*scale+dx,y:point.y*scale+dy}));
      else {stroke.size*=scale;stroke.points=stroke.points.map((p,i)=>p*scale+(i%2?dy:dx));}
     }
    }
   }
  }
  return next;
}

function SizeModal({project,initial,onClose,onApply}:{project:Project;initial?:Partial<CardSpecification>;onClose:()=>void;onApply:(p:Project)=>void}){
 const [width,setWidth]=useState(initial?.widthMm??project.widthMm),[height,setHeight]=useState(initial?.heightMm??project.heightMm),[bleed,setBleed]=useState(initial?.bleedMm??project.bleedMm);
 const [sizeIndex,setSizeIndex]=useState(-1);
 const [radius,setRadius]=useState(() => getCardCornerRadiusMm(project));
 const singleSided=Boolean(project.singleSided);
 const [mode,setMode]=useState('keep');
 const maxRadius=Math.max(0,Math.min(width,height)/2);
 const validSize=width>=20&&width<=300&&height>=20&&height<=300&&bleed>=0&&bleed<=20;
 const validRadius=Number.isFinite(radius)&&radius>=0&&radius<=maxRadius;
 const valid=validSize&&validRadius;
 const proposal=valid?resizeCard(project,width,height,bleed,radius,mode==='scale'):null;
 const clippedCount=(face:SideName)=>proposal?.[face].nodes.filter(node=>{
  if(node.type==='empty'||!node.visible)return false;
  const {left,top,right,bottom}=printNodeBounds(node);
  return left < -bleed*10 || top < -bleed*10 || right > (width+bleed)*10 || bottom > (height+bleed)*10;
 }).length??0;
 const resize=()=>{if(proposal)onApply(proposal)};
 return <Modal title="卡片尺寸" onClose={onClose}><div className="new-content">
  <label className="field">常用成品尺寸
   <select value={sizeIndex} onChange={event=>{
    const index=Number(event.target.value);
    const preset=CARD_SIZE_PRESETS[index];
    setSizeIndex(index);
    setWidth(preset.width);
    setHeight(preset.height);
   }}>
    <option value={-1} disabled>选择尺寸预设</option>
    <CardSizePresetOptions/>
   </select>
  </label>
  <div className="field-grid three">
   <label className="field">宽度（mm）<input type="number" value={width} min={20} max={300} step="any" onChange={e=>{setWidth(+e.target.value);setSizeIndex(-1)}}/></label>
   <label className="field">高度（mm）<input type="number" value={height} min={20} max={300} step="any" onChange={e=>{setHeight(+e.target.value);setSizeIndex(-1)}}/></label>
   <label className="field">出血（mm）<input type="number" value={bleed} min={0} max={20} step="any" onChange={e=>setBleed(+e.target.value)}/></label>
  </div>
  <div className="corner-settings">
   <div>
    <label className="field">成品圆角半径（mm）<input type="number" value={radius} min={0} max={maxRadius} step=".1" aria-invalid={!validRadius} onChange={event=>setRadius(+event.target.value)}/></label>
    {!validRadius&&<p className="micro-copy">成品圆角半径须在 0–{maxRadius} mm 之间。</p>}
   </div>
   {validSize&&<PrintCornerPreview project={{widthMm:width,heightMm:height,bleedMm:bleed,cornerRadiusMm:radius,production:project.production}}/>}
  </div>
  <label className="field">图层处理<select value={mode} onChange={e=>setMode(e.target.value)}><option value="keep">保持对象实际尺寸</option><option value="scale">整体等比缩放并居中</option></select></label>
  {proposal&&<p className="micro-copy" role="status">超出出血的可见对象：{physicalCardFace(project,'front')==='front'?'正面':'背面'} {clippedCount('front')} 个{singleSided?'':'，背面 '+clippedCount('back')+' 个'}</p>}
  {projectPrintProfile(project)&&[width!==project.widthMm,height!==project.heightMm,bleed!==project.bleedMm].some(Boolean)&&
   <p className="micro-copy" role="status">规格或面数变更后，请用当前厂规重新预检。</p>}
  <p className="micro-copy">{validSize?`含出血 ${+(width+bleed*2).toFixed(2)} × ${+(height+bleed*2).toFixed(2)} mm`:'宽高须在 20–300 mm，出血须在 0–20 mm。'}</p>
 </div><div className="modal-footer"><Button onClick={onClose}>取消</Button><Button className="primary" disabled={!valid} onClick={resize}>应用尺寸</Button></div></Modal>;
}

type ExportMode='image'|'print'|'project';
type PrintProfile=TechnicalPrintProfile;
type ExportDpi=300|600;
type ExportRequest={mode:ExportMode;project:Project;sides:SideName[];dpi:number;format:'png'|'jpeg';profile:PrintProfile;
 applyFactory:boolean;vector:boolean;imageWidth:number;imageHeight:number;imageBackground:string;view?:StillView;
 resampling:'high'|'medium';includeModel:boolean;modelShading:ModelShading;issues:PreflightIssue[]};
type DeliveryRecovery={project:Project;source?:Blob;name:string;error?:string};
type ModelPreviewState={status:'loading'}|{status:'ready';file:Blob}|{status:'error';message:string};

const ExportModelPreview=lazy(()=>import('./ExportModelPreview'));
const FRONT_ONLY:SideName[]=['front'];
const BOTH_FACES:SideName[]=['front','back'];

function ExportSelect({label,value,onChange,children,disabled=false,title}:{
 label:string;value:string|number;onChange?:(value:string)=>void;children:ReactNode;disabled?:boolean;title?:string
}){
 return <label className="export-field">
  <span>{label}</span>
  <span className="export-select">
   <select value={value} onChange={event=>onChange?.(event.target.value)} disabled={disabled} title={title}>{children}</select>
   <ChevronDown size={16} strokeWidth={1.65} aria-hidden="true"/>
  </span>
 </label>;
}

function ExportThumbnail({project,side,view,background}:{project:Project;side:SideName;view?:StillView;background:string}){
 const [url,setUrl]=useState('');
 const [failed,setFailed]=useState(false);
 const label=physicalCardFace(project,side)==='front'?'正面':'背面';
 useEffect(()=>{
  let current=true;
  setFailed(false);setUrl('');
  const scale=252/Math.max(project.widthMm,project.heightMm);
  renderStill(project,side,{width:Math.max(1,Math.round(project.widthMm*scale)),
   height:Math.max(1,Math.round(project.heightMm*scale)),view,background,resampling:'high'})
   .then(canvas=>{if(current)setUrl(canvas.toDataURL())})
   .catch(()=>{if(current)setFailed(true)});
  return()=>{current=false};
 },[project,side,view,background]);
 return <figure>
  <figcaption>{label}</figcaption>
  {url?<img src={url} alt={label+'预览'} draggable={false}/>:<div className="export-thumbnail-placeholder" role="status">{failed?'预览加载失败':''}</div>}
 </figure>;
}

function ExportPanel({project,onClose,notify,open,onLocate,onProof,entry,stillView}:{
 project:Project;onClose:()=>void;notify:(message:string)=>void;open:boolean;
 onLocate:(target:PreflightTarget,settings:Pick<ProofSettings,'applyFactory'|'technical'|'dpi'|'vector'>)=>void;
 entry:'image'|'print';stillView?:StillView;onProof:(settings:Partial<ProofSettings>)=>void;
}){
 const [mode,setMode]=useState<ExportMode>('image');
 const [digitalDpi,setDigitalDpi]=useState<ExportDpi>(300),[dpi,setDpi]=useState<ExportDpi>(300);
 const [format,setFormat]=useState<'png'|'jpeg'>('png');
 const [resampling,setResampling]=useState<'high'|'medium'>('high');
 const [includeModel,setIncludeModel]=useState(false);
 const [modelShading,setModelShading]=useState<ModelShading>('unlit');
 const supportsPbr=supportsMaterialModel(project);
 const selectedModelShading=includeModel&&supportsPbr?modelShading:'unlit';
 const [imageFace,setImageFace]=useState<'both'|SideName>('both');
 const [frameView,setFrameView]=useState<'captured'|'flat'>('captured');
 const [pixelWidth,setPixelWidth]=useState<string|null>(null);
 const [backgroundMode,setBackgroundMode]=useState<'default'|'color'|'transparent'>('default');
 const [backgroundColor,setBackgroundColor]=useState('#ffffff');
 const [modelPreview,setModelPreview]=useState<ModelPreviewState>();
 const [profile,setProfile]=useState<PrintProfile|'factory'>('standard');
 const [exportError,setExportError]=useState<{request:ExportRequest;message:string}>();
 const [deliveryRecovery,setDeliveryRecovery]=useState<DeliveryRecovery>();
 const [artworkMode,setArtworkMode]=useState<'raster'|'vector'>('raster');
 const [service,setService]=useState<'checking'|'online'|'offline'|'outdated'>('checking'),[busy,setBusy]=useState(false);
 const [serviceCheck,setServiceCheck]=useState(0);
 const previewSide=stillView?.side==='back'&&project.singleSided?undefined:stillView?.side;
 const imageSides:SideName[]=project.singleSided?FRONT_ONLY:imageFace==='both'?BOTH_FACES:[imageFace];
 const chosenView=frameView==='captured'?stillView:undefined;
 useEffect(()=>{if(open){setImageFace(previewSide??(project.singleSided?'front':'both'));setFrameView('captured');setPixelWidth(null);setBackgroundMode('default');setModelShading('unlit');}},[open,previewSide,project.cardId,project.singleSided]);
 const factory=projectPrintProfile(project);
 const applyFactory=profile==='factory'&&Boolean(factory);
 const printSides=printSubmissionSides(project,applyFactory);
 const technicalProfile=profile==='factory'?'standard':profile;
 const raster=applyFactory&&isRasterProfile(project);
 const vector=!applyFactory&&artworkMode==='vector';
 const printDpi=applyFactory?factory!.dpi:dpi;
 const [checked,setChecked]=useState<{snapshot:Project;faces:SideName[];preset:PrintProfile;dpi:number;factory:boolean;vector:boolean;issues:PreflightIssue[];error?:string}>();
 const checkReady=checked?.snapshot===project&&checked.faces===printSides&&checked.preset===technicalProfile&&
  checked.dpi===printDpi&&checked.factory===applyFactory&&checked.vector===vector;
 const issues=checkReady&&checked?checked.issues:[];
 const abort=useRef<AbortController|null>(null);
 const previewRequest=useRef<AbortController|null>(null);
 const modalContent=useRef<HTMLDivElement>(null);
 const exportScroll=useRef<HTMLDivElement>(null);
 const exportBody=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  if(!open){
   previewRequest.current?.abort();
   setModelPreview(undefined);
   return;
  }
  setMode(entry);
  if(entry==='print'&&factory)setProfile('factory');
 },[open,entry,factory]);
 useLayoutEffect(()=>{
  const content=modalContent.current;
  const scroll=exportScroll.current;
  const body=exportBody.current;
  if(!open||!content||!scroll||!body)return;
  const fixedSections=Array.from(content.children).filter(section=>section!==scroll) as HTMLElement[];
  let targetHeight=0;
  const measure=()=>{
   const currentHeight=content.offsetHeight;
   if(!currentHeight)return;
   const height=fixedSections.reduce((sum,section)=>sum+section.offsetHeight,body.offsetHeight);
   if(height===targetHeight)return;
   targetHeight=height;
   content.dataset.resizeDirection=height>currentHeight?'expand':'collapse';
   content.style.setProperty('--export-content-height',`min(${height}px, var(--export-height-limit))`);
  };
  const observer=new ResizeObserver(measure);
  for(const section of [...fixedSections,body])observer.observe(section);
  measure();
  return()=>observer.disconnect();
 },[open]);
 useLayoutEffect(()=>{
  if(exportScroll.current)exportScroll.current.scrollTop=0;
 },[mode]);
 useEffect(()=>()=>{previewRequest.current?.abort();abort.current?.abort()},[]);
 useEffect(()=>{
  if(!open||mode!=='print'||raster)return;
  const c=new AbortController();
  setService('checking');
  const checkService=browserRuntime
   ? import('./browserPrint').then(({prepareBrowserPrint})=>prepareBrowserPrint(c.signal)).then(()=>'online' as const)
   : fetch('/api/health',{signal:c.signal}).then(async response=>{
    const status=response.ok?await response.json():null;
    return status?.productionOrder?'online' as const:status?'outdated' as const:'offline' as const;
   });
  checkService.then(status=>{if(!c.signal.aborted)setService(status)})
   .catch(()=>{if(!c.signal.aborted)setService('offline')});
  return()=>c.abort();
 },[open,mode,serviceCheck,raster]);
 useEffect(()=>{
  if(!open||mode!=='print')return;
  const controller=new AbortController();
  const inputs={snapshot:project,faces:printSides,preset:technicalProfile,dpi:printDpi,factory:applyFactory,vector};
  printPreflight(project,printSides,technicalProfile,printDpi,controller.signal,applyFactory,vector)
   .then(issues=>{if(!controller.signal.aborted)setChecked({...inputs,issues});})
   .catch(()=>{if(!controller.signal.aborted)setChecked({...inputs,issues:[],error:'无法完成预检，请重试'});});
  return()=>controller.abort();
 },[open,mode,project,printSides,technicalProfile,printDpi,applyFactory,vector,serviceCheck]);
 const run=async(frozenRequest:ExportRequest)=>{
  if(abort.current)return;
  const controller=new AbortController();abort.current=controller;setBusy(true);
  setExportError(undefined);
  const check=()=>controller.signal.throwIfAborted();
  let request=frozenRequest;
  const sourceDocument=request.project,outputFaces=request.sides.map(slot=>physicalCardFace(sourceDocument,slot));
  const exportName=request.mode==='project'||!request.project.additionalCards?.length?request.project.name:request.project.name+'-'+request.project.cardName;
  const stem=exportName.replace(/[\\/:*?"<>|]/g,'_')||'卡牌';
  try {
   let file:Blob,name:string;
   if(request.mode!=='project')await ensureProjectFonts(request.project);
   check();
   if(request.mode==='project'){
    file=await buildProjectArchive(request.project);
    name=`${stem}.cardproj`;
   } else if(request.mode==='image'){
    const modelSides=request.project.singleSided?FRONT_ONLY:BOTH_FACES;
    const fonts=await projectFontProblems(request.project,request.includeModel?modelSides:request.sides,true);
    if(fonts.length)throw Error(fonts.map(({node,message})=>`「${node.name}」${message}`).join('；'));
    const zip=new JSZip();
    const extension=request.format==='jpeg'?'jpg':'png';
    let imageFile:Blob|null=null;
    for(const face of request.sides){
     const canvas=await renderStill(request.project,face,{width:request.imageWidth,height:request.imageHeight,
      view:request.view?.side===face?request.view:undefined,background:request.imageBackground,resampling:request.resampling});
     check();
     imageFile=await encodeDigitalImage(canvas,request.format,request.dpi);
     zip.file(`${physicalCardFace(request.project,face)}.${extension}`,imageFile);
    }
    if(request.includeModel){
     const {buildCardModel}=await import('./cardModelExport');
     check();
     const model=await buildCardModel(projectForFaceOutput(request.project),{
      resampling:request.resampling,signal:controller.signal,shading:request.modelShading});
     zip.file(`${stem}.glb`,model);
    }
    check();
    const singleImage=request.sides.length===1&&!request.includeModel;
    file=singleImage?imageFile!:await zip.generateAsync({type:'blob'});
    name=singleImage?`${stem}-v${request.project.version}-${physicalCardFace(request.project,request.sides[0])}.${extension}`:`${stem}-v${request.project.version}-数字卡图.zip`;
   } else if(request.applyFactory&&isRasterProfile(request.project)){
    file=await exportFactoryRaster(request.project,request.sides,controller.signal,request.issues,false);
    name=`${stem}-v${request.project.version}-厂规打样图片.zip`;
   } else {
    if(request.project.looseFace==='back'){
     request={...request,sides:request.sides.map(slot=>physicalCardFace(request.project,slot)),project:projectForFaceOutput(request.project)};
    }
    const outputProfile=request.applyFactory?projectPrintProfile(request.project):undefined;
    const pages=[];
    for(const face of request.sides){
     const options={scale:request.dpi/254,bleed:true,productionOnly:true};
     const printProject={...request.project,[face]:{...request.project[face],effects:[]}};
     const artwork=orientPrintCanvas(await renderCard(printProject,face,{...options,effects:false,material:false}),face,outputProfile).toDataURL('image/png');
     const vector=request.vector?await buildVectorArtwork(printProject,face,request.dpi,controller.signal):undefined;
     const layers=[];
     for(const channel of PRINT_CHANNELS){
      for(const entry of request.project[face].effects.filter(effect=>effectInProduction(effect)&&plateFor(effect)===channel)){
       check();
       const mask=orientPrintCanvas(await renderCard(request.project,face,{...options,plate:channel,layerId:entry.id}),face,outputProfile).toDataURL('image/png');
       const contours=request.vector && (face==='front' || !outputProfile || outputProfile.backOrientation==='normal')
        ? vectorPlateContours(request.project,face,entry) : undefined;
       layers.push({id:entry.id,name:entry.name,channel,variant:entry.type,regionId:entry.regionId,mask,contours});
      }
     }
     pages.push({side:face,artwork,layers,vector});check();
    }
    const {id,name:projectName,version,widthMm,heightMm,bleedMm,material}=request.project;
    const production=request.project.production;
    const job={...production,printProfile:request.applyFactory?production?.printProfile:undefined,
     dieShape:production?.dieShape??'card',cornerRadiusMm:getCardCornerRadiusMm(request.project),
     flashTreatment:reflectionCount(request.project,request.sides)?'preview':'unused',
     steps:factoryProductionOrder(request.project,request.sides,outputProfile).steps};
    const payload={project:{id,name:projectName,version,widthMm,heightMm,bleedMm,
     material:MATERIALS.find(m=>m.id===material)?.name||material,stockReflection:getStockReflection(request.project,request.sides[0]),
     cardId:request.project.cardId,stockSpec:effectiveStockSpec(request.project),faceFinishes:stockDelivery(request.project,request.sides)},
     profile:request.profile,pages,production:job,preflight:request.issues.map(({text,blocking})=>({text,blocking}))};
    if(browserRuntime){
     const {exportBrowserPrint}=await import('./browserPrint');
     file=await exportBrowserPrint(payload,controller.signal);
    }else{
     const response=await fetch('/api/export',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
     if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'本机印前服务暂不可用，请启动服务后重试')}
     file=await response.blob();
    }
    name=`${stem}-v${request.project.version}-${request.vector?'基础矢量彩稿':'技术打样'}.zip`;
   }
   check();
   let recovery:DeliveryRecovery|undefined;
   if(request.mode!=='project'){
    let source:Blob|undefined;
    try {
     source=await buildProjectArchive(sourceDocument);
     check();
     await saveDelivery(sourceDocument,{mode:request.mode,faces:outputFaces,
      profile:request.mode==='print'?(request.applyFactory?[projectPrintProfile(request.project)?.product,projectPrintProfile(request.project)?.version].filter(Boolean).join(' ')||'factory':request.profile):'sRGB',
      dpi:request.dpi,output:name},file,source);
    } catch {
     check();
     recovery={project:sourceDocument,source,name:`${stem}-v${sourceDocument.version}-交付源稿.cardproj`};
    }
   }
   check();
   downloadBlob(file,name);
   if(recovery)setDeliveryRecovery(recovery);
   const label=request.mode==='print'?'印刷文件包':request.mode==='image'?'数字卡图':'项目包';
   notify(`${label}已下载${recovery?'，交付版本保存失败':''}`);
  } catch(error){
   if(!controller.signal.aborted){
    const message=error instanceof Error?error.message:'导出失败';
    setExportError({request:frozenRequest,message});
    if(!modalContent.current)notify(message);
   }
  }
  finally{if(abort.current===controller){abort.current=null;setBusy(false)}}
 };
 const downloadSource=async()=>{
  if(abort.current||!deliveryRecovery)return;
  const recovery=deliveryRecovery;
  const controller=new AbortController();abort.current=controller;setBusy(true);
  try {
   const source=recovery.source??await buildProjectArchive(recovery.project);
   controller.signal.throwIfAborted();
   downloadBlob(source,recovery.name);
   setDeliveryRecovery(undefined);
   notify('交付源稿已下载');
  } catch(error){
   if(!controller.signal.aborted)setDeliveryRecovery({...recovery,error:error instanceof Error?error.message:'无法生成交付源稿'});
  } finally {
   if(abort.current===controller){abort.current=null;setBusy(false)}
  }
 };
 if(!open)return null;
 const defaultWidth=Math.round(project.widthMm*digitalDpi/25.4);
 const outputWidth=pixelWidth===null?defaultWidth:Number(pixelWidth);
 const outputHeight=pixelWidth===null?Math.round(project.heightMm*digitalDpi/25.4):Math.round(outputWidth*project.heightMm/project.widthMm);
 const validPixels=Number.isInteger(outputWidth)&&outputHeight>=1&&outputHeight<=8192&&outputWidth>=1&&outputWidth<=8192&&outputWidth*outputHeight<=32_000_000;
 const printPixels=(mm:number)=>Math.round((mm+project.bleedMm*2)*printDpi/25.4);
 const selectedGround=backgroundMode==='default'?(stillView?.background??'transparent'):backgroundMode==='color'?backgroundColor:'transparent';
 const background=format==='jpeg'&&selectedGround==='transparent'? '#ffffff':selectedGround;
 const openModelPreview=async()=>{
  if(previewRequest.current)return;
  const controller=new AbortController();
  previewRequest.current=controller;
  setModelPreview({status:'loading'});
  try{
   const {buildCardModel}=await import('./cardModelExport');
   await ensureProjectFonts(project);
   controller.signal.throwIfAborted();
   const fonts=await projectFontProblems(project,project.singleSided?FRONT_ONLY:BOTH_FACES,true);
   if(fonts.length)throw Error(fonts.map(({node,message})=>`「${node.name}」${message}`).join('；'));
   const file=await buildCardModel(projectForFaceOutput(project),{preview:true,resampling,signal:controller.signal,shading:selectedModelShading});
   if(!controller.signal.aborted)setModelPreview({status:'ready',file});
  }catch(error){
   if(!controller.signal.aborted)setModelPreview({status:'error',message:error instanceof Error?error.message:'无法打开 3D 模型'});
  }finally{
   if(previewRequest.current===controller)previewRequest.current=null;
  }
 };
 const closeModelPreview=()=>{
  previewRequest.current?.abort();
  previewRequest.current=null;
  setModelPreview(undefined);
 };
 const start=()=>{
  const request:ExportRequest={mode,project,sides:mode==='image'?imageSides:printSides,
   dpi:mode==='print'?printDpi:digitalDpi,format,profile:technicalProfile,applyFactory,vector,
   imageWidth:outputWidth,imageHeight:outputHeight,imageBackground:background,view:chosenView,resampling,includeModel,modelShading:selectedModelShading,issues};
  void run(structuredClone(request));
 };
 const retryExport=exportError?.request.mode===mode?exportError:undefined;
 const blockers=issues.filter(issue=>issue.blocking);
 const notes=issues.filter(issue=>!issue.blocking);
 const failedCheck=checkReady?checked?.error:undefined;
 const blocked=mode==='print'?((!raster&&service!=='online')||!checkReady||Boolean(failedCheck)||!!blockers.length):mode==='image'&&!validPixels;
 const modelPlaceholder=<div className="export-model-preview export-model-loading">
  <div className="export-model-viewport"><p className="export-model-status" role={modelPreview?.status==='error'?'alert':'status'}>
   {modelPreview?.status==='error'?modelPreview.message:'正在打开 3D 模型…'}
  </p></div>
 </div>;
 const colorProfile=<ExportSelect label="颜色描述文件" value="srgb"
  title={mode==='print'?'彩稿输入色彩空间':'图片色彩空间'}>
  <option value="srgb">sRGB</option>
 </ExportSelect>;
 const resolution=<ExportSelect label="分辨率" value={mode==='print'?printDpi:digitalDpi}
  disabled={mode==='print'&&applyFactory}
  onChange={value=>{if(mode==='print')setDpi(Number(value) as ExportDpi);else {setDigitalDpi(Number(value) as ExportDpi);setPixelWidth(null);}}}>
  {mode==='print'&&applyFactory?<option value={printDpi}>{printDpi} ppi</option>:<>
   <option value={300}>300 ppi</option><option value={600}>600 ppi</option>
  </>}
 </ExportSelect>;
 return <>
 <Modal title="导出" onClose={onClose} className="prism-export-modal" contentRef={modalContent}>
  <div className="prism-export-tab-bar">
   <div className="prism-export-tabs" role="group" aria-label="导出类型">
    {([['image','数字文件'],['print','印刷文件'],['project','项目导出']] as const).map(([id,label])=>
     <button type="button" key={id} aria-pressed={mode===id} onClick={()=>setMode(id)}>{label}</button>)}
   </div>
  </div>
  <div className="prism-export-scroll" ref={exportScroll}>
  <div className="prism-export-body" ref={exportBody}>
   {mode!=='project'&&<p className="member-active-name">{project.cardName??'卡牌 1'} · {(mode==='image'?imageSides:printSides).map(face=>physicalCardFace(project,face)==='front'?'正面':'背面').join('、')}</p>}
   {mode==='image'&&<>
    <div className="export-field-grid">
     <ExportSelect label="文件格式" value={format} onChange={value=>{
       setFormat(value as typeof format);
       if(value==='jpeg' && backgroundMode==='transparent')setBackgroundMode('default');
     }}>
      <option value="png">PNG</option><option value="jpeg">JPEG</option>
     </ExportSelect>
     {resolution}
     {colorProfile}
     <ExportSelect label="图片重采样" value={resampling} onChange={value=>setResampling(value as typeof resampling)}>
      <option value="high">精细</option><option value="medium">标准</option>
     </ExportSelect>
     <ExportSelect label="导出卡面" value={project.singleSided?'front':imageFace} onChange={v=>setImageFace(v as typeof imageFace)}>
      <option value="front">{physicalCardFace(project,'front')==='back'?'背面':'正面'}</option>{!project.singleSided&&<><option value="back">背面</option><option value="both">正背面</option></>}
     </ExportSelect>
     <ExportSelect label="背景" value={backgroundMode==='transparent'&&format==='jpeg'?'default':backgroundMode}
      onChange={v=>setBackgroundMode(v as typeof backgroundMode)}>
      <option value="default">{stillView?'跟随预览':format==='png'?'默认（透明）':'默认（白色）'}</option>
      {format==='png'&&<option value="transparent">透明</option>}<option value="color">纯色</option>
     </ExportSelect>
     {backgroundMode==='color'&&<label className="export-field"><span>背景颜色</span><input aria-label="背景颜色" type="color" value={backgroundColor} onChange={e=>setBackgroundColor(e.target.value)}/></label>}
     <div className="export-field-grid">
      <label className="export-field">
       <span>输出宽度 · px</span>
       <input className="export-pixel-input" type="number" min="1" max="8192" value={pixelWidth??defaultWidth} onChange={e=>setPixelWidth(e.target.value)}/>
      </label>
      <label className="export-field">
       <span>等比高度 · px</span>
       <input className="export-pixel-input" readOnly value={Number.isFinite(outputHeight)?outputHeight:''}/>
      </label>
     </div>
     {stillView&&<ExportSelect label="视角" value={frameView} onChange={v=>setFrameView(v as typeof frameView)}>
      <option value="captured">跟随预览</option><option value="flat">平视</option>
     </ExportSelect>}
    </div>
    <label className="export-model-choice">
     <input type="checkbox" checked={includeModel} onChange={event=>setIncludeModel(event.target.checked)}/>
     包含3D渲染文件
    </label>
    {includeModel&&<ExportSelect label="GLB 材质" value={selectedModelShading} disabled={!supportsPbr}
     title={supportsPbr?undefined:'增强材质支持透明 PET 加局部白墨，或纸卡加局部箔版'}
     onChange={value=>setModelShading(value as ModelShading)}>
     <option value="unlit">保色</option>{supportsPbr&&<option value="pbr">增强材质</option>}
    </ExportSelect>}
    <section className="export-preview" aria-label="预览">
     <h3>预览</h3>
     <div className="export-preview-stage">
      {imageSides.map(face=><ExportThumbnail key={face} project={project} side={face} view={chosenView?.side===face?chosenView:undefined} background={background}/>)}
      <button type="button" className="export-model-trigger" title="查看 3D" aria-label="查看 3D" aria-haspopup="dialog"
       onClick={()=>void openModelPreview()}><FigmaIcon name="export-model-preview"/></button>
     </div>
    </section>
    {!validPixels&&<p className="export-error" role="status">宽高须为 1–8192 px，总像素最多 3200 万。请调整输出宽度。</p>}
   </>}
   {mode==='print'&&<>
    <div className="export-field-grid">
     <ExportSelect label="彩稿输出" value={applyFactory?'factory':artworkMode} disabled={applyFactory}
      onChange={value=>setArtworkMode(value as typeof artworkMode)}>
      {applyFactory?<option value="factory">{raster?'厂规打样图片':'厂规打样包'}</option>:<>
       <option value="raster">栅格打样包</option><option value="vector">基础矢量彩稿</option>
      </>}
     </ExportSelect>
     {resolution}
     <ExportSelect label="输出配置" value={applyFactory?'factory':technicalProfile} onChange={value=>setProfile(value as typeof profile)}>
      <option value="standard">技术配置 A</option><option value="alternate">技术配置 B</option>
      {factory&&<option value="factory">{factory.product||'已保存的印厂配置'}</option>}
     </ExportSelect>
     {colorProfile}
    </div>
    <p className="export-print-size">每面 {printPixels(project.widthMm)} × {printPixels(project.heightMm)} px · 含出血</p>
    <section className="export-preflight" aria-label="印前检查">
     <div className="section-heading"><h3>印前检查</h3><Button onClick={()=>onProof({technical:technicalProfile,applyFactory,vector,dpi:printDpi})}>分版核稿</Button></div>
     {failedCheck?<p role="status">{failedCheck} <button type="button" onClick={()=>setServiceCheck(n=>n+1)}>重试</button></p>
      :!checkReady?<p role="status">正在预检</p>
      :<p role="status">{blockers.length} 项需修正 · {notes.length} 项提醒</p>}
     {issues.length>0&&<ul>
      {[...blockers,...notes].map((issue,index)=><li key={index}>
       <button type="button" className={issue.blocking?'export-error':''} onClick={()=>onLocate(issue.target,{applyFactory,technical:technicalProfile,dpi:printDpi,vector})}>{issue.text}</button>
      </li>)}
     </ul>}
     {!raster&&service!=='online'&&<p role="status" className="export-service-status">
      {service==='checking'?'正在准备印前服务':service==='outdated'?'印前服务需要更新':'印前服务暂不可用'}
      {service!=='checking'&&<button type="button" onClick={()=>setServiceCheck(n=>n+1)}>重试</button>}
     </p>}
    </section>
   </>}
   {mode==='project'&&<section className="export-project-files" aria-label="文件内容">
    <h3>文件内容</h3>
    <strong>{project.name} · {1+(project.additionalCards?.length??0)} 张卡</strong>
    <ul><li>可编辑项目文档</li><li>图层素材与区域</li><li>校验清单</li></ul>
   </section>}
  </div>
  </div>
  <div className="prism-export-footer">
  {retryExport&&<div className="export-recovery">
   <p className="export-error" role="alert">{retryExport.message}</p>
   <Button disabled={busy} onClick={()=>void run(retryExport.request)}>重试本次导出</Button>
  </div>}
  {deliveryRecovery&&<div className="export-recovery">
   <div><p role="status">文件已下载，交付版本保存失败</p>
    {deliveryRecovery.error&&<p className="export-error" role="alert">{deliveryRecovery.error}</p>}</div>
   <Button disabled={busy} onClick={()=>void downloadSource()}>下载本次源稿</Button>
  </div>}
  <div className="modal-footer">
   <Button onClick={onClose}>取消</Button><Button className="primary" disabled={busy||blocked} onClick={start}>{busy?'导出中…':'导出'}</Button>
  </div>
  </div>
 </Modal>
 {modelPreview&&<Modal title="3D 预览" wide className="export-model-preview-modal" onClose={closeModelPreview}>
  {modelPreview.status==='ready'
   ?<Suspense fallback={modelPlaceholder}><ExportModelPreview model={modelPreview.file}/></Suspense>
   :modelPlaceholder}
 </Modal>}
 </>;
}
