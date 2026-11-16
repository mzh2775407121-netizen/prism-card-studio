import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, ArrowLeft, Archive, Pencil, Layers3, ChevronDown, ChevronLeft, ChevronRight, Plus, ImagePlus, Type, Square, Circle, MousePointer2, Hand, Paintbrush, Eraser, Undo2, Redo2, Eye, EyeOff, Lock, Unlock, GripVertical, Copy, Trash2, Download, Upload, X, Check, ArrowUpRight, SlidersHorizontal, Sparkles, ScanLine, RotateCcw, ZoomIn, ZoomOut, Maximize, FolderOpen, BookOpen, Settings2, MoveHorizontal, RefreshCw, AlertTriangle, CheckCircle2, Loader2, Save, PanelLeftClose, PanelRightClose, Keyboard, Search, CheckSquare, FlipHorizontal, Pentagon } from 'lucide-react';
import JSZip from 'jszip';
import EditorCanvas, { ZOOM_STEP, type CanvasNavigation } from './EditorCanvas';
import { PrintGuideLegend, PrintCornerPreview, PRINT_SAFE_MARGIN_MM, isOutsidePrintSafeArea } from './PrintGuides';
import CropEditor, { CroppedImage } from './CropEditor';
import { STOCKS, StockPicker, defaultStockReflection, CreateLayer, ProductionStack, MaskContentEditor, imageMaskNode, type LayerDraft } from './ProductionControls';
import AlbumPreview from './AlbumPreview';
import { createProject, uid, TEMPLATE_NAMES, PROCESS_LABELS, STOCK_REFLECTIONS, FLASH_STYLES, getFlashStyle, getStockReflection, getCardCornerRadiusMm, plateFor, processKind, processLayerEnabled, type Project, type SideName, type CardSide, type CardNode, type Region, type Effect, type EffectType, type TemplateName, type ImageCrop, type StockReflection, type FlashStyle } from './model';
import { renderCard } from './render';
import { exportProject, importProject, downloadBlob, readImage } from './io';
import { archiveProject, createStoredProject, listProjects, openLibrary, readProject, type ProjectSummary, type StoredProject } from './projects';
import { useProjectSave } from './useProjectSave';
import './project-library.css';

const MATERIALS = STOCKS;
const processName=(effect:Effect)=>PROCESS_LABELS[processKind(effect)];
function Button({children,title,onClick,active=false,disabled=false,className=''}:{children:ReactNode,title?:string,onClick?:()=>void,active?:boolean,disabled?:boolean,className?:string}){return <button type="button" title={title} aria-label={title} aria-pressed={active||undefined} disabled={disabled} className={`button ${active?'active':''} ${className}`} onClick={onClick}>{children}</button>}
function IconButton({icon:Icon,...props}:{icon:typeof Plus,title:string,onClick:()=>void,active?:boolean,disabled?:boolean}){return <Button {...props} className="icon-button"><Icon size={17} strokeWidth={1.65}/></Button>}
function Modal({title,children,onClose,wide=false,drawer=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean;drawer?:boolean}) {
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
 return <dialog ref={ref} className={`modal ${wide?'wide':''} ${drawer?'drawer':''}`} aria-label={title}
   onCancel={event=>{event.preventDefault();onClose()}}
   onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div className="modal-content">
   <div className="modal-head"><h2>{title}</h2><IconButton icon={X} title="关闭" onClick={onClose}/></div>
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

export default function App() {
 const [items,setItems]=useState<ProjectSummary[]>([]);
 const [entry,setEntry]=useState<{record:StoredProject;key:string;preview:boolean}|null>(null);
 const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 const [notice,setNotice]=useState('');
 const [failure,setFailure]=useState('');
 const [filter,setFilter]=useState<'active'|'archived'>('active');
 const [search,setSearch]=useState('');
 const [newOpen,setNewOpen]=useState(false);
 const [operation,setOperation]=useState('');
 const [archiveTarget,setArchiveTarget]=useState<ProjectSummary|null>(null);
 const fileInput=useRef<HTMLInputElement>(null);
 const opening=useRef(false);

 const enter=useCallback((record:StoredProject,preview=false)=>{
  if(record.archivedAt!==null)throw new Error('此卡牌已归档，恢复后即可编辑。');
  const params=new URLSearchParams({project:record.id});
  if(preview)params.set('preview','1');
  window.history.replaceState(null,'','?'+params);
  setEntry({record,key:uid(),preview});
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
  setEntry(null);setFailure('');setFilter('active');
  void refresh();
 };
 const perform=async(label:string,action:()=>Promise<void>)=>{
  if(opening.current)return;
  opening.current=true;setOperation(label);setFailure('');
  try {await action()}
  catch(error){setFailure((error as Error).message)}
  finally{opening.current=false;setOperation('')}
 };
 const open=(item:ProjectSummary)=>void perform('正在打开卡牌…',async()=>enter(await readProject(item.id)));
 const importFile=(file:File)=>void perform('正在读取项目包…',async()=>{
  const project=await importProject(file);
  enter(await createStoredProject({...project,id:uid()}));
 });
 const duplicate=(item:ProjectSummary)=>void perform('正在复制卡牌…',async()=>{
  const {project}=await readProject(item.id);
  enter(await createStoredProject({...project,id:uid(),name:(project.name.slice(0,494)+' 副本'),version:1}));
 });
 const changeArchived=(item:ProjectSummary,archived:boolean)=>void perform(archived?'正在归档…':'正在恢复…',async()=>{
  await archiveProject(item,archived);
  setArchiveTarget(null);
  setItems(await listProjects());
 });
 if(entry)return <Editor key={entry.key} record={entry.record} initialPreview={entry.preview}
  onBack={backToLibrary} onOpen={enter}/>;

 const filtered=items.filter(item=>(item.archivedAt!==null)===(filter==='archived'));
 const visible=filtered.filter(item=>item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
 return <div className="project-library">
  <header className="library-header">
   <span className="brand"><Layers3 size={24} strokeWidth={1.5}/><strong>Prism</strong></span>
   <span className="library-storage"><span className={`status-dot ${status==='ready'?'':'warning'}`}/>{status==='ready'?'本机项目库':status==='loading'?'正在连接项目库':'项目库未连接'}</span>
  </header>
  <main className="library-main">
   <div className="library-title">
    <h1>我的卡牌</h1>
    <div className="library-actions">
     <Button disabled={status!=='ready'||!!operation} onClick={()=>fileInput.current?.click()}><Upload size={16}/>导入项目包</Button>
     <Button className="primary" disabled={status!=='ready'||!!operation} onClick={()=>{setFailure('');setNewOpen(true)}}><Plus size={17}/>新建卡牌</Button>
    </div>
   </div>
   <input ref={fileInput} type="file" accept=".cardproj" hidden onChange={event=>{
    const file=event.target.files?.[0];event.target.value='';if(file)importFile(file);
   }}/>
   {(notice||failure||operation)&&<div className={`library-message ${failure?'library-error':''}`} role={failure?'alert':'status'}>
    <span>{failure||operation||notice}</span>
    {(status==='error'||notice&&!failure&&!operation)&&<Button onClick={()=>void refresh()}>重试</Button>}
   </div>}
   <section className="library-list" aria-label="卡牌项目">
    <div className="library-list-tools">
     <div className="library-filters">
      <Button active={filter==='active'} onClick={()=>{setFilter('active');setSearch('')}}>全部项目</Button>
      <Button active={filter==='archived'} onClick={()=>{setFilter('archived');setSearch('')}}>已归档</Button>
     </div>
     <label className="search-box"><Search size={15}/><input aria-label="搜索卡牌" placeholder="搜索卡牌" value={search} onChange={event=>setSearch(event.target.value)}/></label>
    </div>
    {status==='loading'?<p className="library-empty" role="status">正在读取项目…</p>
     :status==='error'?<p className="library-empty">启动本机 Prism 服务后重试。</p>
     :visible.length?<ul>
      {visible.map(item=><li className="library-row" key={item.id}>
       <button className="library-open" disabled={!!operation||item.archivedAt!==null} onClick={()=>open(item)}>
        <span className="library-card-icon"><Layers3 size={19}/></span>
        <span><strong>{item.name}</strong><small>{item.widthMm} × {item.heightMm} mm</small></span>
       </button>
       <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric',year:'numeric'})}</time>
       <div className="library-row-actions">
        {item.archivedAt!==null
         ?<Button disabled={!!operation} onClick={()=>changeArchived(item,false)}>恢复</Button>
         :<>
          <IconButton icon={Copy} title={`复制 ${item.name}`} disabled={!!operation} onClick={()=>duplicate(item)}/>
          <IconButton icon={Archive} title={`归档 ${item.name}`} disabled={!!operation} onClick={()=>setArchiveTarget(item)}/>
          <Button className="library-open-button" disabled={!!operation} onClick={()=>open(item)}>打开<ChevronRight size={14}/></Button>
         </>}
       </div>
      </li>)}
     </ul>:<div className="library-empty">
      <strong>{search?'没有匹配的卡牌':filter==='archived'?'没有归档项目':'还没有卡牌'}</strong>
      <p>{search?'试试卡牌名称中的其他关键词。':filter==='archived'?'归档的项目可以在这里恢复。':'从模板新建一张卡，或打开已有的 .cardproj 项目包。'}</p>
      {search&&<Button onClick={()=>setSearch('')}>清除搜索</Button>}
     </div>}
   </section>
  </main>
  {newOpen&&<NewProject pending={operation!==''} error={failure} onClose={()=>{if(!operation){setFailure('');setNewOpen(false)}}} onCreate={project=>void perform('正在创建卡牌…',async()=>{
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
 const [side,setSide]=useState<SideName>('front'),[selectedId,setSelected]=useState<string|null>(null);
 const [leftTab,setLeftTab]=useState<'stack'|'layers'|'assets'|'regions'|'reference'>('stack'),[rightTab,setRightTab]=useState<'effects'|'design'|'material'>('design');
 const [tool,setTool]=useState<'select'|'hand'|'brush'|'eraser'|'geometry'>('select'),[zoom,setZoom]=useState(1),[showGuides,setGuides]=useState(true),[plate,setPlate]=useState<string|null>(null);
 const navigationRef=useRef<CanvasNavigation>(null);
 const [spaceHeld,setSpaceHeld]=useState(false);
 const [regionMulti,setRegionMulti]=useState<string[]>([]);
 const [multi,setMulti]=useState<string[]>([]);
 const [shapeKind,setShapeKind]=useState<'paint'|'rect'|'ellipse'|'polygon'>('paint');
 const [showEffectMask,setShowEffectMask]=useState(false);
 const [layerPlate,setLayerPlate]=useState<string>();
 const [initialLayerKind,setInitialLayerKind]=useState<LayerDraft['kind']>('artwork');
 const [pendingLayer,setPendingLayer]=useState<LayerDraft|null>(null);
 const typedUpload=useRef<{name?:string;clipRegionId?:string}|undefined>(undefined);
 const [replaceCrop,setReplaceCrop]=useState(true);
 const [layerQuery,setLayerQuery]=useState('');
 const [referenceOpacity,setReferenceOpacity]=useState(0);
 const [selectedEffect,setSelectedEffect]=useState<string|null>(null),[regionId,setRegionId]=useState<string|null>(null),[regionDraft,setRegionDraft]=useState<Region|null>(null),[brushSize,setBrushSize]=useState(32);
 const [modal,setModal]=useState<'rename'|'preview'|'help'|'size'|'export'|'crop'|'newLayer'|'maskContent'|null>(initialPreview?'preview':null);
 const [toast,setToast]=useState('');
 const [leaving,setLeaving]=useState(false);
 const [readingImages,setReadingImages]=useState(0);
 const [imageIssue,setImageIssue]=useState<{message:string;replacement:string|null}|null>(null);
 const [dragged,setDragged]=useState<string|null>(null),[dropAt,setDropAt]=useState<string|null>(null);
 const [collapsedLeft,setCollapsedLeft]=useState(false),[collapsedRight,setCollapsedRight]=useState(false);
 const [confirmDelete,setConfirmDelete]=useState<CardNode|null>(null);
 const history=useRef<Project[]>([]),future=useRef<Project[]>([]),current=useRef(project);
 const fileInput=useRef<HTMLInputElement>(null),replaceId=useRef<string|null>(null);
 const whiteInput=useRef<HTMLInputElement>(null);
 const whiteUploadTarget=useRef<{id:string;face:SideName}|null>(null);
 const referenceInput=useRef<HTMLInputElement>(null);
 const {state:save,queueSave,saveNow}=useProjectSave(record,current);
 const saveError=save.status==='error'||save.status==='conflict';
 const saveState=save.status==='saved'?'已保存到本机':save.status==='saving'?'正在保存…':save.status==='conflict'?'有更新冲突':'保存失败';
 const active=project[side],selected=active.nodes.find(n=>n.id===selectedId),effect=active.effects.find(e=>e.id===selectedEffect);
 const artwork=active.nodes.find(n=>n.visible&&n.type==='image'&&n.name==='主视觉')
  ||[...active.nodes].reverse().find(n=>n.visible&&n.type==='image');
 const headline=active.nodes.find(n=>n.visible&&n.type==='text'&&(n.name==='卡牌名称'||n.name==='背面标题'))
  ||active.nodes.find(n=>n.visible&&n.type==='text');
 const targetRegion=active.regions.find(r=>r.id===regionId);
 const maskHighlight=rightTab==='effects'&&!!targetRegion&&!regionDraft&&!plate&&(selectedEffect?showEffectMask:leftTab==='regions');
 const hasModeNotice=Boolean(regionDraft||plate||maskHighlight||(active.reference&&referenceOpacity>0));
 const foundLayers=[...active.nodes].reverse().filter(node =>
  node.name.toLocaleLowerCase().includes(layerQuery.trim().toLocaleLowerCase()));
 const notify=useCallback((message:string)=>setToast(message),[]);
 useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),3600);return()=>clearTimeout(t)},[toast]);
 const cardBoundsRef=useRef<HTMLDivElement>(null);
 const activeFace=useRef(side);
 const coalesce=useRef<{key:string,time:number}|null>(null);
 const commit=useCallback((next:Project,key?:string)=>{
  const now=Date.now();
  if(!key||coalesce.current?.key!==key||now-coalesce.current.time>700){
   history.current.push(current.current);
   history.current=history.current.slice(-60);
  }
  coalesce.current=key?{key,time:now}:null;
  future.current=[];
  const updated={...next,version:current.current.version+1,updatedAt:now};
  current.current=updated;
  setProject(updated);
  queueSave();
 },[queueSave]);
 const changeSide=useCallback((next:CardSide)=>commit({...current.current,[side]:next}),[commit,side]);
 const patchNode=(patch:Partial<CardNode>)=>{
  if(!selectedId||selected?.locked)return;
  const doc=current.current;
  const face=doc[side];
  commit({...doc,[side]:{...face,nodes:face.nodes.map(n=>n.id===selectedId?{...n,...patch}:n)}},selectedId+Object.keys(patch).join());
 };
 const alignNode=(axis:'x'|'y',fraction:number)=>{
  if(!selected||selected.locked)return;
  const angle=selected.rotation*Math.PI/180;
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const corners=[[0,0],[selected.width,0],[0,selected.height],[selected.width,selected.height]];
  const coordinates=corners.map(([x,y])=>axis==='x'?x*cos-y*sin:x*sin+y*cos);
  const low=Math.min(...coordinates),high=Math.max(...coordinates);
  const available=(axis==='x'?project.widthMm:project.heightMm)*10;
  patchNode({[axis]:Math.round((available-high+low)*fraction-low)});
 };
 const patchEffect=(patch:Partial<Effect>)=>{if(!selectedEffect)return;changeSide({...active,effects:active.effects.map(e=>e.id===selectedEffect?{...e,...patch}:e)})};
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
   onOpen(await createStoredProject({...snapshot,id:uid(),name:snapshot.name.slice(0,494)+' 副本',version:1}));
  } catch(error) {notify((error as Error).message);setLeaving(false)}
 };
 const deleteNode=(node:CardNode,removeEffects:boolean)=>{const removed=new Set(active.regions.filter(r=>r.nodeId===node.id).map(r=>r.id));for(const r of active.regions)if(r.sources?.some(id=>removed.has(id)))removed.add(r.id);changeSide({...active,nodes:active.nodes.filter(n=>n.id!==node.id),regions:removeEffects?active.regions.filter(r=>!removed.has(r.id)):active.regions.map(r=>r.nodeId===node.id?{...r,binding:'fixed',nodeId:undefined,snapshot:structuredClone(r.snapshot||node),bounds:r.bounds}:r),effects:removeEffects?active.effects.filter(e=>!removed.has(e.regionId)):active.effects});setSelected(null);setConfirmDelete(null)};
 const requestDelete=()=>{if(!selected||selected.locked)return;if(active.regions.some(r=>r.nodeId===selected.id))setConfirmDelete(selected);else deleteNode(selected,true)};
 const duplicateNode=()=>{if(!selected)return;const n={...structuredClone(selected),id:uid(),name:selected.name+' 副本',x:selected.x+15,y:selected.y+15,locked:false};changeSide({...active,nodes:[...active.nodes,n]});setSelected(n.id)};
 useEffect(()=>{
  const handler=(e:KeyboardEvent)=>{
   if(modal||confirmDelete||leaving||e.defaultPrevented||e.isComposing)return;
   const mod=e.metaKey||e.ctrlKey,key=e.key.toLowerCase();
   const target=e.target instanceof HTMLElement?e.target:null;
   if(mod&&key==='s'){e.preventDefault();void saveNow();return}
   if(target?.closest('input,textarea,select,[contenteditable]'))return;
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
   if(mod&&key==='z'){e.preventDefault();e.shiftKey?redo():undo()}
   else if(mod&&key==='d'){e.preventDefault();duplicateNode()}
   else if(key==='delete'||key==='backspace'){e.preventDefault();requestDelete()}
   else if(key==='escape'){setSelected(null);setMulti([]);setRegionDraft(null);setPendingLayer(null);setTool('select')}
   else if(!mod&&key==='v')setTool('select');
   else if(!mod&&key==='h')setTool('hand');
   else if(e.key.startsWith('Arrow')&&selected&&!selected.locked){
    e.preventDefault();const delta=e.shiftKey?10:1;
    patchNode({x:selected.x+(e.key==='ArrowRight'?delta:e.key==='ArrowLeft'?-delta:0),y:selected.y+(e.key==='ArrowDown'?delta:e.key==='ArrowUp'?-delta:0)});
   }
  };
  window.addEventListener('keydown',handler);
  return()=>window.removeEventListener('keydown',handler);
 },[modal,selected,project,side,confirmDelete,undo,redo,leaving,regionDraft,saveNow]);
 useEffect(()=>{
  const release=()=>setSpaceHeld(false);
  const onKeyUp=(event:KeyboardEvent)=>{if(event.code==='Space')release()};
  window.addEventListener('keyup',onKeyUp);
  window.addEventListener('blur',release);
  return()=>{window.removeEventListener('keyup',onKeyUp);window.removeEventListener('blur',release)};
 },[]);
 useEffect(()=>{if(modal||confirmDelete||leaving)setSpaceHeld(false)},[modal,confirmDelete,leaving]);
 const addNode=(type:CardNode['type'])=>{if(regionDraft||leaving)return;const node:CardNode={id:uid(),name:type==='text'?'新文字':type==='rect'?'矩形':type==='polygon'?'多边形':'椭圆',type,x:150,y:350,width:330,height:type==='text'?70:180,rotation:0,opacity:1,visible:true,locked:false,fill:type==='text'?'#f5edd8':'#d2b87e',text:type==='text'?'写下你的故事':undefined,fontSize:36,fontFamily:'Work Sans, PingFang SC, sans-serif'};changeSide({...active,nodes:[...active.nodes,node]});setSelected(node.id);setRightTab('design');setTool('select')};
 const chooseImage=(replacement:string|null=null)=>{
  if(leaving||regionDraft)return;
  replaceId.current=replacement;typedUpload.current=undefined;
  fileInput.current?.click();
 };
 const editText=(id:string)=>{
  if(regionDraft||leaving)return;
  setSelected(id);setRightTab('design');setCollapsedRight(false);setLeftTab('layers');setTool('select');setPlate(null);setRegionId(null);setSelectedEffect(null);
  requestAnimationFrame(()=>document.getElementById('text-content')?.focus());
 };
 const uploadImage=async(file:File,replace:string|null=null, typed?:{name?:string;clipRegionId?:string})=>{
  const projectId=current.current.id;
  if(leaving||regionDraft)return;
  setImageIssue(null);setReadingImages(count=>count+1);
  try {
   const image=await readImage(file);
   const doc=current.current;
   if(doc.id!==projectId){notify('已切换项目，请重新导入图片');return}
   const face=doc[side];
   if(replace){
    if(!face.nodes.some(n=>n.id===replace)){notify('图片图层已移除，请重新选择');return}
    commit({...doc,[side]:{...face,nodes:face.nodes.map(n=>n.id===replace?{...n,src:image.src,crop:replaceCrop&&n.crop&&(n.crop.space==='source'||(n.crop.width<=1&&n.crop.height<=1))?n.crop:undefined}:n)}});
    if(activeFace.current!==side){notify('图片已替换到'+(side==='front'?'正面':'背面'));return}
    setSelected(replace);setLeftTab('layers');setRightTab('design');setCollapsedRight(false);setTool('select');setPlate(null);setRegionId(null);setSelectedEffect(null);
    notify('已替换图片，保留当前布局');
    return;
   }
   const scale=Math.min(doc.widthMm*8.8/image.width,doc.heightMm*8.8/image.height,1);
   const width=image.width*scale,height=image.height*scale;
   const node:CardNode={id:uid(),name:typed?.name||file.name.replace(/\.[^.]+$/,''),clipRegionId:typed?.clipRegionId,type:'image',x:(doc.widthMm*10-width)/2,y:(doc.heightMm*10-height)/2,width,height,rotation:0,opacity:1,visible:true,locked:false,fill:'#fff',src:image.src};
   commit({...doc,[side]:{...face,nodes:[...face.nodes,node]}});
   if(activeFace.current!==side){notify('图片已加入'+(side==='front'?'正面':'背面'));return}
   setSelected(node.id);setLeftTab('layers');setRightTab('design');setCollapsedRight(false);setTool('select');setPlate(null);setRegionId(null);setSelectedEffect(null);notify('图片已加入卡面');
  } catch(error){if(current.current.id===projectId){setCollapsedLeft(false);setImageIssue({message:`「${file.name}」${(error as Error).message}`,replacement:replace})}}
  finally {setReadingImages(count=>count-1)}
 };
 const uploadReference=async(file:File) => {
  if(leaving||regionDraft)return;
  setReadingImages(count=>count+1);
  try {
   const image=await readImage(file);
   const doc=current.current;
   commit({...doc,[side]:{...doc[side],reference:{src:image.src,name:file.name.slice(0,300)}}});
   if(activeFace.current===side)setReferenceOpacity(.5);
   notify('已加入参考图');
  } catch(error){notify((error as Error).message)}
  finally {setReadingImages(count=>count-1)}
 };
 const applyCrop=(crop:ImageCrop)=>{
  if(selected?.type!=='image'||selected.locked)return;
  patchNode({crop});
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
 const chooseProcess=(entry:Effect)=>{
  setSelectedEffect(entry.id);setRegionId(entry.regionId);setSelected(null);setRightTab('effects');
  setCollapsedRight(false);setPlate(null);setLayerPlate(undefined);setShowEffectMask(false);
 };
 const showNewLayer=(kind:LayerDraft['kind']='artwork')=>{
  setInitialLayerKind(kind);setModal('newLayer');
 };
 const finishTypedLayer=(layer:LayerDraft,area:Region|undefined,face:CardSide)=>{
  setModal(null);setPendingLayer(null);setPlate(null);setLayerPlate(undefined);setTool('select');
  if(layer.kind==='artwork'){
   if(layer.content==='image'){
    if(face!==active) changeSide(face);
    typedUpload.current={name:layer.name||undefined,clipRegionId:area?.id};replaceId.current=null;
    // A file dialog cannot be opened while the parent dialog keeps the page inert in all browsers.
    requestAnimationFrame(()=>fileInput.current?.click());
    return;
   }
   const b=area?.bounds;
   const width=b?.width||project.widthMm*7,height=b?.height||(layer.content==='text'?100:project.heightMm*4);
   const node:CardNode={id:uid(),type:layer.content,name:layer.name||(layer.content==='text'?'彩稿文字':'彩稿形状'),
    x:b?.x??(project.widthMm*10-width)/2,y:b?.y??(project.heightMm*10-height)/2,width,height,rotation:0,
    opacity:1,visible:true,locked:false,fill:layer.content==='text'?'#262d28':'#d5b778',clipRegionId:area?.id,
    ...(layer.content==='text'?{text:layer.name||'新文字',fontSize:Math.max(10,Math.min(38,height*.42)),fontStyle:'bold'}:{})};
   changeSide({...face,nodes:[...face.nodes,node]});
   setSelected(node.id);setSelectedEffect(null);setRegionId(null);setRightTab('design');setLeftTab('layers');setCollapsedRight(false);
   return;
  }
  const target=area||face.regions.find(region=>region.kind==='full'&&!region.inverted&&!region.strokes.length)
   ||{id:uid(),kind:'full',binding:'fixed',inverted:false,strokes:[],name:'整张卡面'} satisfies Region;
  const type={reflection:'holo',white:'white',foil:'gold',varnish:'gloss'} as const;
  const entry:Effect={id:uid(),process:layer.kind,type:type[layer.kind],name:layer.name||PROCESS_LABELS[layer.kind],
   regionId:target.id,visible:true,opacity:layer.kind==='white'?1:.45,angle:45,
   ...(layer.kind==='reflection'?{flashStyle:'geometric' as const}:{}),...(layer.contentMask?{maskContent:[]}:{})};
  changeSide({...face,regions:face.regions.some(region=>region.id===target.id)?face.regions:[...face.regions,target],
   effects:[...face.effects,entry]});
  setLeftTab('stack');chooseProcess(entry);
  if(layer.contentMask)setModal('maskContent');
 };
 const createTypedLayer=(layer:LayerDraft)=>{
  if(layer.area===':contour'&&selected){
   const area=active.regions.find(region=>region.kind==='node'&&region.nodeId===selected.id&&region.binding==='follow')
    ||{id:uid(),name:selected.name+'轮廓',kind:'node',nodeId:selected.id,binding:'follow',inverted:false,strokes:[]} satisfies Region;
   const next=active.regions.includes(area)?active:{...active,regions:[...active.regions,area]};
   finishTypedLayer(layer,area,next);
   return;
  }
  if(layer.area.startsWith(':')){
   setPendingLayer(layer);setModal(null);
   startRegion(undefined,layer.area.slice(1) as typeof shapeKind);
   return;
  }
  finishTypedLayer(layer,active.regions.find(region=>region.id===layer.area),active);
 };
 const startRegion=(region?:Region,kind:typeof shapeKind='paint')=>{
  if(regionDraft||readingImages){notify(regionDraft?'请先完成或取消当前区域':'正在读取图片，请稍候');return}
  const label={paint:'手绘',rect:'矩形',ellipse:'椭圆',polygon:'多边形'}[kind];
  const draft:Region=region||{id:uid(),name:label+'区域 '+(active.regions.filter(r=>r.kind===kind).length+1),kind,binding:'fixed',inverted:false,strokes:[]};
  const geometric=['rect','ellipse','polygon'].includes(draft.kind);
  setRegionDraft(structuredClone(draft));setRegionId(draft.id);setLeftTab('regions');setCollapsedLeft(false);setTool(geometric?'geometry':'brush');setPlate(null);
 };
 const applyRegion=()=>{
  if(!regionDraft)return;
  if((regionDraft.kind==='polygon'&&(regionDraft.points?.length||0)<6)||
     (['rect','ellipse'].includes(regionDraft.kind)&&!regionDraft.bounds)||
     (regionDraft.kind==='paint'&&!regionDraft.strokes.length)){
   notify('先在卡面上绘制一个区域');return;
  }
  const exists=active.regions.some(r=>r.id===regionDraft.id);
  const next={...active,regions:exists?active.regions.map(r=>r.id===regionDraft.id?regionDraft:r):[...active.regions,regionDraft]};
  if(pendingLayer)finishTypedLayer(pendingLayer,regionDraft,next);
  else {changeSide(next);setRegionId(regionDraft.id);setTool('select');notify('作用区域已保存，可用于多个效果');}
  setRegionDraft(null);
 };
 const groupLayers=()=>{
  const ids=multi.filter(id=>active.nodes.some(n=>n.id===id&&!n.locked));
  if(ids.length<2)return;
  const groupId=uid();
  changeSide({...active,nodes:active.nodes.map(n=>ids.includes(n.id)?{...n,groupId}:n)});
  setMulti([]);notify('图层已分组，可以一起拖动');
 };
 const ungroupLayers=()=>{
  if(!selected?.groupId)return;
  changeSide({...active,nodes:active.nodes.map(n=>n.groupId===selected.groupId?{...n,groupId:undefined}:n)});
  notify('已解除分组');
 };
 const displayedProject=regionDraft?{...project,[side]:{...active,regions:active.regions.some(r=>r.id===regionDraft.id)?active.regions.map(r=>r.id===regionDraft.id?regionDraft:r):[...active.regions,regionDraft]}}:project;
 const closeModal=useCallback(()=>setModal(null),[]);
 const switchSide=(face:SideName)=>{
  if(face===side)return;
  activeFace.current=face;setSide(face);setSelected(null);setSelectedEffect(null);setRegionId(null);setRegionMulti([]);setMulti([]);setTool('select');setImageIssue(null);setReferenceOpacity(0);setLayerQuery('');setLayerPlate(undefined);
 };
 const reorder=(target:string)=>{if(!dragged||dragged===target)return;const nodes=[...active.nodes];const from=nodes.findIndex(n=>n.id===dragged),to=nodes.findIndex(n=>n.id===target);if(from<0||to<0)return;const [moved]=nodes.splice(from,1);nodes.splice(to,0,moved);changeSide({...active,nodes});setDragged(null);setDropAt(null)};
 const titleIcon=(n:CardNode)=>n.type==='text'?<Type size={15}/>:n.type==='image'?<ImagePlus size={15}/>:n.type==='ellipse'?<Circle size={15}/>:n.type==='polygon'?<Pentagon size={15}/>:<Square size={15}/>;
 return <div className={`studio ${collapsedLeft?'left-collapsed':''} ${collapsedRight?'right-collapsed':''}`}>
  <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];const replacement=replaceId.current;replaceId.current=null;const typed=typedUpload.current;typedUpload.current=undefined;if(f)void uploadImage(f,replacement,typed);e.target.value=''}}/>
  <input ref={whiteInput} hidden type="file" accept="image/png" onChange={event=>{
   const file=event.currentTarget.files?.[0],target=whiteUploadTarget.current;
   event.currentTarget.value='';whiteUploadTarget.current=null;
   if(file&&target)void uploadWhitePNG(file,target);
  }}/>
  <input ref={referenceInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{
   const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void uploadReference(file);
  }}/>
  <header className="topbar">
   <button className="brand editor-back" onClick={()=>void leave()} disabled={leaving||!!regionDraft||readingImages>0} title="返回项目库"><ArrowLeft size={17}/><span>项目库</span></button>
   <div className="header-divider"/>
   <button className="project-name" onClick={()=>setModal('rename')} title="重命名项目" aria-label="重命名项目" disabled={!!regionDraft||leaving}><span>{project.name}</span><Pencil size={13}/></button>
   <span className={`save-state ${saveError?'error':''}`} role="status">
    {save.status==='saving'?<Loader2 size={12} className="spin"/>:saveError?<AlertTriangle size={12}/>:<Check size={12}/>}
    <span>{saveState}</span>
   </span>
   <div className="top-actions">
    <IconButton icon={Undo2} title="撤销 ⌘Z" onClick={undo} disabled={!!regionDraft||leaving||!history.current.length}/>
    <IconButton icon={Redo2} title="重做 ⇧⌘Z" onClick={redo} disabled={!!regionDraft||leaving||!future.current.length}/>
    <div className="header-divider"/>
    <Button onClick={()=>setModal('preview')} disabled={leaving||!!regionDraft||readingImages>0}><Eye size={16}/>成品预览</Button>
    <Button className="primary" onClick={()=>setModal('export')} disabled={leaving||!!regionDraft||readingImages>0}><Download size={15}/>导出</Button>
   </div>
  </header>
  <aside className="left-panel" inert={leaving}><div className="panel-toolbar"><span>生产图层</span><IconButton icon={PanelLeftClose} title="收起左侧面板" onClick={()=>setCollapsedLeft(true)}/></div><div className="tabs production-tabs"><button className={leftTab==='stack'?'selected':''} disabled={!!regionDraft} onClick={()=>setLeftTab('stack')}>叠层</button><button className={leftTab==='layers'?'selected':''} disabled={!!regionDraft} onClick={()=>setLeftTab('layers')}>图文</button><button className={leftTab==='assets'?'selected':''} disabled={!!regionDraft} onClick={()=>setLeftTab('assets')}>素材</button><button className={leftTab==='regions'?'selected':''} onClick={()=>setLeftTab('regions')}>区域</button><button className={leftTab==='reference'?'selected':''} disabled={!!regionDraft} onClick={()=>setLeftTab('reference')}>参考</button></div>
   <div className="left-scroll">
   {leftTab==='stack'&&<ProductionStack project={project} side={active} selected={selectedEffect} onSelect={chooseProcess}
    onToggle={entry=>changeSide({...active,effects:active.effects.map(item=>item.id===entry.id?{...item,visible:!item.visible}:item)})}
    onAdd={()=>showNewLayer()} onArtwork={()=>{setLeftTab('layers');setSelectedEffect(null);setRegionId(null);setRightTab('design')}} onStock={()=>{setSelectedEffect(null);setRegionId(null);setRightTab('material')}}/>}
    {leftTab==='layers'&&<div className="card-content-actions">
     <Button onClick={()=>chooseImage(artwork?.id)}>{artwork?<RefreshCw size={14}/>:<ImagePlus size={14}/>}<span>{artwork?'替换主图':'上传图片'}</span></Button>
     <Button onClick={()=>headline?editText(headline.id):addNode('text')}><Type size={14}/><span>{headline?'编辑卡名':'添加文字'}</span></Button>
    </div>}
    {imageIssue&&<div className="image-issue" role="alert">
     <p>{imageIssue.message}</p>
     <button className="text-button" onClick={()=>chooseImage(imageIssue.replacement)}>重新选择</button>
     <button className="text-button" onClick={()=>setImageIssue(null)}>关闭提示</button>
    </div>}
    {leftTab==='layers'&&<><div className="section-heading"><span>{side==='front'?'正面':'背面'}图层 <small>{active.nodes.length}</small></span><IconButton icon={Plus} title="新建图层" onClick={()=>showNewLayer()}/></div>{active.nodes.length>0&&<label className="layer-search"><Search size={14}/><input type="search" aria-label="搜索图层" placeholder="搜索图层" value={layerQuery} onChange={event=>setLayerQuery(event.target.value)}/></label>}<div className="layers-list">{foundLayers.map(n=><div key={n.id} draggable onDragStart={()=>setDragged(n.id)} onDragEnd={()=>{setDragged(null);setDropAt(null)}} onDragOver={e=>{e.preventDefault();setDropAt(n.id)}} onDrop={e=>{e.preventDefault();reorder(n.id)}} className={`layer-row ${(selectedId===n.id||multi.includes(n.id))?'selected':''} ${dropAt===n.id?'drop-target':''} ${dragged===n.id?'dragging':''} ${!n.visible?'muted-row':''}`} role="button" tabIndex={0} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.currentTarget.click()}}} onClick={e=>{if(e.shiftKey){setMulti(items=>items.includes(n.id)?items.filter(id=>id!==n.id):[...new Set([...items,...(selectedId?[selectedId]:[]),n.id])])}else setMulti([]);setSelected(n.id);setSelectedEffect(null);setRegionId(null);setRightTab('design')}}><GripVertical size={11} className="drag-grip"/><span className="layer-icon">{titleIcon(n)}</span><span className="layer-name" onDoubleClick={()=>{setSelected(n.id);setRightTab('design')}}>{n.name}{n.groupId&&<span className="group-indicator" title="已分组"/>}</span><button title={n.locked?'解锁图层':'锁定图层'} aria-label={`${n.name}${n.locked?'解锁':'锁定'}`} className={`row-action ${n.locked?'persistent':''}`} onClick={e=>{e.stopPropagation();changeSide({...active,nodes:active.nodes.map(x=>x.id===n.id?{...x,locked:!x.locked}:x)})}}>{n.locked?<Lock size={12}/>:<Unlock size={12}/>}</button><button title={n.visible?'隐藏图层':'显示图层'} aria-label={`${n.name}${n.visible?'隐藏':'显示'}`} className="row-action" onClick={e=>{e.stopPropagation();changeSide({...active,nodes:active.nodes.map(x=>x.id===n.id?{...x,visible:!x.visible}:x)})}}>{n.visible?<Eye size={13}/>:<EyeOff size={13}/>}</button></div>)}</div>{active.nodes.length>0&&!foundLayers.length&&<p className="panel-description">没有找到匹配的图层。</p>}{!active.nodes.length&&<div className="empty"><Layers3 size={26}/><p>从一张图片开始</p><Button onClick={()=>chooseImage()}>上传图片</Button></div>}<div className="layer-group-actions">{multi.length>=2&&<Button onClick={groupLayers}><Layers3 size={14}/>组合所选图层</Button>}{selected?.groupId&&<Button onClick={ungroupLayers}>解除分组</Button>}</div><div className="panel-note"><GripVertical size={13}/>拖动排序 · Shift 多选</div></>}
   {leftTab==='reference'&&<div className="reference-settings">
    {active.reference?<><figure><img src={active.reference.src} alt="当前卡面的参考图"/><figcaption>{active.reference.name}</figcaption></figure>
     <Button className="wide-button" active={referenceOpacity>0} onClick={()=>{setReferenceOpacity(value=>value>0?0:.5);setPlate(null)}}><Eye size={15}/>{referenceOpacity>0?'隐藏参考':'叠放到画布'}</Button>
     {referenceOpacity>0&&<Range label="参考图透明度" value={referenceOpacity*100} onChange={value=>setReferenceOpacity(value/100)} min={5}/>}
     <div className="reference-actions"><Button onClick={()=>referenceInput.current?.click()}><RefreshCw size={14}/>替换</Button>
      <Button onClick={()=>{changeSide({...active,reference:undefined});setReferenceOpacity(0)}}><Trash2 size={14}/>移除</Button></div>
    </>:<Button className="wide-button" onClick={()=>referenceInput.current?.click()}><Upload size={15}/>上传参考图</Button>}
    <p className="micro-copy">参考图只在画布中叠放，不计入卡面导出或工艺版。</p>
   </div>}
   {leftTab==='assets'&&<div className="asset-panel"><Button className="upload-block" onClick={()=>chooseImage()}><Upload size={22}/><b>上传你的图片</b><span>PNG、JPG、WebP · 最大 20 MB</span></Button><div className="section-heading">添加元素</div><div className="element-buttons"><Button onClick={()=>addNode('text')}><Type size={20}/>文字</Button><Button onClick={()=>addNode('rect')}><Square size={20}/>矩形</Button><Button onClick={()=>addNode('ellipse')}><Circle size={20}/>椭圆</Button><Button onClick={()=>addNode('polygon')}><Pentagon size={20}/>多边形</Button></div><div className="section-heading">精选素材 <small>Unsplash</small></div><div className="asset-grid">{(['ocean','botanical','editorial'] as const).map(t=><button key={t} onClick={async()=>{const response=await fetch(`/assets/${t}.jpg`);const blob=await response.blob();await uploadImage(new File([blob],TEMPLATE_NAMES[t]+'.jpg',{type:'image/jpeg'}))}}><img src={`/assets/${t}.jpg`} alt={TEMPLATE_NAMES[t]}/><span>{TEMPLATE_NAMES[t]}</span></button>)}</div><a className="source-link" href="/assets/assets-sources.txt" target="_blank" rel="noreferrer">查看素材来源 <ArrowUpRight size={12}/></a></div>}
   {leftTab==='regions'&&!regionDraft&&<><div className="section-heading"><span>可复用的作用区域</span><IconButton icon={Plus} title="新建手绘区域" onClick={()=>startRegion()}/></div><p className="panel-description">先选择区域，再添加效果。Shift 多选可合并。</p>{active.regions.map(r=><button key={r.id} className={`region-row ${(regionId===r.id||regionMulti.includes(r.id))?'selected':''}`} onClick={e=>{if(e.shiftKey)setRegionMulti(ids=>ids.includes(r.id)?ids.filter(id=>id!==r.id):[...new Set([...ids,...(regionId?[regionId]:[]),r.id])]);else setRegionMulti([]);setRegionId(r.id);setSelected(null);setSelectedEffect(null);setRightTab('effects')}}><span className={`region-symbol ${r.kind}`}/><span><b>{r.name}</b><small>{r.kind==='paint'?'手绘区域':r.kind==='node'?'图层轮廓':r.kind==='border'?'边框':r.kind==='rect'?'矩形':r.kind==='ellipse'?'椭圆':r.kind==='polygon'?'多边形':r.kind==='union'?'组合':'整面'} · {active.effects.filter(e=>e.regionId===r.id).length} 个效果</small></span><ChevronRight size={14}/></button>)}<Button className="wide-button" onClick={()=>startRegion(active.regions.find(r=>r.id===regionId))}><Paintbrush size={15}/>编辑区域</Button>{regionMulti.length>=2&&<Button className="wide-button" onClick={()=>{const region:Region={id:uid(),name:'组合区域',kind:'union',sources:regionMulti,binding:'fixed',inverted:false,strokes:[]};changeSide({...active,regions:[...active.regions,region]});setRegionId(region.id);setRegionMulti([])}}><Layers3 size={15}/>合并所选区域</Button>}<div className="region-create"><select aria-label="区域绘制方式" value={shapeKind} onChange={e=>setShapeKind(e.target.value as typeof shapeKind)}><option value="paint">画笔</option><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="polygon">多边形</option></select><Button onClick={()=>startRegion(undefined,shapeKind)}><Plus size={15}/>新建区域</Button></div>{regionId&&<Button className="wide-button" onClick={()=>{const r=active.regions.find(r=>r.id===regionId);if(r){const nr={...structuredClone(r),id:uid(),name:r.name+' 副本'};changeSide({...active,regions:[...active.regions,nr]});setRegionId(nr.id);if(effect)setSelectedEffect(null)}}}><Copy size={15}/>复制为独立区域</Button>}</>}
   {regionDraft&&leftTab==='regions'&&<div className="region-settings"><label className="field">区域名称<input value={regionDraft.name} onChange={e=>setRegionDraft({...regionDraft,name:e.target.value})}/></label>{regionDraft.kind==='node'&&regionDraft.nodeId&&<label className="field">定位方式<select value={regionDraft.binding} onChange={e=>{const linked=active.nodes.find(n=>n.id===regionDraft.nodeId);setRegionDraft({...regionDraft,binding:e.target.value as Region['binding'],snapshot:e.target.value==='fixed'&&linked?structuredClone(linked):undefined,bounds:undefined})}}><option value="follow">跟随图层</option><option value="fixed">固定在卡面</option></select></label>}</div>}</div><div className="left-bottom"><button onClick={()=>setModal('help')}><BookOpen size={16}/><span>操作指南与快捷键</span><Keyboard size={15}/></button></div>
  </aside>
  <main className="workspace" inert={leaving} onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()}} onDrop={e=>{const f=e.dataTransfer.files[0];if(f){e.preventDefault();void uploadImage(f)}}}>
   <div className="canvas-header"><div className="canvas-title">{collapsedLeft&&<IconButton icon={Layers3} title="展开图层面板" onClick={()=>setCollapsedLeft(false)}/>}<h1>{side==='front'?'正面':'背面'}</h1><i/> <button onClick={()=>setModal('size')} disabled={!!regionDraft}>{project.widthMm} × {project.heightMm} mm<Settings2 size={12}/></button></div><div className="canvas-modes"><Button active={!plate} onClick={()=>{setPlate(null);setLayerPlate(undefined)}}>合成</Button><Button active={plate==='foil'} onClick={()=>{setLayerPlate(undefined);setPlate(plate==='foil'&&!layerPlate?null:'foil')}}>箔版</Button><Button active={plate==='white'} onClick={()=>{setLayerPlate(undefined);setPlate(plate==='white'&&!layerPlate?null:'white')}}>白墨</Button><Button active={plate==='clear'} onClick={()=>{setLayerPlate(undefined);setPlate(plate==='clear'&&!layerPlate?null:'clear')}}>光油</Button>{collapsedRight&&<IconButton icon={SlidersHorizontal} title="展开属性面板" onClick={()=>setCollapsedRight(false)}/>}</div></div>
   {saveError&&<div className="conflict-banner save-error-banner" role="alert">
    <span>{'message' in save?save.message:''}</span>
    {save.status==='conflict'
     ?<button disabled={leaving} onClick={()=>void saveCopy()}>另存当前副本</button>
     :<button disabled={leaving} onClick={()=>void saveNow()}>重试保存</button>}
    <button onClick={()=>exportProject(current.current).then(()=>notify('项目包已下载')).catch(error=>notify(error.message))}>下载项目包</button>
   </div>}
   <div className="canvas-area"><EditorCanvas cardBoundsRef={cardBoundsRef} project={displayedProject} side={side} selectedId={selectedId} onSelect={id=>{setSelected(id);if(id){setRightTab('design');setSelectedEffect(null);setRegionId(null);setMulti([])}}} onChange={changeSide} tool={tool} spaceHeld={spaceHeld} navigationRef={navigationRef} showGuides={showGuides} hasModeNotice={hasModeNotice} regionId={regionDraft?.id??regionId} highlightRegion={maskHighlight} regionMode={!!regionDraft} onRegionChange={setRegionDraft} onTextEdit={editText} plate={plate} brushSize={brushSize} layerPlate={layerPlate} effectPreviewId={selectedEffect||undefined} referenceOpacity={referenceOpacity} onZoom={setZoom}/></div>
   <div className="canvas-notes">
    {showGuides&&<PrintGuideLegend project={project}/>}
    {(!showGuides||hasModeNotice)&&<div className="canvas-top-note">{regionDraft?(tool==='geometry'?(regionDraft.kind==='polygon'?'点击卡面添加顶点，完成后自动闭合':'在卡面拖动绘制形状'):'正在编辑作用区域'):plate?(layerPlate?'独立工艺层 · 黑色表示施作位置':'按通道合版 · 黑色表示施作位置'):maskHighlight?'绿色显示当前蒙版范围':(active.reference&&referenceOpacity?'参考图已叠放 · 仅供对照':'拖动图层自由排版 · 双击文字编辑')}</div>}
   </div>
   {regionDraft&&<div className="region-bar"><span><Paintbrush size={16}/>{regionDraft.name}</span>{['rect','ellipse','polygon'].includes(regionDraft.kind)&&<IconButton icon={Square} title="绘制几何轮廓" active={tool==='geometry'} onClick={()=>{if(regionDraft.kind==='polygon')setRegionDraft({...regionDraft,points:[]});setTool('geometry')}}/>}<IconButton icon={Paintbrush} title="画笔" active={tool==='brush'} onClick={()=>setTool('brush')}/><IconButton icon={Eraser} title="擦除" active={tool==='eraser'} onClick={()=>setTool('eraser')}/><input aria-label="笔刷大小" type="range" min="4" max="120" value={brushSize} onChange={e=>setBrushSize(+e.target.value)}/><span>{brushSize}</span><Button onClick={()=>setRegionDraft(regionDraft.strokes.length?{...regionDraft,strokes:regionDraft.strokes.slice(0,-1)}:{...regionDraft,points:regionDraft.points?.slice(0,-2)})} disabled={!regionDraft.strokes.length&&!regionDraft.points?.length}><Undo2 size={14}/></Button><Button onClick={()=>setRegionDraft({...regionDraft,inverted:!regionDraft.inverted})}>反选</Button><Button onClick={()=>{setRegionDraft(null);setPendingLayer(null);setTool('select')}}>取消</Button><Button className="primary" onClick={applyRegion}><Check size={14}/>完成</Button></div>}
   {!regionDraft&&<div className="canvas-toolbox"><IconButton icon={MousePointer2} title="选择 V" active={tool==='select'} onClick={()=>setTool('select')}/><IconButton icon={Hand} title="平移画布（H 或按住空格拖动）" active={tool==='hand'} onClick={()=>setTool('hand')}/><span className="tool-divider"/><IconButton icon={Type} title="添加文字" onClick={()=>addNode('text')}/><IconButton icon={ImagePlus} title="上传图片" onClick={()=>chooseImage()}/><IconButton icon={Square} title="添加矩形" onClick={()=>addNode('rect')}/><IconButton icon={Paintbrush} title="绘制作用区域" onClick={()=>startRegion()}/><span className="tool-divider"/><IconButton icon={ScanLine} title={showGuides?'隐藏印刷参考线':'显示印刷参考线'} active={showGuides} onClick={()=>setGuides(!showGuides)}/></div>}
   <div className="canvas-bottom">
    <div className="side-switch" aria-label="编辑卡面">
     {(['front','back'] as const).map(face=><button key={face} className={side===face?'selected':''} aria-pressed={side===face} aria-label={face==='front'?'正面':'背面'}
       disabled={!!regionDraft} onClick={()=>switchSide(face)}><CardThumb project={project} side={face}/><span>{face==='front'?'正面':'背面'}</span></button>)}
    </div>
    <div className="zoom-controls"><IconButton icon={ZoomOut} title="缩小" onClick={()=>navigationRef.current?.zoomBy(1/ZOOM_STEP)}/><button title="恢复自适应大小" onClick={()=>navigationRef.current?.fit()}>{Math.round(zoom*100)}%</button><IconButton icon={ZoomIn} title="放大" onClick={()=>navigationRef.current?.zoomBy(ZOOM_STEP)}/><IconButton icon={Maximize} title="适应画布" onClick={()=>navigationRef.current?.fit()}/></div>
   </div>
  </main>
  <aside className="right-panel" inert={leaving}><div className="panel-toolbar"><span>卡牌属性</span><IconButton icon={PanelRightClose} title="收起右侧面板" onClick={()=>setCollapsedRight(true)}/></div><div className="tabs"><button className={rightTab==='design'?'selected':''} onClick={()=>setRightTab('design')}>设计</button><button className={rightTab==='effects'?'selected':''} onClick={()=>setRightTab('effects')}>工艺</button><button className={rightTab==='material'?'selected':''} onClick={()=>setRightTab('material')}>材质</button></div><div className="right-scroll" key={rightTab}>
   {regionDraft?<div className="no-selection">
    <ScanLine size={22}/><h3>正在编辑作用区域</h3><p>在画布上完成或取消，再继续调整工艺。</p>
   </div>:<>
   {rightTab==='effects'&&(effect?<div className="effect-properties current-process">
    <div className="section-heading"><span>{processName(effect)}</span><IconButton icon={Copy} title="复制当前工艺层" onClick={()=>{
     const copy={...structuredClone(effect),id:uid(),name:effect.name.slice(0,96)+' 副本'};
     changeSide({...active,effects:[...active.effects,copy]});chooseProcess(copy);
    }}/><IconButton icon={Trash2} title="删除当前工艺层" onClick={()=>{
     changeSide({...active,effects:active.effects.filter(item=>item.id!==effect.id)});
     setSelectedEffect(null);setRegionId(null);setPlate(null);setLayerPlate(undefined);
    }}/></div>
    <label className="field">工艺层名称<input maxLength={100} value={effect.name} onChange={event=>patchEffect({name:event.target.value})}/></label>
    <label className="field">作用区域<select value={effect.regionId} onChange={event=>{
     patchEffect({regionId:event.target.value});setRegionId(event.target.value);
    }}>{active.regions.map(region=><option value={region.id} key={region.id}>{region.name}</option>)}</select></label>
    {processKind(effect)==='reflection'&&<FlashStyles value={getFlashStyle(project,effect)} onChange={flashStyle=>{
     patchEffect({flashStyle,process:'reflection'});setPlate(null);setLayerPlate(undefined);setShowEffectMask(false);
    }}/>}
    {processKind(effect)==='foil'&&<label className="field">箔材示意<select value={effect.type} onChange={event=>patchEffect({type:event.target.value as EffectType})}><option value="gold">金箔</option><option value="silver">银箔</option><option value="holo">镭射箔</option></select></label>}
    {processKind(effect)!=='white'&&<><Range label="效果强度" value={effect.opacity*100} onChange={n=>patchEffect({opacity:n/100})}/><Range label="纹理方向" value={effect.angle} min={0} max={360} unit="°" onChange={n=>patchEffect({angle:n})}/></>}
    {processKind(effect)==='white'&&<>
     {effect.maskContent===undefined&&targetRegion?.kind==='node'&&active.nodes.find(node=>node.id===targetRegion.nodeId)?.type==='image'&&
      <p className="micro-copy mask-filename">白墨来源 · 跟随彩稿图片的裁切及不透明轮廓</p>}
     <Button className="wide-button" disabled={readingImages>0} onClick={()=>{whiteUploadTarget.current={id:effect.id,face:side};whiteInput.current?.click()}}><Upload size={14}/>{effect.maskContent?.some(node=>node.type==='image')?'替换白墨 PNG':'上传白墨 PNG'}</Button>
     {effect.maskContent?.filter(node=>node.type==='image').map(node=><p className="micro-copy mask-filename" key={node.id}>{node.name} · {node.maskInk==='dark'?'深色区域':'不透明区域'}</p>)}
    </>}
    <Button className="wide-button" onClick={()=>setModal('maskContent')}><Layers3 size={14}/>编辑蒙版内容</Button>
    {effect.maskContent!==undefined&&<Button className="wide-button" onClick={()=>patchEffect({maskContent:undefined})}>改用整个作用区域</Button>}
    <div className="inline-actions">
     <Button active={showEffectMask} onClick={()=>{setShowEffectMask(value=>!value);setPlate(null);setLayerPlate(undefined)}}><Eye size={14}/>{showEffectMask?'隐藏蒙版范围':'显示蒙版范围'}</Button>
     <Button onClick={()=>startRegion(active.regions.find(region=>region.id===effect.regionId))}><Paintbrush size={14}/>编辑区域</Button>
    </div>
    {plateFor(effect)&&<Button className="wide-button" onClick={()=>{setPlate(plateFor(effect)||null);setLayerPlate(effect.id)}}><ScanLine size={14}/>查看本层分版</Button>}
   </div>:<div className="no-selection"><Layers3 size={26}/><h3>选择一个工艺层</h3><p>从左侧叠层选择局部闪光、白墨、箔版或光油。</p>
    <Button onClick={()=>showNewLayer('reflection')}><Plus size={15}/>新建工艺层</Button></div>)}
   {rightTab==='design'&&(selected?<><div className="section-heading"><span>{selected.type==='text'?'文字属性':selected.type==='image'?'图片属性':'形状属性'}</span><span className="muted">{selected.locked?'已锁定':''}</span></div><label className="field">图层名称<input value={selected.name} onChange={e=>patchNode({name:e.target.value})}/></label>{selected.type==='text'&&<><label className="field">文字内容<textarea id="text-content" aria-label="文字内容" rows={3} value={selected.text||''} onChange={e=>patchNode({text:e.target.value})}/></label><div className="field-grid"><label className="field">字号<input type="number" min="6" max="240" value={selected.fontSize||24} onChange={e=>patchNode({fontSize:Math.max(6,+e.target.value)})}/></label><label className="field">字重<select value={selected.fontStyle||'normal'} onChange={e=>patchNode({fontStyle:e.target.value})}><option value="normal">常规</option><option value="bold">粗体</option><option value="italic">斜体</option><option value="italic bold">粗斜体</option></select></label></div><Range label="字距" value={(selected.letterSpacing||0)/10} min={-2} max={2} step={.1} unit=" mm" onChange={n=>patchNode({letterSpacing:n*10})}/><Range label="行距" value={(selected.lineHeight||1.3)*100} min={80} max={260} onChange={n=>patchNode({lineHeight:n/100})}/><label className="field">字体<select value={selected.fontFamily?.includes('serif')&&!selected.fontFamily.includes('sans-serif')?'serif':'sans'} onChange={e=>patchNode({fontFamily:e.target.value==='serif'?'Songti SC, Georgia, serif':'Work Sans, PingFang SC, sans-serif'})}><option value="sans">无衬线</option><option value="serif">宋体／衬线</option></select></label><label className="field">对齐方式<select value={selected.align||'left'} onChange={e=>patchNode({align:e.target.value})}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label></>}
   {selected.type==='image'&&<><div className="image-inspector"><CroppedImage node={selected}/></div>
    <Button className="wide-button" onClick={()=>createTypedLayer({kind:'white',area:':contour',content:'image',contentMask:false,name:(selected.name+' · 白墨').slice(0,100)})}><Layers3 size={14}/>用图片轮廓建立白墨</Button><label className="check-field"><input type="checkbox" checked={replaceCrop} onChange={e=>setReplaceCrop(e.target.checked)}/>替换时沿用裁切</label><div className="inline-actions"><Button disabled={selected.locked} onClick={()=>setModal('crop')}><ScanLine size={14}/>编辑裁切</Button><Button disabled={selected.locked} onClick={()=>chooseImage(selected.id)}><RefreshCw size={14}/>替换图片</Button></div></>}
   <label className="field">彩稿蒙版<select value={selected.clipRegionId||''} disabled={selected.locked} onChange={event=>patchNode({clipRegionId:event.target.value||undefined})}><option value="">无蒙版</option>{active.regions.filter(region=>region.nodeId!==selected.id).map(region=><option key={region.id} value={region.id}>{region.name}</option>)}</select></label>
   {['rect','ellipse','polygon'].includes(selected.type)&&<><label className="field">填色方式<select value={selected.gradient?'gradient':'solid'} disabled={selected.locked} onChange={event=>patchNode({
    gradient:event.target.value==='gradient'?{angle:90,stops:[[0,selected.fill==='transparent'?'#c7b277':selected.fill],[1,'#fff2cb']]}:undefined
   })}><option value="solid">纯色</option><option value="gradient">线性渐变</option></select></label>
   {selected.gradient&&<>
    <Range label="渐变方向" value={selected.gradient.angle} min={0} max={360} unit="°" onChange={angle=>patchNode({gradient:{...selected.gradient!,angle}})}/>
    <div className="gradient-stops">{selected.gradient.stops.map(([offset,color],index)=><label className="field" key={index}>{Math.round(offset*100)}%
     <input type="color" aria-label={`渐变色标 ${index+1}`} disabled={selected.locked} value={/^#[a-f0-9]{6}$/i.test(color)?color:color.slice(0,7)}
      onChange={event=>patchNode({gradient:{...selected.gradient!,stops:selected.gradient!.stops.map((entry,i)=>i===index?[entry[0],event.target.value]:entry)}})}/>
    </label>)}</div>
   </>}</>}
   <div className="section-heading">位置与大小 <small>mm</small></div><div className="field-grid">{(['x','y','width','height'] as const).map(key=><label className="number-field" key={key}><span>{{x:'X',y:'Y',width:'W',height:'H'}[key]}</span><input aria-label={key} type="number" step=".1" value={Math.round(selected[key])/10} disabled={selected.locked} onChange={e=>patchNode({[key]:key==='width'||key==='height'?Math.max(1,+e.target.value*10):+e.target.value*10})}/></label>)}</div><div className="alignment-tools" aria-label="对齐到卡面">
    <IconButton icon={AlignHorizontalJustifyStart} title="对齐到卡面左侧" disabled={selected.locked} onClick={()=>alignNode('x',0)}/>
    <IconButton icon={AlignHorizontalJustifyCenter} title="卡面水平居中" disabled={selected.locked} onClick={()=>alignNode('x',.5)}/>
    <IconButton icon={AlignHorizontalJustifyEnd} title="对齐到卡面右侧" disabled={selected.locked} onClick={()=>alignNode('x',1)}/>
    <IconButton icon={AlignVerticalJustifyStart} title="对齐到卡面顶部" disabled={selected.locked} onClick={()=>alignNode('y',0)}/>
    <IconButton icon={AlignVerticalJustifyCenter} title="卡面垂直居中" disabled={selected.locked} onClick={()=>alignNode('y',.5)}/>
    <IconButton icon={AlignVerticalJustifyEnd} title="对齐到卡面底部" disabled={selected.locked} onClick={()=>alignNode('y',1)}/>
   </div><Range label="旋转" value={selected.rotation} min={-180} max={180} unit="°" onChange={n=>patchNode({rotation:n})}/><Range label="不透明度" value={selected.opacity*100} onChange={n=>patchNode({opacity:n/100})}/>{selected.type!=='image'&&<label className="color-field"><span>填充颜色</span><input type="color" value={selected.fill.startsWith('#')?selected.fill:'#ffffff'} onChange={e=>patchNode({fill:e.target.value})}/><span>{selected.fill}</span></label>}{(selected.type==='rect'||selected.type==='image')&&<Range label="圆角" value={(selected.cornerRadius||0)/10} min={0} max={Math.min(selected.width,selected.height)/20} step={.1} unit=" mm" onChange={n=>patchNode({cornerRadius:n*10})}/>}
   {selected.type!=='image'&&<><label className="color-field"><span>描边颜色</span><input type="color" aria-label="描边颜色" value={selected.stroke?.match(/^#[0-9a-f]{6}$/i)?selected.stroke:'#ffffff'} onChange={event=>patchNode({stroke:event.target.value,strokeWidth:selected.strokeWidth||2})}/><span>{selected.stroke||'无'}</span></label>
   <Range label="描边宽度" value={(selected.strokeWidth||0)/10} min={0} max={2} step={.05} unit=" mm" onChange={n=>patchNode({strokeWidth:n*10,stroke:selected.stroke||'#ffffff'})}/></>}
   <label className="field">混合方式<select value={selected.blend||'source-over'} onChange={e=>patchNode({blend:e.target.value})}><option value="source-over">正常</option><option value="multiply">正片叠底</option><option value="screen">滤色</option><option value="overlay">叠加</option></select></label><div className="inline-actions"><Button onClick={duplicateNode}><Copy size={14}/>复制</Button><Button onClick={requestDelete} disabled={selected.locked}><Trash2 size={14}/>删除</Button></div><Button className="wide-button" onClick={()=>{setRegionId(null);setSelectedEffect(null);showNewLayer('varnish')}}><Sparkles size={14}/>给这个图层加效果</Button></>:<div className="no-selection"><MousePointer2 size={26}/><h3>选择一个图层</h3><p>在卡面上点击图片、文字或形状，即可调整它的属性。</p><Button onClick={()=>addNode('text')}><Type size={15}/>添加文字</Button><Button onClick={()=>chooseImage()}><ImagePlus size={15}/>上传图片</Button></div>)}
   {rightTab==='material'&&<><div className="section-heading">卡基与底材</div>
    <StockPicker material={project.material} reflection={getStockReflection(project)}
      onMaterial={material=>commit({...current.current,material,stockReflection:defaultStockReflection(material)})}
      onReflection={stockReflection=>commit({...current.current,stockReflection})}/>
    <div className="section-heading">版面规格</div><div className="spec-list"><span>成品尺寸<b>{project.widthMm} × {project.heightMm} mm</b></span><span>出血<b>{project.bleedMm} mm</b></span><span>圆角半径<b>{getCardCornerRadiusMm(project)} mm</b></span><span>正文安全区<b>内缩 {PRINT_SAFE_MARGIN_MM} mm</b></span><span>生产状态<b>待工厂确认</b></span></div>
    <Button className="wide-button" onClick={()=>setModal('size')}><Settings2 size={14}/>调整卡片尺寸</Button></>}

   </>}
   </div><div className="right-bottom"><span className="status-dot"/>本机项目 <span>v{project.version}</span></div></aside>
  <footer className="statusbar"><span><span className="status-dot"/> {regionDraft?'编辑区域中':selected?selected.name:'准备就绪'}</span><span className="workspace-spec">{MATERIALS.find(m=>m.id===project.material)?.name} · {project.widthMm} × {project.heightMm} mm</span><button onClick={()=>setModal('help')}><Keyboard size={12}/>快捷键</button></footer>
  {toast&&<div className="toast" role="status"><CheckCircle2 size={17}/>{toast}</div>}
  {modal==='newLayer'&&<Modal title="新建图层" onClose={closeModal}><CreateLayer side={active} source={selected} initial={initialLayerKind} onClose={closeModal} onCreate={createTypedLayer}/></Modal>}
  {modal==='maskContent'&&effect&&<Modal title={effect.name+' · 蒙版内容'} wide onClose={closeModal}><MaskContentEditor project={project} side={active} effect={effect} onClose={closeModal} onApply={maskContent=>{patchEffect({maskContent});closeModal()}}/></Modal>}
  {modal==='rename'&&<RenameProject name={project.name} onClose={closeModal} onRename={name=>{if(name!==project.name)commit({...current.current,name});closeModal()}}/>}
  {modal==='crop'&&selected?.type==='image'&&<Modal title="编辑图片裁切" wide onClose={closeModal}><CropEditor key={selected.id} node={selected} onCancel={closeModal} onApply={applyCrop}/></Modal>}
  {modal==='preview'&&<AlbumPreview cardBoundsRef={cardBoundsRef} project={project} initialSide={side} material={MATERIALS.find(m=>m.id===project.material)?.name} onClose={closeModal} onExport={()=>setModal('export')}/>}
  <ExportPanel open={modal==='export'} project={project} onClose={closeModal} notify={notify} onLocate={target=>{
   switchSide(target.side);setSelected(target.nodeId||null);setSelectedEffect(target.effectId||null);
   const linkedEffect=project[target.side].effects.find(item=>item.id===target.effectId);
   setRegionId(linkedEffect?.regionId||null);setRightTab(target.material?'material':target.nodeId?'design':'effects');
   setCollapsedRight(false);setPlate(null);setModal(null);if(target.nodeId)setGuides(true);
  }}/>
  {modal==='size'&&<SizeModal project={project} onClose={closeModal} onApply={p=>{commit(p);setModal(null);notify('尺寸已更新')}}/>}
  {modal==='help'&&<Modal title="把灵感，变成一张卡" onClose={closeModal}><div className="help-content"><p>从模板或上传图片开始，在画布中拖动、缩放、旋转元素。滚轮以指针为中心缩放。使用「作用区域」给卡牌的指定位置添加效果。</p><div className="help-step"><ImagePlus/><div><b>排版你的内容</b><p>上传图片或拖入画布，双击文字编辑，拖动角点缩放。</p></div></div><div className="help-step"><Paintbrush/><div><b>决定哪里闪光</b><p>选择图层轮廓，或用画笔涂出区域。擦除、反选和取消帮助你精修。</p></div></div><div className="help-step"><Sparkles/><div><b>叠加，再转动看看</b><p>添加箔、光油或数字效果，进入成品预览观察光线。</p></div></div><div className="shortcut-grid">{[['V','选择工具'],['H','手形工具'],['空格 + 拖动','临时平移'],['⌘ Z','撤销'],['⇧ ⌘ Z','重做'],['⌘ D','复制图层'],['⌘ S','保存项目'],['0','适应画布'],['Delete','删除图层']].map(([key,label])=><span key={key}><kbd>{key}</kbd>{label}</span>)}</div><p className="micro-copy">数字导出和本机技术分版可用。正式 PDF/X、真实设备读版与实体打样属于后续生产验收。</p></div></Modal>}
  {confirmDelete&&<Modal title="这个图层关联了作用区域" onClose={()=>setConfirmDelete(null)}><div className="help-content"><p>删除「{confirmDelete.name}」后，可以把关联区域固定在当前位置，继续保留效果。</p><div className="inline-actions"><Button onClick={()=>deleteNode(confirmDelete,true)}>连同区域与效果删除</Button><Button className="primary" onClick={()=>deleteNode(confirmDelete,false)}>保留区域，删除图层</Button></div></div></Modal>}
 </div>
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
 const [phase,setPhase]=useState<'stock'|'layout'>('stock');
 const [material,setMaterial]=useState('matte');
 const [reflection,setReflection]=useState<StockReflection>('none');
 const [template,setTemplate]=useState<TemplateName>('blank');
 const draft=useRef<{template:TemplateName;name:string;material:string;reflection:StockReflection;project:Project}|null>(null);
 const [name,setName]=useState('');
 const [samples]=useState(()=>Object.fromEntries((['ocean','botanical','editorial','blank'] as const).map(key=>[key,createProject(key)])) as Record<TemplateName,Project>);
 return <Modal title="新建卡牌" onClose={onClose} wide>
  {phase==='stock'?<><div className="new-content">
    <p className="template-intro">先选择卡基与底材反光</p>
    <StockPicker material={material} reflection={reflection}
      onMaterial={value=>{setMaterial(value);setReflection(defaultStockReflection(value))}} onReflection={setReflection}/>
   </div><div className="modal-footer"><Button onClick={onClose}>取消</Button><Button className="primary" onClick={()=>setPhase('layout')}>下一步：选版式<ChevronRight size={15}/></Button></div></>:<>
  <div className="new-content">
   <p className="template-intro">{MATERIALS.find(stock=>stock.id===material)?.name} · {STOCK_REFLECTIONS[reflection]}</p>
   <div className="template-grid">{(Object.keys(samples) as TemplateName[]).map(key=><button key={key} className={template===key?'selected':''} aria-pressed={template===key} onClick={()=>setTemplate(key)}><div className={`template-cover ${key}`}>{key==='blank'?<Square size={34} strokeWidth={1}/>:<CardThumb project={samples[key]}/>}</div><span>{TEMPLATE_NAMES[key]}{template===key&&<Check size={14}/>}</span></button>)}</div>
   <div className="new-project-fields">
    <label className="field">项目名称<input value={name} placeholder={TEMPLATE_NAMES[template]} maxLength={80} onChange={e=>setName(e.target.value)}/></label>
    <p className="micro-copy">63 × 88 mm · 双面 · 3 mm 出血<br/>可在工作台调整尺寸。</p>
   </div>
  </div>
  {error&&<p className="new-content library-error" role="alert">{error}</p>}
  <div className="modal-footer"><Button disabled={pending} onClick={()=>setPhase('stock')}>上一步</Button><Button className="primary" disabled={pending} onClick={()=>{
   const title=name.trim();
   if(!draft.current||draft.current.template!==template||draft.current.name!==title||draft.current.material!==material||draft.current.reflection!==reflection) {
    draft.current={template,name:title,material,reflection,project:{...createProject(template,title||undefined),material,stockReflection:reflection}};
   }
   onCreate(draft.current.project);
  }}><Plus size={15}/>创建卡牌</Button></div></>}
 </Modal>;
}

function SizeModal({project,onClose,onApply}:{project:Project;onClose:()=>void;onApply:(p:Project)=>void}){
 const [width,setWidth]=useState(project.widthMm),[height,setHeight]=useState(project.heightMm),[bleed,setBleed]=useState(project.bleedMm);
 const [radius,setRadius]=useState(() => getCardCornerRadiusMm(project));
 const [mode,setMode]=useState('keep');
 const maxRadius=Math.max(0,Math.min(width,height)/2);
 const validSize=width>=20&&width<=300&&height>=20&&height<=300&&bleed>=0&&bleed<=20;
 const validRadius=Number.isFinite(radius)&&radius>=0&&radius<=maxRadius;
 const valid=validSize&&validRadius;
 const resize=()=>{
  if(!valid)return;
  const next={...structuredClone(project),widthMm:width,heightMm:height,bleedMm:bleed,cornerRadiusMm:radius};
  if(mode==='scale'){
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
    for(const region of side.regions){
     if(region.bounds){region.bounds.x=region.bounds.x*scale+dx;region.bounds.y=region.bounds.y*scale+dy;region.bounds.width*=scale;region.bounds.height*=scale}
     if(region.points)region.points=region.points.map((p,i)=>p*scale+(i%2?dy:dx));
     if(region.snapshot)scaleNode(region.snapshot);
     for(const stroke of region.strokes){stroke.size*=scale;stroke.points=stroke.points.map((p,i)=>p*scale+(i%2?dy:dx))}
    }
   }
  }
  onApply(next);
 };
 return <Modal title="卡片尺寸" onClose={onClose}><div className="new-content">
  <div className="field-grid three"><label className="field">宽度（mm）<input type="number" value={width} min={20} max={300} onChange={e=>setWidth(+e.target.value)}/></label><label className="field">高度（mm）<input type="number" value={height} min={20} max={300} onChange={e=>setHeight(+e.target.value)}/></label><label className="field">出血（mm）<input type="number" value={bleed} min={0} max={20} onChange={e=>setBleed(+e.target.value)}/></label></div>
  <div className="corner-settings">
   <div>
    <label className="field">圆角半径（mm）<input type="number" value={radius} min={0} max={maxRadius} step=".1" aria-invalid={!validRadius} onChange={event=>setRadius(+event.target.value)}/></label>
    <p className="micro-copy">{validRadius?'0 mm 为直角。出血线和正文安全线随裁切线同步调整。':`圆角半径须在 0–${maxRadius} mm 之间。`}</p>
   </div>
   {validSize&&<PrintCornerPreview project={{widthMm:width,heightMm:height,bleedMm:bleed,cornerRadiusMm:radius}}/>}
  </div>
  <label className="field">图层处理<select value={mode} onChange={e=>setMode(e.target.value)}><option value="keep">保持对象实际尺寸</option><option value="scale">整体等比缩放并居中</option></select></label>
  <p className="micro-copy">{validSize?`含出血 ${+(width+bleed*2).toFixed(2)} × ${+(height+bleed*2).toFixed(2)} mm`:'宽高须在 20–300 mm，出血须在 0–20 mm。'}</p>
 </div><div className="modal-footer"><Button onClick={onClose}>取消</Button><Button className="primary" disabled={!valid} onClick={resize}>应用尺寸</Button></div></Modal>;
}

type ExportMode='image'|'print'|'project';
type PrintProfile='standard'|'alternate';
type PreflightTarget={side:SideName;nodeId?:string;effectId?:string;material?:boolean};
type ExportRequest={mode:ExportMode;project:Project;sides:SideName[];dpi:number;format:'png'|'jpeg';effects:boolean;profile:PrintProfile;includeGrain:boolean};
type JobState={label:string;progress:number;error?:string;file?:Blob;name?:string;request:ExportRequest};
const channels=['white','foil','clear'] as const;
const plateLabels={white:'白墨版',foil:'箔版',clear:'光油版'};
function usedPlates(project:Project,side:SideName){
 return channels.filter(key=>project[side].effects.some(effect=>processLayerEnabled(effect)&&plateFor(effect)===key));
}
function canvasBlob(canvas:HTMLCanvasElement,format:'png'|'jpeg'){return new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成图片，请降低分辨率后重试')),`image/${format}`,.94))}

function ExportPanel({project,onClose,notify,open,onLocate}:{project:Project;onClose:()=>void;notify:(message:string)=>void;open:boolean;onLocate:(target:PreflightTarget)=>void}){
 const [mode,setMode]=useState<ExportMode>('image'),[sides,setSides]=useState<SideName[]>(['front','back']),[dpi,setDpi]=useState(300),[format,setFormat]=useState<'png'|'jpeg'>('png'),[effects,setEffects]=useState(true);
 const [profile,setProfile]=useState<PrintProfile>('standard'),[job,setJob]=useState<JobState|null>(null),[grain,setGrain]=useState<'exclude'|'include'|'unset'>('unset');
 const [service,setService]=useState<'checking'|'online'|'offline'|'outdated'>('checking'),[busy,setBusy]=useState(false);
 const [serviceCheck,setServiceCheck]=useState(0);
 const abort=useRef<AbortController|null>(null);
 useEffect(()=>{
  if(!open||mode!=='print')return;
  const c=new AbortController();
  setService('checking');
  fetch('/api/health',{signal:c.signal}).then(async response=>{
   const status=response.ok?await response.json():null;
   if(!c.signal.aborted)setService(status?.layeredPlates?'online':status?'outdated':'offline');
  })
   .catch(()=>{if(!c.signal.aborted)setService('offline')});
  return()=>c.abort();
 },[open,mode,serviceCheck]);
 const hasGrain=sides.some(s=>project[s].effects.some(e=>processKind(e)==='reflection'&&processLayerEnabled(e)));
 const issues:Array<{target:PreflightTarget;text:string;blocking:boolean}>=sides.flatMap(s=>{
  const face=project[s];
  const label=s==='front'?'正面':'背面';
  return [
   ...face.effects.filter(e=>processLayerEnabled(e)&&plateFor(e)&&!e.name.trim())
    .map(e=>({target:{side:s,effectId:e.id},text:`${label}有工艺层缺少名称`,blocking:true})),
   ...face.effects.filter(e=>processLayerEnabled(e)&&plateFor(e)&&e.maskContent?.length===0)
    .map(e=>({target:{side:s,effectId:e.id},text:`${label}「${e.name}」的蒙版没有内容`,blocking:true})),
   ...(!face.nodes.some(n=>n.visible)?[{target:{side:s},text:`${label}没有可见图层，将导出空白卡面`,blocking:false}]:[]),
   ...face.nodes.filter(n=>n.visible&&n.type==='image'&&!n.src).map(n=>({target:{side:s,nodeId:n.id},text:`${label}「${n.name}」缺少图片`,blocking:true})),
   ...face.nodes.filter(n=>n.visible&&n.type==='text'&&isOutsidePrintSafeArea(n,project)).map(n=>({target:{side:s,nodeId:n.id},text:`${label}「${n.name}」超出正文安全区（内缩 ${PRINT_SAFE_MARGIN_MM} mm）`,blocking:false})),
   ...face.effects.filter(e=>processLayerEnabled(e)&&!face.regions.some(r=>r.id===e.regionId)).map(e=>({target:{side:s,effectId:e.id},text:`${label}「${e.name}」缺少作用区域`,blocking:true})),
   ...(getStockReflection(project)==='none'&&!['holo','silver'].includes(project.material)&&usedPlates(project,s).includes('white')?[{target:{side:s,material:true},text:`${label}在当前卡基上使用白墨，请与印厂确认覆盖率与附着条件`,blocking:false}]:[]),
   ...(profile==='alternate'?face.effects.filter(e=>processLayerEnabled(e)&&plateFor(e)==='foil'&&face.regions.some(r=>r.id===e.regionId&&(r.kind==='paint'||r.strokes.length>0))).map(e=>({target:{side:s,effectId:e.id},text:`${label}「${e.name}」使用了笔刷区域。配置 B 的箔版要求几何轮廓`,blocking:true})):[])
  ];
 });
 const names=profile==='standard'?{white:'White',foil:'Foil_Gold',clear:'Spot_UV'}:{white:'OPW',foil:'FOIL',clear:'CLEAR'};
 const allPlates=channels.filter(key=>sides.some(s=>usedPlates(project,s).includes(key)));
 const run=async(request:ExportRequest)=>{
  if(abort.current)return;
  const controller=new AbortController();abort.current=controller;setBusy(true);
  setJob({request,label:'准备项目快照',progress:5});
  const progress=(label:string,amount:number)=>setJob({request,label,progress:amount});
  const check=()=>controller.signal.throwIfAborted();
  const stem=request.project.name.replace(/[\\/:*?"<>|]/g,'_')||'卡牌';
  try {
   let file:Blob,name:string;
   if(request.mode==='project'){progress('打包可编辑图层和原始素材',35);await exportProject(request.project);setJob({request,label:'项目包已下载',progress:100});notify('项目包已下载');return}
   if(request.mode==='image'){
    const zip=new JSZip();let imageFile:Blob|null=null;
    for(const [index,face] of request.sides.entries()){
     progress(`渲染${face==='front'?'正面':'背面'}图片`,20+index*35);
     const scale=request.dpi/254;
     const canvas=await renderCard(request.project,face,{scale,effects:request.effects});
     check();imageFile=await canvasBlob(canvas,request.format);zip.file(`${face}.${request.format==='jpeg'?'jpg':'png'}`,imageFile);
    }
    file=request.sides.length===1?imageFile!:await zip.generateAsync({type:'blob'});
    name=request.sides.length===1?`${stem}-${request.sides[0]}.${request.format==='jpeg'?'jpg':'png'}`:`${stem}-数字卡图.zip`;
   } else {
    const pages=[];
    for(const [index,face] of request.sides.entries()){
     progress(`生成${face==='front'?'正面':'背面'}彩稿与工艺版`,15+index*23);
     const options={scale:request.dpi/254,bleed:true};
     const printProject={...request.project,[face]:{...request.project[face],effects:request.project[face].effects.filter(e=>processKind(e)==='reflection'&&request.includeGrain)}};
     const artwork=(await renderCard(printProject,face,{...options,effects:request.includeGrain,material:false})).toDataURL('image/png');
     const layers=[];
     for(const channel of channels){
      for(const entry of request.project[face].effects.filter(effect=>processLayerEnabled(effect)&&plateFor(effect)===channel)){
       check();
       const mask = (await renderCard(request.project,face,{...options,plate:channel,layerId:entry.id})).toDataURL('image/png');
       layers.push({id:entry.id,name:entry.name,channel,variant:entry.type,regionId:entry.regionId,mask});
      }
     }
     pages.push({side:face,artwork,layers});check();
    }
    progress('生成 PDF、TIFF 并核对版面',70);
    const {id,name:projectName,version,widthMm,heightMm,bleedMm,material}=request.project;
    const response=await fetch('/api/export',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({project:{id,name:projectName,version,widthMm,heightMm,bleedMm,material:MATERIALS.find(m=>m.id===material)?.name||material,stockReflection:getStockReflection(request.project)},profile:request.profile,pages})});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'本机印前服务暂不可用，请启动服务后重试')}
    file=await response.blob();name=`${stem}-v${request.project.version}-技术打样.zip`;
   }
   check();setJob({request,label:'文件已准备好',progress:100,file,name});downloadBlob(file,name);notify(`${request.mode==='print'?'印刷文件包':'数字卡图'}已下载`);
  } catch(error){setJob({request,label:controller.signal.aborted?'导出已取消':'导出失败',progress:0,error:controller.signal.aborted?'可以重试相同版本。':(error as Error).message})}
  finally{if(abort.current===controller){abort.current=null;setBusy(false)}}
 };
 if(!open)return null;
 const pixel=(mm:number)=>Math.round((mm+(mode==='print'?project.bleedMm*2:0))*dpi/25.4);
 const start=()=>void run({mode,project:structuredClone(project),sides:[...sides],dpi,format,effects,profile,includeGrain:grain==='include'});
 const blockers=issues.filter(issue=>issue.blocking);
 const notes=issues.filter(issue=>!issue.blocking);
 const grainRequired=hasGrain&&grain==='unset';
 const blocked=mode==='print'&&(service!=='online'||!!blockers.length||grainRequired);
 const printMessage=service==='checking'?'正在检查本机印前服务':service==='offline'?'本机印前服务未连接':service==='outdated'?'请重启 Prism 以加载新版印前服务':
  blockers.length?`先处理 ${blockers.length} 项阻塞问题`:grainRequired?'请先选择局部闪光的生产处理方式':'用于打样和印厂核对';
 return <Modal title="导出卡牌" onClose={onClose} drawer>
  <div className="export-context"><strong>{project.name}</strong><span>{project.widthMm} × {project.heightMm} mm · v{project.version}</span></div>
  <div className="export-tabs" aria-label="导出用途">
   {([['image','数字图片',ImagePlus],['print','印刷文件',ScanLine],['project','项目备份',Save]] as const).map(([id,label,Icon])=>
    <button key={id} className={mode===id?'selected':''} aria-pressed={mode===id} onClick={()=>setMode(id)}><Icon size={16}/>{label}</button>)}
  </div>
  <div className="export-layout">
  <div className="export-setup">
   <div className="section-heading">导出设置</div>
   {mode!=='project'&&<><label className="field">导出卡面<select value={sides.length===2?'both':sides[0]} onChange={e=>setSides(e.target.value==='both'?['front','back']:[e.target.value as SideName])}><option value="both">正反两面</option><option value="front">仅正面</option><option value="back">仅背面</option></select></label><div className="field-grid"><label className="field">{mode==='print'?'输出配置':'文件格式'}{mode==='print'?<select value={profile} onChange={e=>setProfile(e.target.value as PrintProfile)}><option value="standard">技术配置 A</option><option value="alternate">技术配置 B</option></select>:<select value={format} onChange={e=>setFormat(e.target.value as 'png'|'jpeg')}><option value="png">PNG</option><option value="jpeg">JPEG</option></select>}</label><label className="field">分辨率<select value={dpi} onChange={e=>setDpi(+e.target.value)}><option value={300}>300 ppi</option><option value={600}>600 ppi</option></select></label></div><p className="micro-copy">每面 {pixel(project.widthMm)} × {pixel(project.heightMm)} px{mode==='print'? ' · 含出血':''}</p></>}
   {mode==='image'&&<label className="check-field"><input type="checkbox" checked={effects} onChange={e=>setEffects(e.target.checked)}/>包含材质效果示意</label>}
   {mode==='print'&&<>
    <div className="print-status" role="status"><span className={`status-dot ${service==='online'?'':'warning'}`}/>
     {service==='online'?'本机印前服务在线':service==='checking'?'正在连接本机印前服务':service==='outdated'?'请重启 Prism 以加载新版印前服务':'本机印前服务未连接'}
     {['offline','outdated'].includes(service)&&<button className="text-button" onClick={()=>setServiceCheck(n=>n+1)}>重新检查</button>}
    </div>
    {hasGrain&&<label className="field">局部闪光的生产处理<select value={grain} onChange={e=>setGrain(e.target.value as typeof grain)}>
     <option value="unset">选择处理方式</option><option value="exclude">从生产彩稿排除</option><option value="include">将图案印为彩色图文</option>
    </select></label>}
   </>}
   {mode==='project'&&<p className="micro-copy">备份包括正反面图层、区域、工艺设置与原素材。可从「我的卡牌」重新打开 .cardproj。</p>}
  </div>
  <div className="export-details"><div className="section-heading">{mode==='print'?'印前检查':'文件内容'} <small>v{project.version}</small></div>
   {mode==='image'&&<div className="export-thumbnails">{sides.map(face=><div key={face}><CardThumb project={project} side={face} effects={effects}/><span>{face==='front'?'正面':'背面'}</span></div>)}</div>}
   {mode==='project'&&<ul className="file-list"><li><Check size={14}/>可编辑项目文档</li><li><Check size={14}/>图层素材与区域</li><li><Check size={14}/>校验清单</li></ul>}
   {mode==='print'&&<>
    <p className="print-scope"><strong>技术打样</strong><span>通用 CMYK 彩稿与工艺分版。正式生产需由印厂确认色彩配置、交稿标准和样品。</span></p>
    <div className="preflight">
     {issues.length ? <>
      <p className="preflight-count">{blockers.length} 项需修正 · {notes.length} 项提醒</p>
      {[...blockers,...notes].map((issue,index)=><button key={index} className={issue.blocking?'blocking':''} onClick={()=>onLocate(issue.target)}>
       <AlertTriangle size={15}/><span>{issue.text}</span><ArrowUpRight size={12}/>
      </button>)}
     </> : <span className="preflight-good"><CheckCircle2 size={16}/>当前设计通过基础规则检查</span>}
    </div>
    <div className="section-heading export-file-heading">输出文件</div>
    <ul className="file-list"><li>CMYK 彩稿 <small>artwork.pdf</small></li><li>彩稿与专色合版 <small>composite.pdf</small></li>
     {allPlates.map(key=><li key={key}>{plateLabels[key]} <small>{names[key]} · PDF / TIFF</small></li>)}
     <li>独立工艺层 PDF / TIFF <small>layers/</small></li><li>预检报告、工单、校验清单</li>
    </ul>
   </>}
  </div></div>
  {job&&<div className="job-status" aria-live="polite"><div><strong>{job.label}</strong><span>项目 v{job.request.project.version}{job.request.project.version!==project.version?' · 历史快照':''}</span>{job.error&&<p>{job.error}</p>}</div>{busy?<><progress value={job.progress} max={100}/><Button onClick={()=>abort.current?.abort()}>取消任务</Button></>:job.file?<Button onClick={()=>downloadBlob(job.file!,job.name!)}>再次下载</Button>:job.error?<Button onClick={()=>void run(job.request)}>重试此版本</Button>:null}</div>}
  <div className="modal-footer"><span>{busy?'关闭窗口后任务继续，回来可查看进度。':mode==='print'?printMessage:mode==='project'?'可再次打开并继续编辑':'文件保存到你的设备'}</span><Button className="primary" disabled={busy||blocked} onClick={start}>{busy?<Loader2 className="spin" size={16}/>:<Download size={16}/>} {mode==='image'?'下载图片':mode==='print'?'生成技术打样包':'下载项目包'}</Button></div>
 </Modal>;
}
