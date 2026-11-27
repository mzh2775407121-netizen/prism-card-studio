import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { RotateCcw, Rotate3D } from 'lucide-react';
import {
  Box3, DirectionalLight, Group, HemisphereLight, Material, Mesh, MeshBasicMaterial, NoToneMapping, OrthographicCamera,
  Scene, SRGBColorSpace, Texture, Vector3, WebGLRenderer, type BufferGeometry, type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

type ViewState = 'loading' | 'ready' | 'error';
type Drag = { id: number; x: number; y: number };
const PITCH_LIMIT = Math.PI * .46;
const KEY_STEP = Math.PI / 18;
const DRAG_STEP = .009;
const mmFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });

function artworkMaterials(card: Object3D, anisotropy: number) {
  const materials = new Map<Material, MeshBasicMaterial>();
  card.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const asUnlit = (source: Material) => {
      let material = materials.get(source);
      if (!material) {
        const face = source as Partial<MeshBasicMaterial>;
        material = new MeshBasicMaterial({
          color: face.color,
          map: face.map,
          opacity: source.opacity,
          alphaTest: source.alphaTest,
          transparent: source.transparent,
          side: source.side,
          toneMapped: false,
        });
        if (material.map) {
          material.map.colorSpace = SRGBColorSpace;
          material.map.anisotropy = anisotropy;
        }
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(asUnlit) : asUnlit(object.material);
  });
  return materials.keys();
}

function disposeCard(card: Object3D, previous: Iterable<Material>) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set(previous);
  const textures = new Set<Texture>();
  const bitmaps = new Set<ImageBitmap>();
  card.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
    texture.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const bitmap of bitmaps) bitmap.close();
}

export default function ExportModelPreview({ model }: { model: Blob }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const orientation = useRef({ yaw: 0, pitch: 0 });
  const redraw = useRef<(() => void) | undefined>(undefined);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<ViewState>('loading');
  const [attempt, setAttempt] = useState(0);
  const [dimensions, setDimensions] = useState('');

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let closed = false;
    let renderer: WebGLRenderer | undefined;
    let card: Object3D | undefined;
    let originals: Iterable<Material> = [];
    let resizeObserver: ResizeObserver | undefined;
    let frame = 0;
    orientation.current = { yaw: 0, pitch: 0 };
    drag.current = null;
    setDragging(false);
    setState('loading');

    const contextLost = () => setState('error');
    const release = () => {
      redraw.current = undefined;
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      if (card) {
        disposeCard(card, originals);
        card = undefined;
      }
      if (renderer) {
        renderer.domElement.removeEventListener('webglcontextlost', contextLost);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        renderer = undefined;
      }
    };

    const load = async () => {
      const buffer = await model.arrayBuffer();
      if (closed) return;
      const loaded = await new GLTFLoader().parseAsync(buffer, '');
      if (closed) {
        disposeCard(loaded.scene, []);
        return;
      }
      card = loaded.scene;
      const bounds = new Box3().setFromObject(card);
      const size = bounds.getSize(new Vector3());
      const diameter = size.length();
      if (!Number.isFinite(diameter) || diameter <= 0) throw new Error('GLB 缺少可预览的卡牌');

      // Rotate the recentered model around the group's origin, never the cursor.
      card.position.sub(bounds.getCenter(new Vector3()));
      const pivot = new Group();
      pivot.add(card);
      const scene = new Scene();
      scene.add(pivot);
      const camera = new OrthographicCamera(-1, 1, 1, -1, diameter / 100, diameter * 6);
      camera.position.z = diameter * 2;
      camera.lookAt(0, 0, 0);

      const view = new WebGLRenderer({ alpha: true, antialias: true });
      renderer = view;
      view.outputColorSpace = SRGBColorSpace;
      view.toneMapping = NoToneMapping;
      if (loaded.parser.json.extensionsUsed?.includes('KHR_materials_unlit')) {
        originals = artworkMaterials(card, Math.min(8, view.capabilities.getMaxAnisotropy()));
      } else {
        const key = new DirectionalLight(0xffffff, 2.1);
        key.position.set(.8, .03, 1);
        scene.add(new HemisphereLight(0xffffff, 0x94a8bc, .8), key);
      }
      view.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      view.domElement.setAttribute('aria-hidden', 'true');
      view.domElement.addEventListener('webglcontextlost', contextLost);
      viewport.prepend(view.domElement);

      const draw = () => {
        frame = 0;
        const { yaw, pitch } = orientation.current;
        pivot.rotation.set(pitch, yaw, 0, 'YXZ');
        view.render(scene, camera);
      };
      redraw.current = () => {
        if (!frame) frame = requestAnimationFrame(draw);
      };
      const fit = () => {
        const { clientWidth: width, clientHeight: height } = viewport;
        if (width <= 0 || height <= 0) return;
        const aspect = width / height;
        const halfHeight = Math.max(size.y, size.x / aspect) * .61;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.updateProjectionMatrix();
        view.setSize(width, height, false);
        redraw.current?.();
      };
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(viewport);
      fit();
      setDimensions(size.toArray().map(measure => mmFormatter.format(measure * 1000)).join(' × ') + ' mm');
      setState('ready');
    };
    void load().catch(() => {
      if (!closed) {
        release();
        setState('error');
      }
    });
    return () => {
      closed = true;
      release();
    };
  }, [model, attempt]);

  const rotate = (x: number, y: number) => {
    orientation.current.yaw += x;
    orientation.current.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, orientation.current.pitch + y));
    redraw.current?.();
  };
  const reset = () => {
    orientation.current = { yaw: 0, pitch: 0 };
    redraw.current?.();
  };
  const flip = () => {
    const facingBack = Math.cos(orientation.current.yaw) < 0;
    orientation.current = { yaw: facingBack ? 0 : Math.PI, pitch: 0 };
    redraw.current?.();
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (state !== 'ready' || !event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.id) return;
    rotate((event.clientX - start.x) * DRAG_STEP, (event.clientY - start.y) * DRAG_STEP);
    start.x = event.clientX;
    start.y = event.clientY;
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== drag.current?.id) return;
    drag.current = null;
    setDragging(false);
  };
  const keyRotate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (state !== 'ready' || event.target !== event.currentTarget) return;
    if (event.key === 'ArrowLeft') rotate(-KEY_STEP, 0);
    else if (event.key === 'ArrowRight') rotate(KEY_STEP, 0);
    else if (event.key === 'ArrowUp') rotate(0, -KEY_STEP);
    else if (event.key === 'ArrowDown') rotate(0, KEY_STEP);
    else if (event.key === 'Home') reset();
    else return;
    event.preventDefault();
  };

  return <div className="export-model-preview" data-state={state}>
    <div className="export-model-viewport" ref={viewportRef} data-dragging={dragging}
      tabIndex={state === 'ready' ? 0 : -1} role="application" aria-label="卡牌 3D 预览"
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={keyRotate}>
      {state !== 'ready' && <p role="status" className="export-model-status">
        {state === 'loading' ? '正在打开 3D 模型…' : '无法显示 3D 模型'}
      </p>}
    </div>
    <div className="export-model-actions">
      {state === 'ready' && <span className="export-model-dimensions" title="宽 × 高 × 厚">{dimensions}</span>}
      {state === 'error' ? <button className="button" type="button" onClick={() => setAttempt(n => n + 1)}>重试</button> : <>
        <button className="button" type="button" onClick={flip} disabled={state !== 'ready'}><Rotate3D size={15} />翻面</button>
        <button className="button" type="button" onClick={reset} disabled={state !== 'ready'}><RotateCcw size={15} />重置视角</button>
      </>}
    </div>
  </div>;
}
