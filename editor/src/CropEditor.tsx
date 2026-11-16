import { useEffect, useRef, useState } from 'react';
import type { CardNode, ImageCrop } from './model';
import { coverCrop, imageCrop, loadImage } from './render';
import './crop-editor.css';

type Frame = Omit<ImageCrop, 'space'>;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function normalize(image: HTMLImageElement, frame: Frame): Frame {
  return { x: frame.x / image.naturalWidth, y: frame.y / image.naturalHeight,
    width: frame.width / image.naturalWidth, height: frame.height / image.naturalHeight };
}

function reposition(frame: Frame, x: number, y: number): Frame {
  return { ...frame, x: clamp(x, 0, 1 - frame.width), y: clamp(y, 0, 1 - frame.height) };
}

export function CroppedImage({ node }: { node: CardNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!node.src || !target) return;
    let current = true;
    loadImage(node.src).then(image => {
      if (!current) return;
      const crop = imageCrop(image, node);
      const scale = Math.min(360 / node.width, 200 / node.height);
      target.width = Math.max(1, Math.round(node.width * scale));
      target.height = Math.max(1, Math.round(node.height * scale));
      const context = target.getContext('2d');
      if (!context) return;
      if (node.cornerRadius) {
        context.beginPath();
        context.roundRect(0, 0, target.width, target.height, node.cornerRadius * scale);
        context.clip();
      }
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, target.width, target.height);
    }).catch(() => target.getContext('2d')?.clearRect(0, 0, target.width, target.height));
    return () => { current = false; };
  }, [node]);
  return <canvas ref={canvas} role="img" aria-label={`${node.name}的裁切预览`} />;
}

export default function CropEditor({ node, onCancel, onApply }: {
  node: CardNode;
  onCancel: () => void;
  onApply: (crop: ImageCrop) => void;
}) {
  const [source, setSource] = useState<{ width: number; height: number; cover: Frame }>();
  const [frame, setFrame] = useState<Frame>();
  const [failed, setFailed] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  useEffect(() => {
    let current = true;
    if (node.src) loadImage(node.src).then(image => {
      if (!current) return;
      setSource({ width: image.naturalWidth, height: image.naturalHeight, cover: normalize(image, coverCrop(image, node)) });
      const original = normalize(image, imageCrop(image, node));
      setFrame(reposition({ ...original, width: clamp(original.width, .001, 1),
        height: clamp(original.height, .001, 1) }, original.x, original.y));
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [node]);

  if (!source || !frame) return <p role="status">{failed ? '图片无法读取，请替换源图片后重试。' : '正在读取原图…'}</p>;
  const ratio = Math.min(1, 590 / source.width, 410 / source.height);
  const zoom = source.cover.width / frame.width;
  const resize = (nextZoom: number) => {
    const width = source.cover.width / nextZoom, height = source.cover.height / nextZoom;
    setFrame(reposition({ x: 0, y: 0, width, height }, frame.x + (frame.width - width) / 2, frame.y + (frame.height - height) / 2));
  };
  return <div className="crop-editor">
    <div className="crop-source" ref={area} style={{ width: source.width * ratio, aspectRatio: `${source.width} / ${source.height}` }}>
      <img src={node.src} alt="原始图片" draggable={false} />
      <div className="crop-frame" tabIndex={0} role="group" aria-label="裁切框，可拖动或用方向键移动"
        style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, height: `${frame.height * 100}%` }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, left: frame.x, top: frame.y };
        }}
        onPointerMove={event => {
          const start = drag.current, bounds = area.current?.getBoundingClientRect();
          if (!start || !bounds) return;
          setFrame(reposition(frame, start.left + (event.clientX - start.x) / bounds.width,
            start.top + (event.clientY - start.y) / bounds.height));
        }}
        onLostPointerCapture={() => { drag.current = undefined; }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? .025 : .005;
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
          setFrame(reposition(frame, frame.x + dx, frame.y + dy));
        }}><span aria-hidden="true" /></div>
    </div>
    <label className="range-field"><span>放大裁切 <b>{zoom.toFixed(2)}×</b></span><input type="range" aria-label="放大裁切"
      min={1} max={Math.max(6, Math.ceil(zoom))} step="0.01" value={Math.max(1, zoom)} onChange={event => resize(+event.target.value)} /></label>
    <div className="crop-actions">
      <button className="button" onClick={() => setFrame(source.cover)}>重置</button>
      <button className="button" onClick={onCancel}>取消</button>
      <button className="button primary" onClick={() => onApply({ ...frame, space: 'source' })}>应用裁切</button>
    </div>
  </div>;
}
