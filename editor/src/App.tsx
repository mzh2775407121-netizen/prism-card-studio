import { isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactElement, type ReactNode } from 'react';
import { Layers3, ChevronRight, Plus, ImagePlus, Type, Square, Circle, Hand, Paintbrush, Eraser, Undo2, EyeOff, Lock, Copy, Trash2, Download, Upload, X, Check, ArrowUpRight, SlidersHorizontal, ScanLine, Settings2, AlertTriangle, CheckCircle2, Loader2, Save, Pentagon } from 'lucide-react';
import JSZip from 'jszip';
import { HugeiconsIcon } from '@hugeicons/react';
import { ClipboardListIcon } from '@hugeicons/core-free-icons';
import EditorCanvas, { ZOOM_STEP, type CanvasNavigation, type CreatedVector, type EditorTool } from './EditorCanvas';
import { PrintGuideLegend, PrintCornerPreview, getPrintSafeMarginMm } from './PrintGuides';
import CropEditor from './CropEditor';
import { StockPicker, StockFinishControls, StockFinishMatchForm, LayerMaskField, LayerTypeField, MaskContentEditor, imageMaskNode, type MaskShape } from './ProductionControls';
import { STOCKS, changeStockSpec, effectiveStockSpec, resetStockFinishMatch, stockPreset, stockKeys, stockDelivery } from './stockMaterials';
import { LAYER_KINDS, classifyLayer, createArtwork, makeProcess, type LayerKind } from './layers';
import { LayerAppearanceEditor, LayerGeometry, StyleAction, StyleSection } from './LayerStylePanel';
import InspectorMenu from './InspectorMenu';
import LayerTypography from './LayerTypography';
import { activeImageFill, copyAppearance, pasteAppearance, type LayerAppearance } from './layerAppearance';
import AlbumPreview from './AlbumPreview';
import { renderStill, type StillView } from './stillExport';
import ProductionPlanEditor from './ProductionPlanEditor';
import { PlateProof } from './PlateProof';
import { AutoLayoutProperties, LayoutItemProperties } from './AutoLayoutProperties';
import { applyAutoLayout, createAutoLayout, layoutParent, scaleAutoLayout, setAutoLayout } from './autoLayout';
import ProjectWorkbench from './ProjectWorkbench';
import { DIE_SHAPES, PLATE_LABELS, productionSteps, reflectionCount, type ProductionStep } from './production';
import { isRasterProfile, printSpotNames, profileOutputScope, projectPrintProfile, type TechnicalPrintProfile } from './printProfiles';
import { exportFactoryRaster, orientPrintCanvas, printPreflight, type PreflightIssue, type PreflightTarget } from './printPreflight';
import { PRINT_CHANNELS } from './model';
import { createProject, copyProject, uid, TEMPLATE_NAMES, MAX_PROJECT_NOTE_LENGTH, PROCESS_LABELS, STOCK_REFLECTIONS, FLASH_STYLES, getFlashStyle, getStockReflection, getStockFinish, getCardCornerRadiusMm, plateFor, processKind, effectInProduction, type Project, type SideName, type CardSide, type CardNode, type Region, type Effect, type ProcessKind, type EffectType, type ImageCrop, type StockSpec, type StockFinish, type FlashStyle } from './model';
import { renderCard } from './render';
import { buildProjectArchive, exportProject, importProject, downloadBlob, readImage } from './io';
import { archiveProject, createStoredProject, listProjects, openLibrary, ProjectRequestError, readProject, type ProjectSummary, type StoredProject } from './projects';
import { useProjectSave } from './useProjectSave';
import { LayerContextMenu, type LayerCommand, type MenuPoint } from "./LayerContextMenu";
import { pasteLayerSelection, moveArtworkGroup, transferArtwork, transferGroup, transferProcess } from './transferLayer';
import { buildLayerTree, findLayerGroup, groupLayers, layerGroupAncestors, layerGroupMembers, pruneLayerGroups, renameLayerGroup, reorderLayerUnits, ungroupLayer, type LayerTreeItem, type LayerUnitRef as LayerUnit } from './layerGroups';
import FigmaIcon from './FigmaIcon';
import { browserRuntime } from './runtime';
import './project-library.css';

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
 empty:'layer-default',image:'layer-default',text:'tool-text',rect:'tool-rectangle',
 polygon:'layer-polygon',line:'tool-line',path:'tool-pen',
} as const;
const processName=(effect:Effect)=>PROCESS_LABELS[processKind(effect)];
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
function CanvasToolMenu({title,children}: {title:string;children:ReactNode}) {
 const menu=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{
  const close=(event:PointerEvent)=>{if(menu.current?.open&&event.target instanceof Node&&!menu.current.contains(event.target))menu.current.open=false};
  document.addEventListener('pointerdown',close);
  return()=>document.removeEventListener('pointerdown',close);
 },[]);
 return <details className="canvas-tool-menu" ref={menu}
  onKeyDown={event=>{if(event.key==='Escape'&&event.currentTarget.open){event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus()}}}>
  <summary className="canvas-tool-chevron" title={title} aria-label={title}><FigmaIcon name="tool-chevron" className="figma-rotate-90"/></summary>
  <div className="canvas-tool-options" onClick={event=>{if(event.target instanceof Element&&event.target.closest('button')&&menu.current)menu.current.open=false}}>{children}</div>
 </details>
}
function Modal({title,children,onClose,wide=false,drawer=false,className='',closeDisabled=false}:{
 title:string;children:ReactNode;onClose:()=>void;wide?:boolean;drawer?:boolean;className?:string;closeDisabled?:boolean
}) {
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  const dialog=ref.current!;
  const trigger=document.activeElement;
  dialog.showModal();
  const overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  return ()=>{
   dialog.close();
   document.body.style.overflow=overflow;
   if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus({preventScroll:true});
  };
 },[]);
 return <dialog ref={ref} className={`modal ${wide?'wide':''} ${drawer?'drawer':''} ${className}`} aria-label={title}
   onCancel={event=>{event.preventDefault();onClose()}}
   onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div className="modal-content">
   <div className="modal-head"><h2>{title}</h2><IconButton icon={X} title="关闭" onClick={onClose} disabled={closeDisabled}/></div>
   {children}
  </div>
 </dialog>;
}
function CardThumb({project,side='front',effects=true}:{project:Project,side?:SideName,effects?:boolean}){const [url,setUrl]=useState('');useEffect(()=>{let valid=true;renderCard(project,side,{scale:.35,effects}).then(c=>{if(valid)setUrl(c.toDataURL())}).catch(()=>{});return()=>{valid=false}},[project,side,effects]);return url?<img src={url} alt={`${project.name}${side==='front'?'正面':'背面'}`} draggable={false}/>:<div className="thumb-loading"/>}
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

function readRecentProjects(): string[] {
 try {
  const values: unknown = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) || '[]');
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string'))].slice(0, RECENT_PROJECTS_LIMIT) : [];
 } catch { return []; }
}

export default function App() {
 const [items,setItems]=useState<ProjectSummary[]>([]);
 const [recentIds,setRecentIds]=useState(readRecentProjects);
 const [entry,setEntry]=useState<{record:StoredProject;key:string;preview:boolean}|null>(null);
 const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 const [notice,setNotice]=useState('');
 const [failure,setFailure]=useState('');
 const [filter,setFilter]=useState<'active'|'archived'>('active');
 const [newOpen,setNewOpen]=useState(false);
 const [operation,setOperation]=useState('');
 const [archiveTarget,setArchiveTarget]=useState<ProjectSummary|null>(null);
 const fileInput=useRef<HTMLInputElement>(null);
 const workbench=useRef<HTMLDivElement>(null);
 const returnScroll=useRef<number|null>(null);
 const recentMemory=useRef(recentIds);
 const opening=useRef(false);

 const enter=useCallback((record:StoredProject,preview=false)=>{
  if(record.archivedAt!==null)throw new Error('此卡牌已归档，恢复后即可编辑。');
  if(workbench.current)returnScroll.current=window.scrollY;
  const params=new URLSearchParams({project:record.id});
  if(preview)params.set('preview','1');
  window.history.replaceState(null,'','?'+params);
  setEntry({record,key:uid(),preview});
  const recent = [...new Set([record.id,...readRecentProjects(),...recentMemory.current])].slice(0,RECENT_PROJECTS_LIMIT);
  recentMemory.current=recent;
  setRecentIds(recent);
  try { localStorage.setItem(RECENT_PROJECTS_KEY,JSON.stringify(recent)); } catch { /* Keep the workbench usable without storage access. */ }
 },[]);

 useEffect(()=>{
  let active=true;
  const params=new URLSearchParams(location.search);
  const id=params.get('project');
  const preview=params.has('preview');
  openLibrary().then(async({items:loaded,notice:migrationNotice})=>{
   if(!active)return;
   setItems(loaded);setNotice(migrationNotice);
   const target=id||(preview?loaded.find(item=>item.archivedAt===null)?.id:null);
   if(target){
    try {
     const record=await readProject(target);
     if(active)enter(record,preview);
    } catch(error) {
     if(active)setFailure((error as Error).message);
    }
   }
   if(active)setStatus('ready');
  }).catch(error=>{if(active){setFailure((error as Error).message);setStatus('error')}});
  return()=>{active=false};
 },[enter]);

 const refresh=async()=>{
  setStatus('loading');setFailure('');
  try {
   const result=await openLibrary();
   setItems(result.items);setNotice(result.notice);setStatus('ready');
  } catch(error) {
   setFailure((error as Error).message);setStatus('error');
  }
 };
 const backToLibrary=()=>{
  window.history.replaceState(null,'',location.pathname);
  setEntry(null);setFailure('');
  void refresh();
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
 const perform=async(label:string,action:()=>Promise<void>)=>{
  if(opening.current)return;
  opening.current=true;setOperation(label);setFailure('');
  try {await action()}
  catch(error){setFailure((error as Error).message)}
  finally{opening.current=false;setOperation('')}
 };
 const open=(item:ProjectSummary)=>void perform('正在打开项目…',async()=>enter(await readProject(item.id)));
 const importFile=(file:File)=>void perform('正在读取项目包…',async()=>{
  const project=await importProject(file);
  enter(await createStoredProject(copyProject(project)));
 });
 const duplicate=(item:ProjectSummary)=>void perform('正在复制项目…',async()=>{
  const {project}=await readProject(item.id);
  enter(await createStoredProject(copyProject(project,project.name.slice(0,494)+' 副本',1)));
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
 if(entry)return <Editor key={entry.key} record={entry.record} initialPreview={entry.preview}
  onBack={backToLibrary} onOpen={enter}/>;

 const filtered=items.filter(item=>(item.archivedAt!==null)===(filter==='archived'));
 return <div className="project-library" ref={workbench}>
  <input ref={fileInput} type="file" accept=".cardproj" hidden onChange={event=>{
   const file=event.target.files?.[0];event.target.value='';if(file)importFile(file);
  }}/>
  <ProjectWorkbench items={filtered} recent={[...filtered].sort((a,b)=>{
    const ar=recentIds.indexOf(a.id),br=recentIds.indexOf(b.id);
    return (ar<0?Infinity:ar)-(br<0?Infinity:br)||b.updatedAt-a.updatedAt;
   }).slice(0,4)}
   archived={filter==='archived'} ready={status==='ready'} offline={status==='error'}
   busy={!!operation} message={failure||operation||notice} error={!!failure}
   onToggleArchived={()=>setFilter(value=>value==='active'?'archived':'active')}
   onRefresh={()=>void refresh()} onImport={()=>fileInput.current?.click()}
   onCreate={()=>{setFailure('');setNewOpen(true)}} onOpen={open}
   onArchive={setArchiveTarget} onRestore={item=>changeArchived(item,false)} onDuplicate={duplicate}
   onExport={item=>void perform('正在打包项目…',async()=>{const {project}=await readProject(item.id);await exportProject(project)})}/>
  {newOpen&&<NewProject pending={operation!==''} error={failure} onClose={()=>{if(!operation){setFailure('');setNewOpen(false)}}} onCreate={project=>void perform('正在创建项目…',async()=>{
   const record=await createStoredProject(project);setNewOpen(false);enter(record);
  })}/>}
  {archiveTarget&&<Modal title="归档卡牌" onClose={()=>{if(!operation)setArchiveTarget(null)}}>
   <div className="new-content"><p className="library-dialog-copy">「{archiveTarget.name}」会移到「已归档」，可随时恢复。</p>{failure&&<p className="library-error" role="alert">{failure}</p>}</div>
   <div className="modal-footer"><Button disabled={!!operation} onClick={()=>setArchiveTarget(null)}>取消</Button><Button className="primary" disabled={!!operation} onClick={()=>changeArchived(archiveTarget,true)}>归档卡牌</Button></div>
  </Modal>}
 </div>;
}

function Editor({record,initialPreview,onBack,onOpen}:{record:StoredProject;initialPreview:boolean;onBack:()=>void;onOpen:(record:StoredProject)=>void}) {
 const [project,setProject]=useState(record.project);
 const [selectedSide,setSide]=useState<SideName>('front'),[selectedId,setSelected]=useState<string|null>(null);
 const side=project.singleSided?'front':selectedSide;
 const [inspectorTab,setInspectorTab]=useState<'design'|'properties'>('design');
 const [processView,setProcessView]=useState<ProcessView>('all');
 const [tool,setTool]=useState<EditorTool>('select');
 const navigationRef=useRef<CanvasNavigation>(null);
 const [spaceHeld,setSpaceHeld]=useState(false);
 const [layerSelection,setLayerSelection]=useState<LayerUnit[]>([]);
 const [textEdit,setTextEdit]=useState<{face:SideName;id:string}>();
 const [closedGroups,setClosedGroups]=useState<Set<string>>(()=>new Set());
 const [showLayerMask,setShowLayerMask]=useState(false);
 const [gradientEditing,setGradientEditing]=useState<string|null>(null);
 const [appearanceClipboard,setAppearanceClipboard]=useState<LayerAppearance|null>(null);
 const [layerPlate,setLayerPlate]=useState<string>();
 const [replaceCrop,setReplaceCrop]=useState(true);
 const [layerQuery,setLayerQuery]=useState('');
 const [layerSearchOpen,setLayerSearchOpen]=useState(false);
 const layerSearchInput=useRef<HTMLInputElement>(null);
 const [regionDraft,setRegionDraft]=useState<Region|null>(null),[brushSize,setBrushSize]=useState(32);
 const [modal,setModal]=useState<'rename'|'preview'|'size'|'export'|'crop'|'maskContent'|'maskUnion'|'production'|'plateProof'|'stockMatch'|null>(initialPreview?'preview':null);
 const [productionTab,setProductionTab]=useState<'spec'|'order'>('spec'),[printEntry,setPrintEntry]=useState(0);
 const [stillView,setStillView]=useState<StillView>();
 const [proofFactory,setProofFactory]=useState(false);
 const [stockChange,setStockChange]=useState<{material:string;stockSpec:StockSpec}>();
 const [returnToPlan,setReturnToPlan]=useState(false);
 const [toast,setToast]=useState('');
 const [leaving,setLeaving]=useState(false);
 const [readingImages,setReadingImages]=useState(0);
 const [imageIssue,setImageIssue]=useState<{message:string;replacement:string|null}|null>(null);
 const [dragged,setDragged]=useState<string|null>(null);
 const [dropAt,setDropAt]=useState<{id:string;placement:'before'|'after'}|null>(null);
 const sidebarDrag=useRef<(LayerUnit&{face:SideName;locked?:boolean})|null>(null);
 const [sidebarDropFace,setSidebarDropFace]=useState<SideName>();
 const [collapsedLeft,setCollapsedLeft]=useState(false),[collapsedRight,setCollapsedRight]=useState(false);
 const [confirmDelete,setConfirmDelete]=useState<CardNode|null>(null);
 const history=useRef<Project[]>([]),future=useRef<Project[]>([]),current=useRef(project);
 const fileInput=useRef<HTMLInputElement>(null),replaceId=useRef<string|null>(null);
 const whiteInput=useRef<HTMLInputElement>(null);
 const whiteUploadTarget=useRef<{id:string;face:SideName}|null>(null);
 const layerList=useRef<HTMLDivElement>(null);
 const {state:save,queueSave,saveNow}=useProjectSave(record,current);
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
 const rightTab=designLayer?'design':effect?'effects':selected?'layerProperties':selectedGroup?'group':selectedCount?'multi':'material';
 const cropFill=modal==='crop'&&selected?activeImageFill(selected):undefined;
 const targetRegion=active.regions.find(r=>r.id===(effect?.regionId||selected?.clipRegionId));
 const maskRegions=active.regions.filter(region=>!selected||region.nodeId!==selected.id);
 const maskHighlight=showLayerMask&&!!targetRegion&&!regionDraft;
 const isolatedPlate=effect&&layerPlate===effect.id?plateFor(effect):undefined;
 const plate=regionDraft||maskHighlight?null:isolatedPlate??PROCESS_VIEWS.find(view=>view.id===processView)?.plate??null;
 const flashOnly=processView==='reflection'&&!regionDraft&&!maskHighlight;
 const hasModeNotice=Boolean(regionDraft||plate||flashOnly||maskHighlight);
 const query=layerQuery.trim().toLocaleLowerCase();
 const matchesQuery=(item:{name:string;groupId?:string})=>!query||item.name.toLocaleLowerCase().includes(query)
  ||layerGroupAncestors(active,item.groupId).some(group=>group.name.toLocaleLowerCase().includes(query));
 const groupTree=buildLayerTree(active,{
  artwork:processView==='all'?(node:CardNode)=>node.type!=='empty'&&matchesQuery(node):false,
  process:(item:Effect)=>(processView==='all'||processKind(item)===processView)&&matchesQuery(item),
 });
 const revealLayer=(face:CardSide,id:string)=>{
  const groupId=face.nodes.find(node=>node.id===id)?.groupId??face.effects.find(item=>item.id===id)?.groupId;
  if(!groupId)return;
  const ancestors=layerGroupAncestors(face,groupId);
  if(ancestors.length)setClosedGroups(previous=>{
   const keys=ancestors.flatMap(group=>[group.id,processView+':'+group.id]);
   if(!keys.some(key=>previous.has(key)))return previous;
   const next=new Set(previous);keys.forEach(key=>next.delete(key));return next;
  });
 };
 const selectLayer=(id:string|null, kind?:LayerKind)=>{
  setSelected(id);setTextEdit(undefined);setShowLayerMask(false);setLayerSelection([]);setLayerPlate(undefined);
  if(id!==selectedId)setGradientEditing(null);
  if(id){
   setCollapsedRight(false);
   if(processView!=='all'&&kind!==processView)setProcessView('all');
   const item=active.nodes.find(node=>node.id===id)??active.effects.find(entry=>entry.id===id);
   if(query&&(!item||!matchesQuery(item)))setLayerQuery('');
   revealLayer(active,id);
  }
 };
 const changeProcessView=(view:ProcessView)=>{
  setProcessView(view);setLayerPlate(undefined);setShowLayerMask(false);
  setTool('select');
  if(view!=='all'){
   setCollapsedRight(false);
   if(!effect||processKind(effect)!==view)selectLayer(null);
  }
 };
 const activateCanvasTool=(next:EditorTool)=>{
  if(next==='line'||next==='pen'){
   setProcessView('all');setLayerPlate(undefined);setShowLayerMask(false);
  }
  setTool(next);
 };
 useEffect(()=>{
  const id=selectedGroup?.id??selectedId;
  if(!id)return;
  const attribute=selectedGroup?'data-layer-group-id':'data-layer-id';
  layerList.current?.querySelector(`[${attribute}="${CSS.escape(id)}"]`)?.scrollIntoView({block:'nearest'});
 },[side,selectedId,selectedGroup?.id,processView,effect?processKind(effect):undefined]);
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
  const prepare=(face:SideName)=>next[face]===current.current[face]?next[face]:applyAutoLayout(pruneLayerGroups(next[face]));
  const updated={...next,front:prepare('front'),back:prepare('back'),version:current.current.version+1,updatedAt:now};
  current.current=updated;
  setProject(updated);
  queueSave();
 },[queueSave]);
 const changeCanvasSide=useCallback((next:CardSide,face:SideName)=>commit({...current.current,[face]:next}),[commit]);
 const changeSide=useCallback((next:CardSide)=>changeCanvasSide(next,side),[changeCanvasSide,side]);
 const changeBase=(material:string,stockSpec:StockSpec)=>{
  const doc=current.current;
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
  commit({...doc,[side]:{...doc[side],stockFinish:finish}},continuous?'stock-opacity-'+side:undefined,continuous);
 };
 const patchNode=(patch:Partial<CardNode>,continuous=false)=>{
  if(!selectedId)return;
  const doc=current.current;
  const face=doc[side];
  const node=face.nodes.find(item=>item.id===selectedId);
  const keys=Object.keys(patch) as (keyof CardNode)[];
  if(!node||node.locked||keys.every(key=>node[key]===patch[key]))return;
  commit({...doc,[side]:{...face,nodes:face.nodes.map(n=>n.id===selectedId?{...n,...patch}:n)}},selectedId+keys.join(),continuous);
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
  startStyleEdit();patchStyle(pasteAppearance(selected,appearanceClipboard));notify('已粘贴图层样式');
 };
 const toggleGradient=()=>{
  if(!selected?.gradient||selected.locked)return;
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
 const restoreHistory=(snapshot:Project)=>{
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
 const deleteNode=(node:CardNode,removeEffects:boolean)=>{const removed=new Set(active.regions.filter(r=>r.nodeId===node.id).map(r=>r.id));for(const r of active.regions)if(r.sources?.some(id=>removed.has(id)))removed.add(r.id);changeSide({...active,nodes:active.nodes.filter(n=>n.id!==node.id),regions:removeEffects?active.regions.filter(r=>!removed.has(r.id)):active.regions.map(r=>r.nodeId===node.id?{...r,binding:'fixed',nodeId:undefined,snapshot:structuredClone(r.snapshot||node),bounds:r.bounds}:r),effects:removeEffects?active.effects.filter(e=>!removed.has(e.regionId)):active.effects});setSelected(null);setConfirmDelete(null)};
 const requestDelete=()=>{
  if(effect){
   changeSide({...active,effects:active.effects.filter(item=>item.id!==effect.id)});
   selectLayer(null);setLayerPlate(undefined);return;
  }
  if(!selected||selected.locked)return;
  if(active.regions.some(r=>r.nodeId===selected.id))setConfirmDelete(selected);else deleteNode(selected,true);
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
 const [menu,setMenu]=useState<{screen:MenuPoint;point?:MenuPoint}>();
 const closeMenu=useCallback(()=>setMenu(undefined),[]);
 const [copied,setCopied]=useState<{origin:CardSide;units:LayerUnit[]}>();
 const selectedNodes=active.nodes.filter(node=>selectedArtworkIds.includes(node.id));
 const artworkOnly=selectedNodes.length>0&&selectedNodes.length===selectedCount;
 const editableArtwork=artworkOnly&&selectedNodes.every(node=>!node.locked);
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
 const copySelection=()=>setCopied({origin:active,units:selectionUnits.map(({kind,id})=>({kind,id}))});
 const pasteSelection=(replace:boolean)=>{
  if(!copied)return;
  const effectIds=[...new Set([...selectionParts.effectIds,...groupMembers.flatMap(group=>group.effectIds)])];
  const target=replace?{artworkIds:selectedArtworkIds,effectIds,parentId:selected?.groupId??effect?.groupId??selectedGroup?.parentId}:undefined;
  const anchors=[...selectedNodes,...active.effects.filter(entry=>effectIds.includes(entry.id)).map(entry=>{
   const region=active.regions.find(item=>item.id===entry.regionId);
   return region?.bounds??active.nodes.find(node=>node.id===region?.nodeId)??{x:0,y:0};
  })];
  const point=replace?{x:Math.min(...anchors.map(node=>node.x)),y:Math.min(...anchors.map(node=>node.y))}:menu?.point??{x:(selected?.x??0)+15,y:(selected?.y??0)+15};
  const pasted=pasteLayerSelection(project,copied.origin,active,copied.units,point,target);
  changeSide(pasted.side);selectUnits(pasted.units,side);
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
 const commands:LayerCommand[]=[
  {label:'复制',shortcut:cmd+' C',enabled:!!selectedCount,run:copySelection},
  {label:'粘贴到这里',enabled:!!copied,run:()=>pasteSelection(false)},
  {label:'粘贴替换',shortcut:'⇧ '+cmd+' R',enabled:!!copied&&!!selectedCount&&selectedNodes.every(node=>!node.locked),run:()=>pasteSelection(true)},
  {label:'编组所选图层',shortcut:cmd+' G',enabled:selectionUnits.length>=2,run:formLayerGroup},
  {label:'设为蒙版',shortcut:mac?'⌃ ⌘ M':'Ctrl Alt M',enabled:editableArtwork,run:makeSelectionMask},
  {label:'锁定/解锁',shortcut:'⇧ '+cmd+' L',enabled:artworkOnly,run:()=>{
   const lock=selectedNodes.some(node=>!node.locked);
   changeSide({...active,nodes:active.nodes.map(node=>selectedArtworkIds.includes(node.id)?{...node,locked:lock}:node)});
  }},
  {label:'水平翻转',shortcut:'⇧ H',enabled:editableArtwork,run:()=>flipSelection('flipX')},
  {label:'垂直翻转',shortcut:'⇧ V',enabled:editableArtwork,run:()=>flipSelection('flipY')},
  ...(canAddLayout||selectedGroup?.autoLayout?[{label:selectedGroup?.autoLayout?'关闭自动布局':'添加自动布局',
   shortcut:selectedGroup?.autoLayout?undefined:'⇧ A',enabled:true,run:toggleAutoLayout}]:[]),
 ];
 useEffect(()=>{
  const handler=(e:KeyboardEvent)=>{
   if(modal||stockChange||confirmDelete||leaving||e.defaultPrevented||e.isComposing)return;
   const mod=e.metaKey||e.ctrlKey,key=e.key.toLowerCase();
   const target=e.target instanceof HTMLElement?e.target:null;
   if(mod&&key==='s'){e.preventDefault();void saveNow();return}
   if(mod&&!e.altKey&&key==='z'){
    if(regionDraft||target?.isContentEditable||target?.closest('input[type="search"],[data-undo-draft]'))return;
    e.preventDefault();
    e.shiftKey?redo():undo();
    return;
   }
   if(target?.closest('input,textarea,select,[contenteditable]'))return;
   if(!regionDraft&&!textEdit){
    const index=mod&&!e.shiftKey&&!e.altKey&&key==='c'?0:
     mod&&!e.shiftKey&&!e.altKey&&key==='v'?1:
     mod&&e.shiftKey&&!e.altKey&&key==='r'?2:
     key==='m'&&(mac?e.metaKey&&e.ctrlKey:e.ctrlKey&&e.altKey)?4:
     mod&&e.shiftKey&&key==='l'?5:
     !mod&&!e.altKey&&e.shiftKey&&key==='h'?6:!mod&&!e.altKey&&e.shiftKey&&key==='v'?7:-1;
    if(index>=0){e.preventDefault();if(commands[index].enabled)commands[index].run();closeMenu();return}
    if(menu)closeMenu();
   }
   if(!mod&&!e.altKey){
    if(e.code==='Space'&&!target?.closest('button:focus-visible,a:focus-visible,[role="button"]:focus-visible')){
     e.preventDefault();setSpaceHeld(true);return;
    }
    if(['+','=','-','0'].includes(key)){
     e.preventDefault();
     if(key==='0')navigationRef.current?.fit();
     else navigationRef.current?.zoomBy(key==='-'?1/ZOOM_STEP:ZOOM_STEP);
     return;
    }
   }
   if(regionDraft&&key!=='escape')return;
   if(['line','pen'].includes(tool)&&['enter','escape','delete','backspace'].includes(key))return;
   if(mod&&!e.altKey&&key==='g'){
    e.preventDefault();
    if(e.shiftKey)dissolveLayerGroup();else formLayerGroup();
   }
   else if(!mod&&!e.altKey&&e.shiftKey&&key==='a'&&canAddLayout&&!selectedGroup?.autoLayout){
    e.preventDefault();toggleAutoLayout();
   }
   else if(mod&&e.altKey&&e.code==='KeyC'&&selected){e.preventDefault();copyStyle()}
   else if(mod&&e.altKey&&e.code==='KeyV'&&selected){e.preventDefault();pasteStyle()}
   else if(mod&&key==='d'){e.preventDefault();duplicateLayer()}
   else if(!mod&&!e.altKey&&key==='enter'&&selected?.type==='text'&&selected.visible&&!selected.locked&&
    (!target?.closest('button')||target.closest('.layer-select'))){
    e.preventDefault();editText(side,selected.id);
   }
   else if(key==='delete'||key==='backspace'){e.preventDefault();requestDelete()}
   else if(key==='escape'){
    if(regionDraft){setRegionDraft(null);setShowLayerMask(false)}
    else if(gradientEditing){setGradientEditing(null)}
    else selectLayer(null);
    setTool('select');
   }
   else if(!mod&&key==='v')setTool('select');
   else if(!mod&&key==='h')setTool('hand');
   else if(!mod&&!e.altKey&&(key==='l'||key==='p'))activateCanvasTool(key==='l'?'line':'pen');
   else if(e.key.startsWith('Arrow')&&selected&&!selected.locked&&!parentLayout){
    e.preventDefault();const delta=e.shiftKey?10:1;
    patchNode({x:selected.x+(e.key==='ArrowRight'?delta:e.key==='ArrowLeft'?-delta:0),y:selected.y+(e.key==='ArrowDown'?delta:e.key==='ArrowUp'?-delta:0)});
   }else if(e.key.startsWith('Arrow')&&selectedGroup&&!parentLayout){
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
 },[modal,stockChange,selected,selectedGroup,layerSelection,project,side,confirmDelete,undo,redo,leaving,regionDraft,saveNow,tool,processView]);
 useEffect(()=>{
  const release=()=>setSpaceHeld(false);
  const onKeyUp=(event:KeyboardEvent)=>{if(event.code==='Space')release()};
  window.addEventListener('keyup',onKeyUp);
  window.addEventListener('blur',release);
  return()=>{window.removeEventListener('keyup',onKeyUp);window.removeEventListener('blur',release)};
 },[]);
 useEffect(()=>{if(modal||stockChange||confirmDelete||leaving)setSpaceHeld(false)},[modal,stockChange,confirmDelete,leaving]);
 const addNode=(type:'text'|'rect'|'ellipse'|'polygon')=>{
  if(regionDraft||leaving)return;
  const doc=current.current;
  const face=doc[side];
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
  replaceId.current=replacement;
  fileInput.current?.click();
 };
 const editText=(face:SideName,id:string)=>{
  if(regionDraft||leaving||modal||readingImages)return;
  const node=current.current[face].nodes.find(item=>item.id===id);
  if(node?.type!=='text'||!node.visible||node.locked)return;
  switchSide(face);
  setInspectorTab('design');
  selectLayer(id,'artwork');setTool('select');
  if(face!==side)revealLayer(current.current[face],id);
  setTextEdit({face,id});
 };
 const finishTextEdit=(face:SideName,id:string,text:string)=>{
  setTextEdit(edit=>edit?.id===id&&edit.face===face?undefined:edit);
  const card=current.current[face];
  const layer=card.nodes.find(item=>item.id===id);
  if(layer?.type!=='text'||layer.locked||!layer.visible||text===(layer.text??''))return;
  changeCanvasSide({...card,nodes:card.nodes.map(item=>item.id===id?{...item,text}:item)},face);
 };
 const cancelTextEdit=useCallback(()=>setTextEdit(undefined),[]);
 const uploadImage=async(file:File,replace:string|null=null)=>{
  const projectId=current.current.id;
  if(leaving||regionDraft)return;
  setImageIssue(null);setReadingImages(count=>count+1);
  try {
   const image=await readImage(file);
   const doc=current.current;
   if(doc.id!==projectId){notify('已切换项目，请重新导入图片');return}
   const face=doc[side];
   const previous=replace?face.nodes.find(node=>node.id===replace):undefined;
   if(replace&&(!previous||previous.locked||previous.type!=='image')){
    notify('所选图层已变更，请重新选择');return;
   }
   if(previous?.type==='image'){
    commit({...doc,[side]:{...face,nodes:face.nodes.map(n=>n.id===replace?{...n,src:image.src,crop:replaceCrop&&n.crop&&(n.crop.space==='source'||(n.crop.width<=1&&n.crop.height<=1))?n.crop:undefined}:n)}});
    if(activeFace.current!==side){notify('图片已替换到'+(side==='front'?'正面':'背面'));return}
    selectLayer(previous.id,'artwork');setTool('select');
    notify('已替换图片，保留当前布局');
    return;
   }
   const scale=Math.min(doc.widthMm*8.8/image.width,doc.heightMm*8.8/image.height,1);
   const width=image.width*scale,height=image.height*scale;
   const node:CardNode={
    ...createArtwork(face,'image'),x:(doc.widthMm*10-width)/2,y:(doc.heightMm*10-height)/2,
    groupId:editableArtwork&&selectedGroup?.autoLayout&&findLayerGroup(face,selectedGroup.id)?.autoLayout?selectedGroup.id:undefined,
    width,height,fill:'#fff',src:image.src,
   };
   commit({...doc,[side]:{...face,nodes:[...face.nodes,node]}});
   if(activeFace.current!==side){notify('图片已加入'+(side==='front'?'正面':'背面'));return}
   setInspectorTab('design');setLayerQuery('');selectLayer(node.id,'artwork');setTool('select');notify('图片已加入卡面');
  } catch(error){if(current.current.id===projectId){setCollapsedLeft(false);setImageIssue({message:`「${file.name}」${(error as Error).message}`,replacement:replace})}}
  finally {setReadingImages(count=>count-1)}
 };
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
  setRegionDraft(structuredClone(draft));setCollapsedLeft(false);
  setTool(['rect','ellipse','polygon'].includes(draft.kind)?'geometry':'brush');setLayerPlate(undefined);
 };
 const cancelRegion=()=>{setRegionDraft(null);setShowLayerMask(false);setTool('select')};
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
  <Button disabled={selected?.locked} onClick={()=>startRegion(targetRegion)}><FigmaIcon name="inspector-mask-edit"/>编辑蒙版</Button>
 </div>;
 const applyRegion=()=>{
  if(!regionDraft)return;
  if((regionDraft.kind==='polygon'&&(regionDraft.points?.length||0)<6)||
     (['rect','ellipse'].includes(regionDraft.kind)&&!regionDraft.bounds)||
     (regionDraft.kind==='paint'&&!regionDraft.strokes.length)){
   notify('先在卡面上绘制一个蒙版');return;
  }
  bindRegion(regionDraft);setRegionDraft(null);setTool('select');
 };
 const displayedProject=regionDraft?{...project,[side]:{...active,regions:active.regions.some(r=>r.id===regionDraft.id)?active.regions.map(r=>r.id===regionDraft.id?regionDraft:r):[...active.regions,regionDraft]}}:project;
 const closeModal=useCallback(()=>setModal(null),[]);
 const openCardProperties=()=>{
  selectLayer(null);setCollapsedRight(false);
 };
 const openPlan=(tab:'spec'|'order')=>{setProductionTab(tab);setModal('production')};
 const closeSize=()=>{setModal(returnToPlan?'production':null);setReturnToPlan(false)};
 const switchSide=(face:SideName)=>{
  if(face===activeFace.current||(face==='back'&&current.current.singleSided))return;
  coalesce.current=null;
  activeFace.current=face;setSide(face);selectLayer(null);setImageIssue(null);
  if(tool!=='line'&&tool!=='pen')setTool('select');
  setLayerQuery('');setLayerPlate(undefined);setGradientEditing(null);
  setDragged(null);setDropAt(null);
 };
 const canvasFaceLocked=leaving||Boolean(regionDraft)||readingImages>0;
 const selectCanvasFace=(face:SideName,nodeId?:string)=>{
  if(canvasFaceLocked)return;
  const sameFace=face===activeFace.current;
  switchSide(face);
  const node=nodeId?current.current[face].nodes.find(item=>item.id===nodeId):undefined;
  if(node&&node.type!=='empty')pickUnit(canvasArtworkUnit(face,node),false,face);
  else if(sameFace)selectLayer(null);
 };
 const createVector=(face:SideName,geometry:CreatedVector)=>{
  if(canvasFaceLocked)return;
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
  if(units.length){setLayerSelection(units);setCollapsedRight(false)}
 };
 const pickUnit=(unit:LayerUnit,additive:boolean,face=side)=>{
  const previous=additive&&face===activeFace.current?selectionUnits:[];
  const existing=previous.some(item=>item.kind===unit.kind&&item.id===unit.id);
  selectUnits(existing?previous.filter(item=>item.kind!==unit.kind||item.id!==unit.id):[...previous,unit],face);
 };
 const canvasArtworkUnit=(face:SideName,node:CardNode):LayerUnit=>{
  const ancestors=layerGroupAncestors(current.current[face],node.groupId);
  const group=ancestors.find(item=>face===side&&item.id===selectedGroup?.id)??ancestors.at(-1);
  return group&&(face!==side||node.id!==selectedId)?{kind:'group',id:group.id}:{kind:'artwork',id:node.id};
 };
 const moveArtwork=(from:SideName,to:SideName,id:string,position:{x:number;y:number},groupId?:string)=>{
  if(canvasFaceLocked)return false;
  const result=transferArtwork(current.current,from,to,id,position,groupId);
  if(!result)return false;
  commit(result.project);
  selectUnits([result.groupId?{kind:'group',id:result.groupId}:{kind:'artwork',id:result.layerId}],to);
  return true;
 };
 const endLayerDrag=()=>{
  sidebarDrag.current=null;
  setSidebarDropFace(undefined);
  setDragged(null);setDropAt(null);
 };
 const beginLayerDrag=(event:DragEvent,id:string,kind:LayerUnit['kind'],locked=false)=>{
  if(canvasFaceLocked||locked){event.preventDefault();return}
  sidebarDrag.current={face:side,id,kind,locked};
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData(LAYER_DRAG_TYPE,id);
  setDragged(id);
 };
 const layerDropTarget=(event:DragEvent<HTMLElement>,origin:SideName)=>{
  const face:SideName=origin==='front'?'back':'front';
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
    if(result?.groupId){commit(result.project);selectUnits([{kind:'group',id:result.groupId}],target.face)}
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
 const parentOf=(unit:LayerUnit)=>{
  const groupId=unit.kind==='artwork'?active.nodes.find(node=>node.id===unit.id)?.groupId:
   unit.kind==='process'?active.effects.find(entry=>entry.id===unit.id)?.groupId:undefined;
  return unit.kind==='group'?findLayerGroup(active,unit.id)?.parentId:findLayerGroup(active,groupId)?.id;
 };
 const visualPass=(unit:LayerUnit)=>unit.kind==='group'?
  (layerGroupMembers(active,unit.id).effectIds.length?'process':'artwork'):unit.kind;
 const rowDrag=(unit:LayerUnit,locked=false)=>{
  const matchingDrag=()=>{
   const source=sidebarDrag.current;
   return source&&source.face===side&&!source.locked&&source.id!==unit.id&&parentOf(source)===parentOf(unit)&&visualPass(source)===visualPass(unit)?source:undefined;
  };
  const placement=(event:DragEvent<HTMLElement>)=>{
   const row=event.currentTarget.getBoundingClientRect();
   return event.clientY>row.top+row.height/2?'after':'before';
  };
  return {
   draggable:!locked,
   onDragStart:(event:DragEvent<HTMLElement>)=>beginLayerDrag(event,unit.id,unit.kind,locked),
   onDragEnd:endLayerDrag,
   onDragOver:(event:DragEvent<HTMLElement>)=>{
    if(!matchingDrag()){
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
    const source=matchingDrag();
    if(!source)return;
    event.preventDefault();
    const card=current.current[side];
    const next=reorderLayerUnits(card,source,unit,placement(event));
    if(next!==card)changeSide(next);
    endLayerDrag();
   },
  };
 };
 const layerRow=(item:LayerTreeItem,depth=0):ReactNode=>{
  const chosen=selectionUnits.some(unit=>unit.kind===item.kind&&unit.id===item.id);
  const selectedClass=chosen?' selected':'';
  const dragClass=dragged===item.id?' dragging':'';
  const dropClass=dropAt?.id===item.id?` drop-target drop-${dropAt.placement}`:'';
  const className=`layer-row layer-tree-row${selectedClass}${dragClass}${dropClass}`;
  const style={marginInlineStart:Math.min(depth,9)*12};
  const select=(event:React.MouseEvent<HTMLButtonElement>)=>pickUnit(item,event.shiftKey||event.metaKey||event.ctrlKey);
  const rowMenu=(event:React.MouseEvent)=>{
   event.preventDefault();event.stopPropagation();if(canvasFaceLocked)return;
   if(!chosen)selectUnits([{kind:item.kind,id:item.id}],side);
   setMenu({screen:{x:event.clientX,y:event.clientY}});
  };
  if(item.kind==='group'){
   const {group,children}=item;
   const collapseKey=processView==='all'?group.id:processView+':'+group.id;
   const expanded=Boolean(query)||!closedGroups.has(collapseKey);
   const contents=layerGroupMembers(active,group.id);
   const ids=new Set(contents.artworkIds);
   const locked=active.nodes.some(node=>ids.has(node.id)&&node.locked);
   const childrenId='layer-group-children-'+group.id;
   return <div className="layer-tree-branch" key={group.id}>
    <div data-layer-group-id={group.id} className={className+' layer-group-row'} style={style} onContextMenu={rowMenu} {...rowDrag(item,locked)}>
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
     {children.map(child=>layerRow(child,depth+1))}
    </div>}
   </div>;
  }
  const node=item.kind==='artwork'?item.node:undefined;
  const entry=item.kind==='process'?item.effect:undefined;
  const layer=node??entry!;
  const kind=entry?' process-layer':'';
  const muted=layer.visible?'':' muted-row';
  return <div key={item.id} data-layer-id={item.id} className={className+kind+muted} style={style} onContextMenu={rowMenu} {...rowDrag(item,node?.locked)}>
   <span className="layer-disclosure-slot" aria-hidden="true"/>
   <button type="button" className="layer-select" aria-pressed={chosen} title={layer.name} onClick={select}>
    <span className="layer-icon">{node?.type==='ellipse'?<Circle size={12}/>:<FigmaIcon name={node?ARTWORK_LAYER_ICONS[node.type]:'layer-default'}/>}</span>
    <span className="layer-name">{layer.name}</span>
   </button>
   {node&&<button type="button" title={node.locked?'解锁图层':'锁定图层'} aria-label={node.name+(node.locked?'解锁':'锁定')}
    className={`row-action ${node.locked?'persistent':''}`}
    onClick={()=>changeSide({...active,nodes:active.nodes.map(candidate=>candidate.id===node.id?{...candidate,locked:!candidate.locked}:candidate)})}>
    {node.locked?<Lock size={12}/>:<FigmaIcon name="layer-unlock"/>}
   </button>}
   <button type="button" title={layer.visible?'隐藏图层':'显示图层'} aria-label={layer.name+(layer.visible?'隐藏':'显示')}
    className={`row-action ${!layer.visible?'persistent':''}`}
    onClick={()=>changeSide(node?{...active,nodes:active.nodes.map(candidate=>candidate.id===node.id?{...candidate,visible:!candidate.visible}:candidate)}:
     {...active,effects:active.effects.map(candidate=>candidate.id===item.id?{...candidate,visible:!candidate.visible}:candidate)})}>
    {layer.visible?<FigmaIcon name="layer-eye"/>:<EyeOff size={12}/>}
   </button>
  </div>;
 };
 return <div className={`studio ${collapsedLeft?'left-collapsed':''} ${collapsedRight?'right-collapsed':''}`}>
  <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];const replacement=replaceId.current;replaceId.current=null;if(f)void uploadImage(f,replacement);e.target.value=''}}/>
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
    <IconButton icon={<FigmaIcon name="panel-left-close"/>} title="收起左侧面板" onClick={()=>setCollapsedLeft(true)}/>
    <span className="sr-only" role="status">{saveState}</span>
   </header>
   <div className="canvas-modes" role="group" aria-label="工艺视图">
    {PROCESS_VIEWS.map(({id,label})=>
     <button type="button" key={id} className="button" aria-pressed={processView===id} disabled={!!regionDraft}
      onClick={()=>changeProcessView(id)}>{label}</button>
    )}
   </div>
   <button className="stack-link layer-stock" disabled={!!regionDraft} onClick={openCardProperties}>
    <span>卡基与底材<small>{stockPreset(project.material)?.name??project.material} · {STOCK_REFLECTIONS[getStockReflection(project,side)]}</small></span>
    <FigmaIcon name="stock-chevron"/>
   </button>
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
     {groupTree.map(item=>layerRow(item))}
     {!groupTree.length&&<p className="panel-description">
      {query?'没有找到匹配的图层。':processView==='all'?'还没有图层。':`当前卡面没有${PROCESS_VIEWS.find(view=>view.id===processView)?.label}图层。`}
     </p>}
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
     ?<button disabled={leaving} onClick={()=>void saveCopy()}>另存当前副本</button>
     :<button disabled={leaving} onClick={()=>void saveNow()}>重试保存</button>}
    <button onClick={()=>exportProject(current.current).then(()=>notify('项目包已下载')).catch(error=>notify(error.message))}>下载项目包</button>
   </div>}
   <div className="canvas-area"><EditorCanvas cardBoundsRef={cardBoundsRef} project={displayedProject} side={side} selectedId={selected?.id??null} selectedIds={selectedArtworkIds} artworkGroupId={selectedGroup?.id} onSelectFace={selectCanvasFace}
    onCanvasMenu={(face,point,screen,nodeId)=>{
     if(canvasFaceLocked)return;
     const node=project[face].nodes.find(item=>item.id===nodeId);
     if(node){if(face!==side||!selectedArtworkIds.includes(node.id))selectUnits([canvasArtworkUnit(face,node)],face)}
     else if(face!==side||processView==='all')selectUnits([],face);
     setMenu({point,screen});
    }} onCreateVector={createVector} flashOnly={flashOnly}
    onTransferArtwork={moveArtwork} sidebarDropFace={sidebarDropFace} faceLocked={canvasFaceLocked} onSelect={(id,additive)=>{
    if(regionDraft||plate||flashOnly)return;
    const node=id?active.nodes.find(item=>item.id===id):undefined;
    if(node)pickUnit(canvasArtworkUnit(side,node),Boolean(additive));
    else selectLayer(null);
   }} onChange={changeCanvasSide} tool={tool} spaceHeld={spaceHeld} navigationRef={navigationRef} showGuides regionId={regionDraft?.id??targetRegion?.id??null} highlightRegion={maskHighlight} regionMode={!!regionDraft} onRegionChange={setRegionDraft}
    textEdit={modal||regionDraft||leaving?undefined:textEdit} onTextEdit={editText} onTextCommit={finishTextEdit} onTextCancel={cancelTextEdit}
    plate={plate} brushSize={brushSize} layerPlate={isolatedPlate?layerPlate:undefined} effectPreviewId={effect?.id} editGradient={rightTab==='design'&&gradientEditing===selected?.id} onGradientChange={gradient=>patchStyle({gradient})} onGradientStart={startStyleEdit}/></div>
   {menu&&<LayerContextMenu screen={menu.screen} commands={commands} close={closeMenu}/>}
   {hasModeNotice&&<div className="canvas-notes"><div className="canvas-top-note">{regionDraft?(tool==='geometry'?(regionDraft.kind==='polygon'?'点击卡面添加顶点，完成后自动闭合':'在卡面拖动绘制形状'):'正在编辑作用区域'):plate?(isolatedPlate?'独立工艺层 · 黑色表示施作位置':'按通道合版 · 黑色表示施作位置'):flashOnly?'局部闪光预览':'绿色显示当前蒙版范围'}</div></div>}
   <div className="canvas-guide-legend"><PrintGuideLegend project={project} compact/></div>
   {regionDraft&&<div className="region-bar"><span><Paintbrush size={16}/>{regionDraft.name}</span>{['rect','ellipse','polygon'].includes(regionDraft.kind)&&<IconButton icon={Square} title="绘制几何轮廓" active={tool==='geometry'} onClick={()=>{if(regionDraft.kind==='polygon')setRegionDraft({...regionDraft,points:[]});setTool('geometry')}}/>}<IconButton icon={Paintbrush} title="画笔" active={tool==='brush'} onClick={()=>setTool('brush')}/><IconButton icon={Eraser} title="擦除" active={tool==='eraser'} onClick={()=>setTool('eraser')}/><input aria-label="笔刷大小" type="range" min="4" max="120" value={brushSize} onChange={e=>setBrushSize(+e.target.value)}/><span>{brushSize}</span><Button onClick={()=>setRegionDraft(regionDraft.strokes.length?{...regionDraft,strokes:regionDraft.strokes.slice(0,-1)}:{...regionDraft,points:regionDraft.points?.slice(0,-2)})} disabled={!regionDraft.strokes.length&&!regionDraft.points?.length}><Undo2 size={14}/></Button><Button onClick={()=>setRegionDraft({...regionDraft,inverted:!regionDraft.inverted})}>反选</Button><Button onClick={cancelRegion}>取消</Button><Button className="primary" onClick={applyRegion}><Check size={14}/>完成</Button></div>}
   {!regionDraft&&<div className="canvas-toolbox" role="group" aria-label="画布工具">
    <div className="canvas-tool-group">
     <IconButton icon={tool==='hand'?Hand:<FigmaIcon name="tool-select"/>} title={tool==='hand'?'平移画布 H':'选择 V'} active={tool==='select'||tool==='hand'} onClick={()=>setTool(tool==='hand'?'hand':'select')}/>
     <CanvasToolMenu title="选择画布工具"><button onClick={()=>setTool('select')}><FigmaIcon name="tool-select"/>选择 <kbd>V</kbd></button><button onClick={()=>setTool('hand')}><Hand size={15}/>平移 <kbd>H</kbd></button></CanvasToolMenu>
    </div>
    <IconButton icon={<FigmaIcon name="tool-line"/>} title="直线 L" active={tool==='line'} onClick={()=>activateCanvasTool('line')}/>
    <div className="canvas-tool-group">
     <IconButton icon={<FigmaIcon name="tool-rectangle"/>} title="添加矩形" onClick={()=>addNode('rect')}/>
     <CanvasToolMenu title="形状工具"><button onClick={()=>addNode('rect')}><FigmaIcon name="tool-rectangle"/>矩形</button><button onClick={()=>addNode('ellipse')}><Circle size={15}/>椭圆</button><button onClick={()=>addNode('polygon')}><Pentagon size={15}/>多边形</button><button onClick={()=>chooseImage()}><ImagePlus size={15}/>上传图片</button></CanvasToolMenu>
    </div>
    <IconButton icon={<FigmaIcon name="tool-text"/>} title="添加文字" onClick={()=>addNode('text')}/>
    <IconButton icon={<FigmaIcon name="tool-pen"/>} title="钢笔 P" active={tool==='pen'} onClick={()=>activateCanvasTool('pen')}/>
   </div>}
  </main>
  <aside className={`right-panel ${designLayer?'design-inspector':''}`} aria-label="属性面板" inert={leaving}>
   <header className="drawer-action-bar">
    <img className="editor-avatar" src="/assets/workbench/local-avatar.png" width="24" height="24" alt=""/>
    <div className="drawer-main-actions">
     <IconButton icon={<FigmaIcon name="finished-preview"/>} title="成品预览" onClick={()=>setModal('preview')} disabled={leaving||!!regionDraft||readingImages>0}/>
     <Button className="primary drawer-text-action" onClick={()=>{setStillView(undefined);setModal('export')}} disabled={leaving||!!regionDraft||readingImages>0}>导出</Button>
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
   <div className="panel-toolbar inspector-toolbar">
    {designLayer?<>
     <input className="inspector-layer-name" aria-label="图层名称" maxLength={100} value={designLayer.name}
      title={designLayer.name} placeholder="图层名称" disabled={designLayer.locked}
      onChange={event=>patchNode({name:event.target.value})}/>
     <div className="style-section-actions">
      <InspectorMenu ariaLabel="更多图层操作" triggerIcon={<FigmaIcon name="layer-more"/>} variant="action" menuWidth={242} align="end"
       options={[
        { value: 'duplicate', label: '复制图层', action: duplicateLayer },
        { value: 'delete', label: '删除图层', disabled: designLayer.locked, action: requestDelete },
        ...PROCESS_MENU_OPTIONS.map(({value,label}) => ({
         value, label, group: '设为工艺图层', disabled: designLayer.locked, action: () => changeKind(value),
        })),
       ]}/>
     </div>
    </>:selectedGroup&&!regionDraft?<LayerGroupName key={selectedGroup.id} name={selectedGroup.name} onRename={name=>{
     const next=renameLayerGroup(current.current[side],selectedGroup.id,name);
     if(next!==current.current[side])changeSide(next);
    }}/>:<span>{regionDraft?'蒙版属性':rightTab==='material'?'卡牌属性':rightTab==='layerProperties'?selected?.name:rightTab==='multi'?`已选中 ${selectedCount} 个图层`:'工艺属性'}</span>}
   </div>
   <div className="right-scroll" key={regionDraft?'mask':rightTab}>
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
   </div>:<>
   {rightTab==='group'&&selectedGroup&&<>
    {selectedGroup.autoLayout?<AutoLayoutProperties key={selectedGroup.id} layout={selectedGroup.autoLayout}
     locked={!editableArtwork} onRemove={toggleAutoLayout} onChange={layout=>changeSide(setAutoLayout(current.current[side],selectedGroup.id,layout))}/>
     :canAddLayout&&<Button className="wide-button" onClick={toggleAutoLayout}>添加自动布局</Button>}
    {parentLayout&&selectedGroup.autoLayout&&<LayoutItemProperties item={selectedGroup.layoutItem} parent={parentLayout} allowHug
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
   </div>}
   {rightTab==='layerProperties'&&selected&&<>
    <StyleSection title="图层">
     <LayerTypeField kind="artwork" disabled={selected.locked} onChange={changeKind}/>
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
     {parentLayout&&<LayoutItemProperties key={'layout-'+selected.id} item={selected.type==='text'?{heightMode:'hug',...selected.layoutItem}:selected.layoutItem} parent={parentLayout}
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
     <LayerAppearanceEditor key={'appearance-'+selected.id} node={selected} onChange={patchStyle} onEditStart={startStyleEdit}
      editingGradient={gradientEditing===selected.id} onToggleGradient={toggleGradient}
      onCrop={()=>setModal('crop')} preserveImageCrop={replaceCrop}>
      {selected.type==='text'&&<LayerTypography node={selected} onChange={patchStyle} onEditStart={startStyleEdit}/>}
     </LayerAppearanceEditor>
     <StyleSection title="效果" actions={<InspectorMenu ariaLabel="按图层轮廓添加效果" triggerIcon={<FigmaIcon name="section-add"/>}
      variant="action" menuWidth={242} align="end" options={PROCESS_MENU_OPTIONS}
      onChange={kind=>createProcessFromArtwork(selected,kind as ProcessKind)}/>}/>
    <StyleSection title="蒙版">
     <LayerMaskField name="彩稿蒙版" regions={maskRegions} value={selected.clipRegionId}
      disabled={selected.locked} artwork onChange={selectMask} compact/>
     {targetRegion&&maskActions()}
    </StyleSection>
   </>}
   {rightTab==='material'&&<><div className="section-heading">卡基与底材</div>
    <StockPicker material={project.material} spec={effectiveStockSpec(project)??{}}
      onMaterial={material=>setStockChange({material,stockSpec:changeStockSpec(material,project.material,effectiveStockSpec(project)??{})})}
      onSpec={spec=>changeBase(project.material,spec)}/>
    <StockFinishControls project={project} side={side} onSide={switchSide} onChange={changeFinish} onMatch={()=>setModal('stockMatch')}/>
    <div className="section-heading">版面规格</div><div className="spec-list"><span>成品尺寸<b>{project.widthMm} × {project.heightMm} mm · {project.singleSided?'单面':'双面'}</b></span><span>出血<b>{project.bleedMm} mm</b></span><span>圆角半径<b>{getCardCornerRadiusMm(project)} mm</b></span><span>正文安全区<b>内缩 {getPrintSafeMarginMm(project)} mm</b></span><span>生产状态<b>待工厂确认</b></span></div>
    <Button className="wide-button" onClick={()=>setModal('size')}><Settings2 size={14}/>调整卡片尺寸</Button>
    <Button className="wide-button" onClick={()=>openPlan('spec')}><HugeiconsIcon icon={ClipboardListIcon} size={14} aria-hidden="true"/>规格与刀模</Button></>}

   </>}
   </div></aside>
  {toast&&<div className="toast" role="status"><CheckCircle2 size={17}/>{toast}</div>}
  {modal==='maskUnion'&&<MaskUnionModal regions={maskRegions} onClose={closeModal} onApply={sources=>{
   bindRegion({id:uid(),name:'组合蒙版',kind:'union',sources,binding:'fixed',inverted:false,strokes:[]});
   closeModal();
  }}/>}
  {modal==='maskContent'&&effect&&<Modal title={effect.name+' · 蒙版内容'} wide onClose={closeModal}><MaskContentEditor project={project} side={active} effect={effect} onClose={closeModal} onApply={maskContent=>{patchEffect({maskContent});closeModal()}}/></Modal>}
  {modal==='rename'&&<RenameProject name={project.name} onClose={closeModal} onRename={name=>{if(name!==project.name)commit({...current.current,name});closeModal()}}/>}
  {modal==='crop'&&selected&&cropFill&&<Modal title="编辑图片裁切" wide onClose={closeModal}><CropEditor key={selected.id}
   node={{...selected,src:cropFill.src,crop:cropFill.crop}} onCancel={closeModal} onApply={applyCrop}
   preserveCrop={{checked:replaceCrop,onChange:setReplaceCrop}}/></Modal>}
  {modal==='preview'&&<AlbumPreview cardBoundsRef={cardBoundsRef} project={project} initialSide={side} material={MATERIALS.find(m=>m.id===project.material)?.name}
   onClose={closeModal} onExport={view=>{setStillView(view);setModal('export')}}/>}
  {modal==='plateProof'&&<Modal title="分版核稿" wide onClose={()=>setModal('export')}>
   <PlateProof project={project} initialSide={side} applyFactory={proofFactory}/>
  </Modal>}
  {modal==='production'&&<Modal title="卡牌制作" drawer onClose={closeModal}>
   <ProductionPlanEditor project={project} material={MATERIALS.find(m=>m.id===project.material)?.name||project.material}
    initialTab={productionTab} onChange={(production,key)=>{
     const doc=current.current;
     const next={...doc,production};
     if(stockKeys(doc).profileKey!==stockKeys(next).profileKey){
      for(const face of BOTH_FACES)if(doc[face].stockFinish?.match)next[face]=resetStockFinishMatch(doc,face);
     }
     commit(next,key);
    }} onArtwork={closeModal}
    onSize={()=>{setReturnToPlan(true);setModal('size')}} onStock={()=>{openCardProperties();closeModal()}}
    onPreflight={()=>{setPrintEntry(entry=>entry+1);setModal('export')}} onLocate={locateProductionLayer}/>
  </Modal>}
  <ExportPanel open={modal==='export'} project={project} onClose={closeModal} notify={notify}
   printEntry={printEntry} stillView={stillView} onPlateProof={applyFactory=>{setProofFactory(applyFactory);setModal('plateProof')}} onProduction={()=>openPlan('order')} onLocate={target=>{
   switchSide(target.side);
   const face=project[target.side];
   const linkedEffect=face.effects.find(item=>item.id===target.effectId);
   const linkedNode=face.nodes.find(item=>item.id===target.nodeId);
   selectLayer(linkedEffect?.id??linkedNode?.id??null,linkedEffect?processKind(linkedEffect):linkedNode?'artwork':undefined);
   if(target.material)setInspectorTab('properties');
   else if(linkedNode)setInspectorTab('design');
   setCollapsedRight(false);setModal(null);
  }}/>
  {modal==='size'&&<SizeModal project={project} onClose={closeSize} onApply={p=>{
   if(p.singleSided&&side==='back')switchSide('front');
   commit(p);closeSize();notify('尺寸已更新');
  }}/>}
  {modal==='stockMatch'&&<Modal title={'匹配反光用料 · '+(side==='front'?'正面':'背面')} onClose={closeModal}>
   <StockFinishMatchForm project={project} side={side} onClose={closeModal} onPlan={()=>openPlan('spec')} onApply={match=>{
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
  {confirmDelete&&<Modal title="这个图层关联了作用区域" onClose={()=>setConfirmDelete(null)}><div className="help-content"><p>删除「{confirmDelete.name}」后，可以把关联区域固定在当前位置，继续保留效果。</p><div className="inline-actions"><Button onClick={()=>deleteNode(confirmDelete,true)}>连同区域与效果删除</Button><Button className="primary" onClick={()=>deleteNode(confirmDelete,false)}>保留区域，删除图层</Button></div></div></Modal>}
 </div>
}

function MaskUnionModal({regions,onClose,onApply}:{regions:Region[];onClose:()=>void;onApply:(ids:string[])=>void}) {
 const [ids,setIds]=useState<string[]>([]);
 return <Modal title="组合蒙版" onClose={onClose}>
  <div className="new-content">
   {regions.filter(region=>region.kind!=='full').map(region=><label key={region.id} className="check-field">
    <input type="checkbox" checked={ids.includes(region.id)} disabled={ids.length>=16&&!ids.includes(region.id)}
     onChange={event=>setIds(items=>event.target.checked?[...items,region.id]:items.filter(id=>id!==region.id))}/>{region.name}
   </label>)}
  </div>
  <div className="modal-footer"><Button onClick={onClose}>取消</Button>
   <Button className="primary" disabled={ids.length<2} onClick={()=>onApply(ids)}>应用组合蒙版</Button>
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

function resizeCard(project:Project,width:number,height:number,bleed:number,radius:number,fitArtwork:boolean) {
  const next={...structuredClone(project),widthMm:width,heightMm:height,bleedMm:bleed,cornerRadiusMm:radius};
  if(fitArtwork&&(project.widthMm!==width||project.heightMm!==height)){
   const scale=Math.min(width/project.widthMm,height/project.heightMm);
   const dx=(width-project.widthMm*scale)*5,dy=(height-project.heightMm*scale)*5;
   const scaleNode=(node:CardNode)=>{
    node.x=node.x*scale+dx;node.y=node.y*scale+dy;node.width*=scale;node.height*=scale;
    if(node.fontSize)node.fontSize*=scale;
    if(node.strokeWidth)node.strokeWidth*=scale;
    if(node.letterSpacing)node.letterSpacing*=scale;
    if(node.cornerRadius)node.cornerRadius*=scale;
   };
   for(const side of [next.front,next.back]){
    side.nodes.forEach(scaleNode);
    side.effects.forEach(effect=>effect.maskContent?.forEach(scaleNode));
    for(const group of side.groups??[]){
     if(!group.autoLayout)continue;
     group.autoLayout=scaleAutoLayout(group.autoLayout,scale,scale,dx,dy);
    }
    for(const region of side.regions){
     if(region.bounds){region.bounds.x=region.bounds.x*scale+dx;region.bounds.y=region.bounds.y*scale+dy;region.bounds.width*=scale;region.bounds.height*=scale}
     if(region.points)region.points=region.points.map((p,i)=>p*scale+(i%2?dy:dx));
     if(region.snapshot)scaleNode(region.snapshot);
     for(const stroke of region.strokes){stroke.size*=scale;stroke.points=stroke.points.map((p,i)=>p*scale+(i%2?dy:dx))}
    }
   }
  }
  return next;
}

function SizeModal({project,onClose,onApply}:{project:Project;onClose:()=>void;onApply:(p:Project)=>void}){
 const [width,setWidth]=useState(project.widthMm),[height,setHeight]=useState(project.heightMm),[bleed,setBleed]=useState(project.bleedMm);
 const [sizeIndex,setSizeIndex]=useState(-1);
 const [radius,setRadius]=useState(() => getCardCornerRadiusMm(project));
 const [singleSided,setSingleSided]=useState(Boolean(project.singleSided));
 const [mode,setMode]=useState('keep');
 const maxRadius=Math.max(0,Math.min(width,height)/2);
 const validSize=width>=20&&width<=300&&height>=20&&height<=300&&bleed>=0&&bleed<=20;
 const validRadius=Number.isFinite(radius)&&radius>=0&&radius<=maxRadius;
 const valid=validSize&&validRadius;
 const resize=()=>{if(valid)onApply({...resizeCard(project,width,height,bleed,radius,mode==='scale'),singleSided});};
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
  <label className="field">卡牌面数<select value={singleSided?'front':'both'} onChange={e=>setSingleSided(e.target.value==='front')}>
   <option value="both">双面</option><option value="front">仅正面</option>
  </select></label>
  <div className="corner-settings">
   <div>
    <label className="field">圆角半径（mm）<input type="number" value={radius} min={0} max={maxRadius} step=".1" aria-invalid={!validRadius} onChange={event=>setRadius(+event.target.value)}/></label>
    <p className="micro-copy">{validRadius?'0 mm 为直角。出血线和正文安全线随裁切线同步调整。':`圆角半径须在 0–${maxRadius} mm 之间。`}</p>
   </div>
   {validSize&&<PrintCornerPreview project={{widthMm:width,heightMm:height,bleedMm:bleed,cornerRadiusMm:radius,production:project.production}}/>}
  </div>
  <label className="field">图层处理<select value={mode} onChange={e=>setMode(e.target.value)}><option value="keep">保持对象实际尺寸</option><option value="scale">整体等比缩放并居中</option></select></label>
  {projectPrintProfile(project)&&[width!==project.widthMm,height!==project.heightMm,bleed!==project.bleedMm,singleSided!==Boolean(project.singleSided)].some(Boolean)&&
   <p className="micro-copy" role="status">规格或面数变更后，请用当前厂规重新预检。</p>}
  <p className="micro-copy">{validSize?`含出血 ${+(width+bleed*2).toFixed(2)} × ${+(height+bleed*2).toFixed(2)} mm`:'宽高须在 20–300 mm，出血须在 0–20 mm。'}</p>
 </div><div className="modal-footer"><Button onClick={onClose}>取消</Button><Button className="primary" disabled={!valid} onClick={resize}>应用尺寸</Button></div></Modal>;
}

type ExportMode='image'|'print'|'project';
type PrintProfile=TechnicalPrintProfile;
type ExportRequest={mode:ExportMode;project:Project;sides:SideName[];dpi:number;format:'png'|'jpeg';effects:boolean;profile:PrintProfile;
 includeGrain:boolean;applyFactory:boolean;imageWidth:number;imageHeight:number;imageBackground:string;view?:StillView;issues:PreflightIssue[]};
type JobState={label:string;progress:number;error?:string;file?:Blob;name?:string;request:ExportRequest;unrecorded?:boolean};
function usedPlates(project:Project,side:SideName){
 return PRINT_CHANNELS.filter(key=>project[side].effects.some(effect=>effectInProduction(effect)&&plateFor(effect)===key));
}
function canvasBlob(canvas:HTMLCanvasElement,format:'png'|'jpeg'){return new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成图片，请降低分辨率后重试')),`image/${format}`,.94))}

const FRONT_ONLY:SideName[]=['front'];
const BOTH_FACES:SideName[]=['front','back'];

function ExportPanel({project,onClose,notify,open,onLocate,printEntry,onProduction,onPlateProof,stillView}:{
 project:Project;onClose:()=>void;notify:(message:string)=>void;open:boolean;onLocate:(target:PreflightTarget)=>void;
 printEntry:number;onProduction:()=>void;onPlateProof:(applyFactory:boolean)=>void;stillView?:StillView
}){
 const [mode,setMode]=useState<ExportMode>('image'),[selectedSides,setSides]=useState<SideName[]>(BOTH_FACES),[dpi,setDpi]=useState(300),[format,setFormat]=useState<'png'|'jpeg'>('png'),[effects,setEffects]=useState(true);
 const sides=project.singleSided?FRONT_ONLY:selectedSides;
 const [useView,setUseView]=useState(false),[imageHeight,setImageHeight]=useState('');
 const [imageBackground,setImageBackground]=useState<'view'|'white'|'dark'|'transparent'>('white');
 const [profile,setProfile]=useState<PrintProfile>('standard'),[job,setJob]=useState<JobState|null>(null),[grain,setGrain]=useState<'exclude'|'include'|'unset'>('unset');
 const [route,setRoute]=useState<'factory'|'technical'>('factory');
 const [service,setService]=useState<'checking'|'online'|'offline'|'outdated'>('checking'),[busy,setBusy]=useState(false);
 const [serviceCheck,setServiceCheck]=useState(0);
 const [deliveryVersions,setDeliveryVersions]=useState<number[]>([]);
 const [selectedVersion,setSelectedVersion]=useState<number>();
 const [backingUp,setBackingUp]=useState(false);
 const factory=projectPrintProfile(project);
 const applyFactory=route==='factory'&&Boolean(factory);
 const raster=applyFactory&&isRasterProfile(project);
 const printDpi=applyFactory?factory!.dpi:dpi;
 const [checked,setChecked]=useState<{snapshot:Project;faces:SideName[];preset:PrintProfile;dpi:number;factory:boolean;issues:PreflightIssue[];error?:string}>();
 const checkReady=checked?.snapshot===project&&checked.faces===sides&&checked.preset===profile&&checked.dpi===printDpi&&checked.factory===applyFactory;
 const issues=checkReady&&checked?checked.issues:[];
 const abort=useRef<AbortController|null>(null);
 useEffect(()=>{
  if(!open||mode!=='project')return;
  let active=true;
  import('./browserProjects').then(store=>store.listDeliveryVersions(project.id))
   .then(versions=>{if(active)setDeliveryVersions(versions)})
   .catch(()=>{if(active)setDeliveryVersions([])});
  return()=>{active=false};
 },[open,mode,project.id,job?.file]);
 const downloadDeliveryVersion=async(version:number, fallback?:Project)=>{
  setBackingUp(true);
  try {
   const snapshot=fallback??await import('./browserProjects').then(store=>store.readDeliveryVersion(project.id,version));
   if(!snapshot)throw new Error('这个交付版本暂时无法读取');
   const file=await buildProjectArchive(snapshot);
   downloadBlob(file,`${snapshot.name}-v${version}.cardproj`);
  } catch(error){notify((error as Error).message)}
  finally{setBackingUp(false)}
 };
 useEffect(()=>{if(printEntry)setMode('print')},[printEntry]);
 useEffect(()=>{
  if(!stillView)return;
  setMode('image');setSides([stillView.side]);setUseView(true);setImageBackground('view');
 },[stillView]);
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
  const inputs={snapshot:project,faces:sides,preset:profile,dpi:printDpi,factory:applyFactory};
  printPreflight(project,sides,profile,printDpi,controller.signal,applyFactory)
   .then(issues=>{if(!controller.signal.aborted)setChecked({...inputs,issues});})
   .catch(()=>{if(!controller.signal.aborted)setChecked({...inputs,issues:[],error:'无法完成预检，请重试'});});
  return()=>controller.abort();
 },[open,mode,project,sides,profile,printDpi,applyFactory,serviceCheck]);
 const hasGrain=reflectionCount(project,sides)>0;
 const names=printSpotNames(project,profile,applyFactory);
 const allPlates=PRINT_CHANNELS.filter(key=>sides.some(s=>usedPlates(project,s).includes(key)));
 const order=productionSteps(project,project.production,sides);
 const run=async(request:ExportRequest)=>{
  if(abort.current)return;
  const controller=new AbortController();abort.current=controller;setBusy(true);
  setJob({request,label:'准备项目快照',progress:5});
  const progress=(label:string,amount:number)=>setJob({request,label,progress:amount});
  const check=()=>controller.signal.throwIfAborted();
  const stem=request.project.name.replace(/[\\/:*?"<>|]/g,'_')||'卡牌';
  try {
   let file:Blob,name:string;
   if(request.mode==='project'){
    progress('打包可编辑图层和原始素材',35);
    file=await buildProjectArchive(request.project);
    name=`${stem}.cardproj`;
   } else if(request.mode==='image'){
    const zip=new JSZip();let imageFile:Blob|null=null;
    for(const [index,face] of request.sides.entries()){
     progress(`渲染${face==='front'?'正面':'背面'}图片`,20+index*35);
     const canvas=await renderStill(request.project,face,{width:request.imageWidth,height:request.imageHeight,
      effects:request.effects,view:request.view?.side===face?request.view:undefined,background:request.imageBackground});
     check();imageFile=await canvasBlob(canvas,request.format);zip.file(`${face}.${request.format==='jpeg'?'jpg':'png'}`,imageFile);
    }
    file=request.sides.length===1?imageFile!:await zip.generateAsync({type:'blob'});
    name=request.sides.length===1?`${stem}-v${request.project.version}-${request.sides[0]}.${request.format==='jpeg'?'jpg':'png'}`:`${stem}-v${request.project.version}-数字卡图.zip`;
   } else if(request.applyFactory&&isRasterProfile(request.project)){
    progress('生成含出血的厂规主图',30);
    file=await exportFactoryRaster(request.project,request.sides,controller.signal,request.issues,request.includeGrain);
    name=`${stem}-v${request.project.version}-交稿图片.zip`;
   } else {
    const outputProfile=request.applyFactory?projectPrintProfile(request.project):undefined;
    const pages=[];
    for(const [index,face] of request.sides.entries()){
     progress(`生成${face==='front'?'正面':'背面'}彩稿与工艺版`,15+index*23);
     const options={scale:request.dpi/254,bleed:true,productionOnly:true};
     const printEffects=request.includeGrain?request.project[face].effects
      .filter(e=>effectInProduction(e)&&processKind(e)==='reflection').map(e=>({...e,visible:true})):[];
     const printProject={...request.project,[face]:{...request.project[face],effects:printEffects}};
     const artwork=orientPrintCanvas(await renderCard(printProject,face,{...options,effects:request.includeGrain,material:false}),face,outputProfile).toDataURL('image/png');
     const layers=[];
     for(const channel of PRINT_CHANNELS){
      for(const entry of request.project[face].effects.filter(effect=>effectInProduction(effect)&&plateFor(effect)===channel)){
       check();
       const mask=orientPrintCanvas(await renderCard(request.project,face,{...options,plate:channel,layerId:entry.id}),face,outputProfile).toDataURL('image/png');
       layers.push({id:entry.id,name:entry.name,channel,variant:entry.type,regionId:entry.regionId,mask});
      }
     }
     pages.push({side:face,artwork,layers});check();
    }
    progress('生成 PDF、TIFF 并核对版面',70);
    const {id,name:projectName,version,widthMm,heightMm,bleedMm,material}=request.project;
    const production=request.project.production;
    const job={...production,printProfile:request.applyFactory?production?.printProfile:undefined,
     dieShape:production?.dieShape??'card',cornerRadiusMm:getCardCornerRadiusMm(request.project),
     flashTreatment:request.includeGrain?'artwork':reflectionCount(request.project,request.sides)?'preview':'unused',
     steps:productionSteps(request.project,production,request.sides)};
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
    name=`${stem}-v${request.project.version}-技术打样.zip`;
   }
   check();
   let unrecorded=false;
   if(request.mode!=='project'){
    progress('保存交付版本',95);
    try {await import('./browserProjects').then(store=>store.recordDeliveryVersion(request.project))}
    catch {unrecorded=true}
   }
   check();setJob({request,label:'文件已准备好',progress:100,file,name,unrecorded});
   downloadBlob(file,name);notify(`${request.mode==='print'?'印刷文件包':request.mode==='image'?'数字卡图':'项目包'}已下载`);
  } catch(error){setJob({request,label:controller.signal.aborted?'导出已取消':'导出失败',progress:0,error:controller.signal.aborted?'可以重试相同版本。':(error as Error).message})}
  finally{if(abort.current===controller){abort.current=null;setBusy(false)}}
 };
 if(!open)return null;
 const pixel=(mm:number)=>Math.round((mm+(mode==='print'?project.bleedMm*2:0))*(mode==='print'?printDpi:dpi)/25.4);
 const outputHeight=imageHeight===''?pixel(project.heightMm):+imageHeight;
 const outputWidth=Math.round(outputHeight*project.widthMm/project.heightMm);
 const validPixels=Number.isInteger(outputHeight)&&outputHeight>=64&&outputHeight<=8192&&outputWidth>=1&&outputWidth<=8192&&outputWidth*outputHeight<=32_000_000;
 const background=imageBackground==='view'?stillView?.background??'#ffffff'
  :imageBackground==='dark'?'#262626':imageBackground==='transparent'&&format==='png'?'transparent':'#ffffff';
 const start=()=>void run({mode,project:structuredClone(project),sides:[...sides],dpi:mode==='print'?printDpi:dpi,format,effects,profile,
  includeGrain:grain==='include',applyFactory,imageWidth:outputWidth,imageHeight:outputHeight,imageBackground:background,
  view:useView?stillView:undefined,issues});
 const blockers=issues.filter(issue=>issue.blocking);
 const notes=issues.filter(issue=>!issue.blocking);
 const grainRequired=hasGrain&&grain==='unset';
 const failedCheck=checkReady?checked?.error:undefined;
 const blocked=mode==='print'?((!raster&&service!=='online')||!checkReady||Boolean(failedCheck)||!!blockers.length||grainRequired):mode==='image'&&!validPixels;
 const serviceStatus=browserRuntime
  ? {online:'浏览器印前引擎已就绪',checking:'正在加载浏览器印前引擎',offline:'印前引擎加载失败',outdated:'请刷新后重试'}[service]
  : {online:'本机印前服务在线',checking:'正在连接本机印前服务',offline:'本机印前服务未连接',outdated:'请重启 Prism 以加载新版印前服务'}[service];
 const scope=profileOutputScope(applyFactory?project:{...project,production:undefined});
 const printMessage=(!raster&&service!=='online')?serviceStatus:failedCheck||(!checkReady?'正在预检':null)||
  (blockers.length?`先处理 ${blockers.length} 项阻塞问题`:grainRequired?'请先选择局部闪光的生产处理方式':raster?'按厂规交付主图':'用于打样和印厂核对');
 return <Modal title="导出卡牌" onClose={onClose} drawer>
  <div className="export-context"><strong>{project.name}</strong><span>{project.widthMm} × {project.heightMm} mm · v{project.version}</span></div>
  <div className="export-tabs" aria-label="导出用途">
   {([['image','数字图片',ImagePlus],['print','印刷文件',ScanLine],['project','项目备份',Save]] as const).map(([id,label,Icon])=>
    <button key={id} className={mode===id?'selected':''} aria-pressed={mode===id} onClick={()=>setMode(id)}><Icon size={16}/>{label}</button>)}
  </div>
  <div className="export-layout">
  <div className="export-setup">
   <div className="section-heading">导出设置</div>
   {mode!=='project'&&<label className="field">导出卡面<select value={sides.length===2?'both':sides[0]}
    onChange={e=>setSides(e.target.value==='both'?['front','back']:[e.target.value as SideName])}>
    {!project.singleSided&&<option value="both">正反两面</option>}<option value="front">仅正面</option>{!project.singleSided&&<option value="back">仅背面</option>}
   </select></label>}
   {mode==='print'&&factory&&<label className="field">交稿方式<select value={route} onChange={e=>setRoute(e.target.value as typeof route)}>
    <option value="factory">{factory.product||'当前厂规'}</option><option value="technical">通用技术打样</option>
   </select></label>}
   {mode!=='project'&&<div className="field-grid">
    {mode==='image'?<label className="field">文件格式<select value={format} onChange={e=>setFormat(e.target.value as 'png'|'jpeg')}>
     <option value="png">PNG</option><option value="jpeg">JPEG</option>
    </select></label>:applyFactory?<label className="field">输出配置<input readOnly value={raster?factory!.rasterFormat.toUpperCase():'PDF／TIFF'}/></label>
     :<label className="field">输出配置<select value={profile} onChange={e=>setProfile(e.target.value as PrintProfile)}>
      <option value="standard">技术配置 A</option><option value="alternate">技术配置 B</option>
     </select></label>}
    {mode==='print'&&applyFactory?<label className="field">分辨率<input readOnly value={printDpi+' ppi'}/></label>
     :<label className="field">分辨率<select value={dpi} onChange={e=>{setDpi(+e.target.value);if(mode==='image')setImageHeight('')}}>
      <option value={300}>300 ppi</option><option value={600}>600 ppi</option>
     </select></label>}
   </div>}
   {mode==='print'&&<p className="micro-copy">每面 {pixel(project.widthMm)} × {pixel(project.heightMm)} px · 含出血</p>}
   {mode==='image'&&<>
    {stillView&&<label className="field">渲染视角<select value={useView?'current':'flat'} onChange={event=>setUseView(event.target.value==='current')}>
     <option value="flat">平视</option><option value="current">当前预览视角</option>
    </select></label>}
    <div className="field-grid">
     <label className="field">画面高度（px）<input type="number" min="64" max="8192" step="1" placeholder={String(pixel(project.heightMm))}
      value={imageHeight} onChange={event=>setImageHeight(event.target.value)} aria-invalid={!validPixels}/></label>
     <label className="field">背景<select value={format==='jpeg'&&imageBackground==='transparent'?'white':imageBackground}
      onChange={event=>setImageBackground(event.target.value as typeof imageBackground)}>
      {stillView&&<option value="view">预览背景</option>}<option value="white">白色</option><option value="dark">深灰</option>
      {format==='png'&&<option value="transparent">透明</option>}
     </select></label>
    </div>
    {validPixels?<p className="micro-copy">{outputWidth} × {outputHeight} px</p>:<p className="micro-copy">高度须在 64–8192 px，宽度不得超过 8192 px，总计不超过 3200 万像素。</p>}
    <label className="check-field"><input type="checkbox" checked={effects} onChange={e=>setEffects(e.target.checked)}/>包含材质效果示意</label>
   </>}
   {mode==='print'&&<>
    {!raster&&<div className="print-status" role="status"><span className={`status-dot ${service==='online'?'':'warning'}`}/>
     {serviceStatus}
     {['offline','outdated'].includes(service)&&<button className="text-button" onClick={()=>setServiceCheck(n=>n+1)}>重新检查</button>}
    </div>}
    {hasGrain&&<label className="field">局部闪光的生产处理<select value={grain} onChange={e=>setGrain(e.target.value as typeof grain)}>
     <option value="unset">选择处理方式</option><option value="exclude">从生产彩稿排除</option><option value="include">将图案印为彩色图文</option>
    </select></label>}
   </>}
   {mode==='project'&&<p className="micro-copy">备份包括正反面图层、区域、工艺设置与原素材。可从「我的卡牌」重新打开 .cardproj。</p>}
   {mode==='project'&&deliveryVersions.length>0&&<div className="delivery-version">
    <label className="field">交付版本<select value={selectedVersion??deliveryVersions[0]} onChange={event=>setSelectedVersion(+event.target.value)}>
     {deliveryVersions.map(version=><option key={version} value={version}>v{version}</option>)}
    </select></label>
    <Button disabled={backingUp} onClick={()=>void downloadDeliveryVersion(selectedVersion??deliveryVersions[0])}>下载该版本工程</Button>
   </div>}
  </div>
  <div className="export-details"><div className="section-heading">{mode==='print'?'印前检查':'文件内容'} <small>v{project.version}</small></div>
   {mode==='image'&&<div className="export-thumbnails">{sides.map(face=><div key={face}><CardThumb project={project} side={face} effects={effects}/><span>{face==='front'?'正面':'背面'}</span></div>)}</div>}
   {mode==='project'&&<ul className="file-list"><li><Check size={14}/>可编辑项目文档</li><li><Check size={14}/>图层素材与区域</li><li><Check size={14}/>校验清单</li></ul>}
   {mode==='print'&&<>
    <p className="print-scope"><strong>{scope.title}</strong><span>{scope.description}</span></p>
    <div className="production-spec"><div><b>生产工艺单 · {order.length} 道</b><small>{DIE_SHAPES[project.production?.dieShape??'card']}</small></div>
     <div className="inline-actions"><Button onClick={()=>onPlateProof(applyFactory)}>分版核稿</Button><Button onClick={onProduction}>查看工艺顺序</Button></div></div>
    <div className="preflight">
     {failedCheck?<div role="status">{failedCheck} <button className="text-button" onClick={()=>setServiceCheck(n=>n+1)}>重新预检</button></div>
     :!checkReady?<div role="status">正在预检</div>
     :issues.length ? <>
      <p className="preflight-count">{blockers.length} 项需修正 · {notes.length} 项提醒</p>
      {[...blockers,...notes].map((issue,index)=><button key={index} className={issue.blocking?'blocking':''} onClick={()=>onLocate(issue.target)}>
       <AlertTriangle size={15}/><span>{issue.text}</span><ArrowUpRight size={12}/>
      </button>)}
     </> : <span className="preflight-good"><CheckCircle2 size={16}/>当前设计通过基础规则检查</span>}
    </div>
    <div className="section-heading export-file-heading">输出文件</div>
    {raster?<ul className="file-list">
     {sides.map(face=><li key={face}>{face==='front'?'正面主图':'背面主图'} <small>{face}.{factory!.rasterFormat==='jpeg'?'jpg':'png'}</small></li>)}
     <li>导出规格及预检清单</li>
    </ul>:<ul className="file-list"><li>CMYK 彩稿 <small>artwork.pdf</small></li><li>彩稿与专色合版 <small>composite.pdf</small></li>
     {allPlates.map(key=><li key={key}>{PLATE_LABELS[key]} <small>{names[key]} · PDF / TIFF</small></li>)}
     <li>独立工艺层 PDF / TIFF <small>layers/</small></li><li>矢量刀模 <small>die.pdf / die.svg</small></li><li>预检报告、排序工艺单、校验清单</li>
    </ul>}
   </>}
  </div></div>
  {job&&<div className="job-status" aria-live="polite"><div><strong>{job.label}</strong><span>项目 v{job.request.project.version}{job.request.project.version!==project.version?' · 历史快照':''}</span>{job.error&&<p>{job.error}</p>}</div>{busy?<><progress value={job.progress} max={100}/><Button onClick={()=>abort.current?.abort()}>取消任务</Button></>:job.file?<Button onClick={()=>downloadBlob(job.file!,job.name!)}>再次下载</Button>:job.error?<Button onClick={()=>void run(job.request)}>重试此版本</Button>:null}</div>}
  {job?.unrecorded&&<div className="job-status"><div>无法保存交付版本到浏览器</div><Button disabled={backingUp} onClick={()=>void downloadDeliveryVersion(job.request.project.version,job.request.project)}>下载该版本工程</Button></div>}
  <div className="modal-footer"><span>{busy?'关闭窗口后任务继续，回来可查看进度。':mode==='print'?printMessage:mode==='project'?'可再次打开并继续编辑':'文件保存到你的设备'}</span><Button className="primary" disabled={busy||blocked} onClick={start}>{busy?<Loader2 className="spin" size={16}/>:<Download size={16}/>} {mode==='image'?'下载图片':mode==='print'?(raster?'生成交稿图片':'生成技术打样包'):'下载项目包'}</Button></div>
 </Modal>;
}
