import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { loadInspectorFace, type InspectorFace } from './albumInspectorAssets';
import { getCardCornerRadiusMm, type Project, type SideName } from './model';
import { isTransparentStock } from './stockMaterials';
import { INSPECTOR_BACKGROUND, INSPECTOR_PERSPECTIVE, paintInspectorFace, type InspectorLight, type StillView } from './stillExport';
import './album-materials.css';
import './album-preview.css';

// Motion ported from 藏光's CardInspector.jsx and HoloCard.jsx.
const POPOVER = { stiffness: .033, damping: .45 };
const INTERACT = { stiffness: .066, damping: .25 };
const TILT = { stiffness: .05, damping: .5 };
const MAX_YAW = 9;
const MAX_PITCH = 7;
const spring = (value: number) => ({ value, last: value, target: value });
type Spring = ReturnType<typeof spring>;
type Light = { x: number; y: number; o: number };
type Phase = 'loading' | 'entering' | 'open' | 'closing' | 'error';

function step(s: Spring, dt: number, { stiffness, damping }: typeof POPOVER, precision = .01) {
  const velocity = (s.value - s.last) / dt;
  const delta = s.target - s.value;
  const movement = (velocity + stiffness * delta - damping * velocity) * dt;
  s.last = s.value;
  s.value = Math.abs(delta) < precision && Math.abs(movement) < precision ? s.target : s.value + movement;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const rest: Light = { x: 50, y: 50, o: 0 };
const openedCards = new Set<string>();

function frameLight(x: number, y: number, opacity: number): InspectorLight {
  return { x: Math.round(clamp(x) * 4) / 4, y: Math.round(clamp(y) * 4) / 4,
    opacity: Math.round(clamp(opacity * 100)) / 100 };
}

function CardFace({ face, canvas, visible, transparent }: {
  face: SideName; canvas: RefObject<HTMLCanvasElement | null>; visible: boolean; transparent: boolean;
}) {
  return <div className={'card__front inspector-card-face ' + face} aria-hidden={!visible}
    style={transparent ? { backgroundColor: 'transparent' } : undefined}>
    <canvas ref={canvas} role="img" aria-label={face === 'front' ? '卡片正面' : '卡片背面'}/>
  </div>;
}

export default function AlbumPreview({ project, initialSide, cardBoundsRef, material, onClose, onExport }: {
  project: Project;
  initialSide: SideName;
  cardBoundsRef: RefObject<HTMLDivElement | null>;
  material?: string;
  onClose: () => void;
  onExport: (view: StillView) => void;
}) {
  const initialFace = project.singleSided ? 'front' : initialSide;
  const transparent = isTransparentStock(project.material);
  const [phase, setPhase] = useState<Phase>('loading');
  const [side, setSide] = useState(initialFace);
  const [faces, setFaces] = useState<Record<SideName, InspectorFace>>();
  const [retry, setRetry] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const arena = useRef<HTMLDivElement>(null);
  const flight = useRef<HTMLDivElement>(null);
  const rotor = useRef<HTMLButtonElement>(null);
  const frontCanvas = useRef<HTMLCanvasElement>(null);
  const backCanvas = useRef<HTMLCanvasElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const model = useRef<{
    x: Spring; y: Spring; scale: Spring; spin: Spring; rx: Spring; ry: Spring;
    gx: Spring; gy: Spring; opacity: Spring; started: number; reveal: boolean; closing: boolean; fade: boolean;
  }>(undefined);
  const hiddenCanvas = useRef<HTMLElement | null>(null);
  const pointer = useRef<Light>({ ...rest });
  const startPointer = useRef<{ x: number; y: number }>(undefined);
  const dragged = useRef(false);
  const leaveTimer = useRef<number>(undefined);
  const frame = useRef(0);
  const previousTick = useRef(0);
  const lastLight = useRef(0);
  const painted = useRef<{ side: SideName; light: InspectorLight }>(undefined);
  const turningSide = useRef(false);
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const completed = useRef(false);
  const callback = useRef(onClose);
  callback.current = onClose;

  const returnPose = useCallback(() => {
    const rect = arena.current?.getBoundingClientRect();
    const target = flight.current;
    const source = cardBoundsRef.current?.getBoundingClientRect();
    const canvas = cardBoundsRef.current?.parentElement?.getBoundingClientRect();
    const visible = source && canvas && source.width <= canvas.width * 1.5 && source.height <= canvas.height * 1.5 &&
      Math.max(source.left, canvas.left, 0) < Math.min(source.right, canvas.right, window.innerWidth) &&
      Math.max(source.top, canvas.top, 0) < Math.min(source.bottom, canvas.bottom, window.innerHeight);
    if (!rect || !target?.offsetWidth || !target.offsetHeight || !source || !visible) {
      return { x: 0, y: 18, scale: .92, hasSource: false };
    }
    return {
      x: source.x + source.width / 2 - (rect.x + rect.width / 2),
      y: source.y + source.height / 2 - (rect.y + rect.height / 2),
      scale: Math.min(source.width / target.offsetWidth, source.height / target.offsetHeight),
      hasSource: true,
    };
  }, [cardBoundsRef]);

  function tick(now: number) {
    frame.current = 0;
    const m = model.current;
    const card = flight.current;
    if (!m || !card || completed.current) return;
    const dt = Math.max(.25, Math.min(2, (now - previousTick.current) / (1000 / 60)));
    previousTick.current = now;
    const age = now - m.started;
    const turning = Math.abs(m.spin.target - m.spin.value) > .3;
    const sweeping = !m.closing && !reduced.current && (turning || (m.reveal && age < 1000));
    const target = m.closing ? rest : pointer.current;
    const spinRadians = m.spin.value * Math.PI / 180;
    m.gx.target = sweeping ? 50 + Math.sin(spinRadians) * 44 : target.x;
    m.gy.target = sweeping ? 50 - Math.sin(spinRadians * 2) * 22 : target.y;
    m.opacity.target = sweeping ? .85 : target.o;
    m.rx.target = m.closing || reduced.current ? 0 : -(clamp(target.x) - 50) / 50 * MAX_YAW;
    m.ry.target = m.closing || reduced.current ? 0 : (clamp(target.y) - 50) / 50 * MAX_PITCH;
    for (const key of ['x', 'y', 'scale', 'spin'] as const) {
      if (reduced.current) m[key].value = m[key].target;
      else step(m[key], dt, POPOVER, key === 'scale' ? .0005 : .01);
    }
    for (const key of ['gx', 'gy', 'opacity'] as const) {
      if (reduced.current) m[key].value = m[key].target;
      else step(m[key], dt, INTERACT);
    }
    for (const key of ['rx', 'ry'] as const) step(m[key], dt, TILT);
    card.style.transform = 'translate3d(' + m.x.value.toFixed(2) + 'px,' + m.y.value.toFixed(2) + 'px,0) scale(' + m.scale.value.toFixed(4) + ')';
    if (rotor.current) rotor.current.style.transform = 'rotateY(' + (m.spin.value + m.rx.value).toFixed(2) + 'deg) rotateX(' + m.ry.value.toFixed(2) + 'deg)';
    card.dataset.spin = m.spin.value.toFixed(2);
    const settled = Math.abs(m.x.target - m.x.value) < .5 && Math.abs(m.y.target - m.y.value) < .5 &&
      Math.abs(m.scale.target - m.scale.value) < .002 && Math.abs(m.spin.target - m.spin.value) < .3;
    const lightSettled = [m.gx, m.gy, m.opacity, m.rx, m.ry].every(axis => Math.abs(axis.target - axis.value) < .012);
    const visibleSide = Math.cos((m.spin.value + m.rx.value) * Math.PI / 180) >= 0 ? 'front' : 'back';
    if (painted.current?.side !== visibleSide || now - lastLight.current > 1000 / 30 || (settled && lightSettled)) {
      const light = frameLight(m.gx.value, m.gy.value, m.opacity.value);
      const face = faces?.[visibleSide];
      const targetCanvas = visibleSide === 'front' ? frontCanvas.current : backCanvas.current;
      const previous = painted.current;
      if (face && targetCanvas && (previous?.side !== visibleSide || previous.light.x !== light.x ||
        previous.light.y !== light.y || previous.light.opacity !== light.opacity)) {
        paintInspectorFace(targetCanvas, face, light);
        painted.current = { side: visibleSide, light };
      }
      lastLight.current = now;
    }
    if (settled && turningSide.current) {
      turningSide.current = false;
      setFlipping(false);
    }
    if (m.closing) {
      if (m.fade) card.style.opacity = String(Math.max(0, 1 - age / 240));
      if (settled || age > 1800) {
        completed.current = true;
        callback.current();
        return;
      }
    } else if (settled || age > 1800) setPhase('open');
    if (!settled || !lightSettled || sweeping) frame.current = requestAnimationFrame(tick);
  }

  function animate() {
    if (frame.current || completed.current) return;
    previousTick.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  }

  function dismiss() {
    const m = model.current;
    if (m?.closing || completed.current) return;
    if (!m || reduced.current) {
      completed.current = true;
      callback.current();
      return;
    }
    const pose = returnPose();
    m.x.target = pose.x;
    m.y.target = pose.y;
    m.scale.target = pose.scale;
    const facing = initialFace === 'back' ? 180 : 0;
    m.spin.target = facing + Math.round((m.spin.value - facing) / 360) * 360;
    m.rx.target = m.ry.target = 0;
    m.closing = true;
    m.started = performance.now();
    m.fade = !pose.hasSource;
    pointer.current = { ...rest };
    setPhase('closing');
    animate();
  }

  useEffect(() => {
    let live = true;
    const frontFace = loadInspectorFace(project, 'front');
    const backFace = project.singleSided ? frontFace : loadInspectorFace(project, 'back');
    Promise.all([frontFace, backFace])
      .then(([front, back]) => {
        if (live) setFaces({ front, back });
      }).catch(() => { if (live) setPhase('error'); });
    return () => { live = false; };
  }, [project, retry]);

  useLayoutEffect(() => {
    const target = flight.current;
    if (!faces || !target) return;
    const light = model.current ? frameLight(model.current.gx.value, model.current.gy.value, model.current.opacity.value) : frameLight(50, 50, .8);
    if (frontCanvas.current) paintInspectorFace(frontCanvas.current, faces.front, light);
    if (backCanvas.current) paintInspectorFace(backCanvas.current, faces.back, light);
    painted.current = { side: initialFace, light };
    if (model.current) {
      if (phase === 'error') setPhase('open');
      return;
    }
    const pose = returnPose();
    const fromCanvas = pose.hasSource && !reduced.current;
    const first = !openedCards.has(project.id) && !reduced.current;
    openedCards.add(project.id);
    const facing = initialFace === 'back' ? 180 : 0;
    const m = {
      x: spring(fromCanvas ? pose.x : 0), y: spring(fromCanvas ? pose.y : 0),
      scale: spring(fromCanvas ? pose.scale : 1), spin: spring(facing),
      rx: spring(0), ry: spring(0), gx: spring(50), gy: spring(50), opacity: spring(.8),
      started: performance.now(), reveal: first, closing: false, fade: false,
    };
    m.x.target = m.y.target = 0;
    m.scale.target = 1;
    m.spin.target = facing + (first ? 360 : 0);
    model.current = m;
    target.style.transform = 'translate3d(' + m.x.value + 'px,' + m.y.value + 'px,0) scale(' + m.scale.value + ')';
    if (rotor.current) rotor.current.style.transform = 'rotateY(' + facing + 'deg)';
    target.dataset.spin = String(facing);
    if (fromCanvas && cardBoundsRef.current?.parentElement) {
      hiddenCanvas.current = cardBoundsRef.current.parentElement;
      hiddenCanvas.current.setAttribute('data-preview-flight', '');
    }
    setPhase(reduced.current ? 'open' : 'entering');
    animate();
  }, [faces, initialFace, project.id, cardBoundsRef, returnPose]);

  function flip(direction: number) {
    const m = model.current;
    if (project.singleSided || !m || phase !== 'open' || m.closing || turningSide.current) return;
    turningSide.current = true;
    setFlipping(true);
    setSide(previous => previous === 'front' ? 'back' : 'front');
    m.spin.target += 180 * direction;
    m.reveal = false;
    animate();
  }

  const keyboard = useRef({ dismiss, flip });
  keyboard.current = { dismiss, flip };
  useEffect(() => {
    completed.current = false;
    const root = document.getElementById('root');
    const previousFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => { reduced.current = media.matches; animate(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        keyboard.current.dismiss();
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        keyboard.current.flip(event.key === 'ArrowLeft' ? -1 : 1);
      }
      if (event.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
        if (!items?.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    media.addEventListener('change', onPreference);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearTimeout(leaveTimer.current);
      media.removeEventListener('change', onPreference);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = oldOverflow;
      hiddenCanvas.current?.removeAttribute('data-preview-flight');
      if (root) root.inert = false;
      previousFocus?.focus();
    };
  }, []);

  function move(event: PointerEvent<HTMLDivElement>) {
    if (startPointer.current && Math.hypot(event.clientX - startPointer.current.x, event.clientY - startPointer.current.y) > 6) dragged.current = true;
    if (model.current?.closing || !flight.current) return;
    clearTimeout(leaveTimer.current);
    const rect = flight.current.getBoundingClientRect();
    pointer.current = {
      x: clamp((event.clientX - rect.left) / rect.width * 100),
      y: clamp((event.clientY - rect.top) / rect.height * 100), o: 1,
    };
    animate();
  }

  function leave() {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => { pointer.current = { ...rest }; animate(); }, 500);
  }

  function exportView() {
    const m = model.current;
    if (!m || turningSide.current) return;
    onExport({ side, light: painted.current?.light ?? frameLight(m.gx.value, m.gy.value, m.opacity.value),
      yaw: m.spin.value - m.spin.target + m.rx.value, pitch: m.ry.value * (side === 'front' ? 1 : -1),
      perspective: INSPECTOR_PERSPECTIVE / Math.max(1, flight.current?.offsetHeight ?? 1),
      background: INSPECTOR_BACKGROUND });
  }

  const radius = getCardCornerRadiusMm(project);
  const previewVariables = {
    '--card-radius': `${radius / project.widthMm * 100}% / ${radius / project.heightMm * 100}%`,
    '--card-aspect': project.widthMm / project.heightMm,
    '--preview-perspective': INSPECTOR_PERSPECTIVE + 'px',
  } as CSSProperties;
  return createPortal(
    <div className="prism-card-inspector inspector-backdrop source-popover" data-phase={phase}
      style={{ '--preview-background': INSPECTOR_BACKGROUND } as CSSProperties} onClick={event => {
      if (event.currentTarget === event.target) dismiss();
    }}>
      <div ref={dialog} className="inspector" data-phase={phase} style={previewVariables} role="dialog" aria-modal="true" aria-labelledby="inspector-card-title">
        <div className="inspector-top inspector-chrome">
          <button ref={close} className="inspector-icon close-button" onClick={dismiss} aria-label="返回编辑"><X size={19}/></button>
        </div>
        <div ref={arena} className="inspect-arena" onPointerMove={move} onPointerLeave={leave}
          onPointerDown={event => { startPointer.current = { x: event.clientX, y: event.clientY }; dragged.current = false; move(event); }}
          onPointerUp={() => { startPointer.current = undefined; }}
          onPointerCancel={() => { startPointer.current = undefined; leave(); }}>
          {phase === 'error' && !faces ? <button className="inspector-retry" onClick={() => { setPhase('loading'); setRetry(n => n + 1); }}>卡面载入失败，重试</button>
            : !faces ? <span role="status" className="inspector-loading">正在载入卡面…</span>
            : <div ref={flight} className="card-flight">
              <div className="card interactive active interacting masked water holo-inspect" >
                <div className="card__translater">
                  <button ref={rotor} className="card__rotator" aria-label="收回卡片" onClick={event => {
                    if (event.detail && dragged.current) { dragged.current = false; return; }
                    dismiss();
                  }}>
                    <CardFace face="back" canvas={backCanvas} visible={side === 'back'} transparent={transparent}/>
                    <CardFace face="front" canvas={frontCanvas} visible={side === 'front'} transparent={transparent}/>
                  </button>
                </div>
              </div>
            </div>}
        </div>
        <div className="inspect-info inspector-chrome">
          <div><h2 id="inspector-card-title">{project.name}</h2>
            <p>{material} · {project.widthMm} × {project.heightMm} mm · {side === 'front' ? '正面' : '背面'}</p></div>
          {!project.singleSided && <div className="inspect-step">
            <button className="inspector-icon" onClick={() => flip(-1)} disabled={phase !== 'open' || flipping} aria-label="向左翻面"><ChevronLeft size={21}/></button>
            <button className="inspector-icon" onClick={() => flip(1)} disabled={phase !== 'open' || flipping} aria-label="向右翻面"><ChevronRight size={21}/></button>
          </div>}
        </div>
        <div className="inspect-bottom inspector-chrome">
          <p>材质效果示意</p>
          <button className="inspector-icon" onClick={exportView} disabled={phase !== 'open' || flipping} aria-label="导出卡牌" title="导出当前视角"><Download size={17}/></button>
        </div>
        {phase === 'error' && faces && <p className="inspector-loading" role="status">当前样式加载失败。<button onClick={() => setRetry(n => n + 1)}>重试</button></p>}
      </div>
    </div>, document.body,
  );
}
