import CanvasToolMenu from './CanvasToolMenu';
import './canvas-card-tool.css';

interface CanvasCardToolProps {
  onAdd: () => void;
  onAsset: () => void;
  disabled?: boolean;
}

export default function CanvasCardTool({ onAdd, onAsset, disabled = false }: CanvasCardToolProps) {
  return <div className="canvas-tool-group canvas-card-tool">
    <button type="button" className="button icon-button" title="新增卡牌" aria-label="新增卡牌" disabled={disabled} onClick={onAdd}>
      <img className="figma-icon canvas-add-card-symbol" src="/assets/editor-icons/tool-add-card.svg" alt="" draggable={false}/>
    </button>
    <CanvasToolMenu title="新增卡牌选项" disabled={disabled}>
      <button type="button" onClick={onAdd}>新增空白卡牌</button>
      <button type="button" onClick={onAsset}>从资产添加</button>
    </CanvasToolMenu>
  </div>;
}
