import { useEffect, useRef, useState } from 'react';
import { BorderBeam } from 'border-beam';
import { projectWorkspace } from './projects';

const assets = '/assets/workbench/';
const demoDuration = 6000;

type Step = 'draft' | 'running' | 'stopped' | 'completed';
type Attachment = {
  url: string;
  name: string;
  status: 'loading' | 'ready' | 'error';
};

const messages: Record<Step, string> = {
  draft: '',
  running: '演示生成中',
  stopped: '已停止',
  completed: '演示完成',
};

export default function WorkbenchComposer({ requireAccount }: { requireAccount: (action: () => void) => void }) {
  const [prompt, setPrompt] = useState('');
  const [focused, setFocused] = useState(false);
  const [step, setStep] = useState<Step>('draft');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const replaceAttachment = useRef<string | null>(null);
  const previewUrls = useRef(new Set<string>());
  const running = step === 'running';
  const complete = step === 'completed';
  const expanded = focused || !!prompt || attachments.length > 0 || !!fileError || step !== 'draft';
  const hasContent = !!prompt.trim() || attachments.some(file => file.status === 'ready');
  const canSubmit = hasContent && attachments.every(file => file.status === 'ready') && !running && !complete;
  const actionName = running ? '停止生成' : complete ? '演示完成' : step === 'stopped' ? '重试' : '发送';

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setStep(current => current === 'running' ? 'completed' : current), demoDuration);
    return () => window.clearTimeout(timer);
  }, [running]);

  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const releasePreview = (url: string) => {
    URL.revokeObjectURL(url);
    previewUrls.current.delete(url);
  };

  const pickFiles = (replacement: string | null = null) => {
    requireAccount(()=>{
      replaceAttachment.current = replacement;
      fileInput.current?.click();
    });
  };

  const addFiles = (files: File[]) => {
    const images = files.filter(file => file.type.startsWith('image/'));
    setFileError(images.length === files.length ? '' : '请选择图片');
    if (!images.length) return;
    const replacement = replaceAttachment.current;
    const next = images.map(file => {
      const url = URL.createObjectURL(file);
      previewUrls.current.add(url);
      return { url, name: file.name, status: 'loading' } satisfies Attachment;
    });
    if (replacement) releasePreview(replacement);
    setAttachments(previous => replacement
      ? previous.flatMap(file => file.url === replacement ? next : [file])
      : [...previous, ...next]);
    setStep('draft');
  };

  const setFileStatus = (url: string, status: Attachment['status']) => {
    setAttachments(previous => previous.map(file => file.url === url ? { ...file, status } : file));
  };

  const removeFile = (url: string) => {
    releasePreview(url);
    setAttachments(previous => previous.filter(file => file.url !== url));
    setFileError('');
    setStep('draft');
    input.current?.focus();
  };

  const updatePrompt = (value: string) => {
    setPrompt(value);
    setStep('draft');
  };

  const submit = () => { if (canSubmit) requireAccount(()=>setStep('running')); };

  return <BorderBeam className="workbench-composer-beam" data-workbench-motion>
    <form className={`workbench-composer${expanded ? ' is-expanded' : ''}`} aria-label="AI 创作"
      onSubmit={event => { event.preventDefault(); submit(); }}
      onClick={event => { if (event.target === event.currentTarget) input.current?.focus(); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="选择图片"
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (files.length&&projectWorkspace()) addFiles(files);
        }} />
      {attachments.length > 0 && <ul className="workbench-composer-files" aria-label="已添加的图片">
        {attachments.map(file => <li key={file.url} className="workbench-composer-file" title={file.name}>
          <img src={file.url} alt={file.name} hidden={file.status !== 'ready'}
            onLoad={() => setFileStatus(file.url, 'ready')} onError={() => setFileStatus(file.url, 'error')} />
          {file.status === 'loading' && <span className="workbench-composer-loader" role="status" aria-label="正在读取图片" />}
          {file.status === 'error' && <div className="workbench-composer-file-error">
            <span>读取失败</span>
            {!running && <button type="button" aria-label={`重新选择 ${file.name}`} onClick={() => pickFiles(file.url)}>重试</button>}
          </div>}
          {!running && <button type="button" className="workbench-composer-remove" aria-label={`移除 ${file.name}`}
            onClick={() => removeFile(file.url)}><img src={assets + 'clear.svg'} alt="" /></button>}
        </li>)}
      </ul>}
      <div className="workbench-composer-input-row">
        <textarea ref={input} rows={1} aria-label="创作描述" placeholder="描述你想创作的卡牌，或添加图片"
          value={prompt} readOnly={running} enterKeyHint="send" onFocus={() => setFocused(true)}
          onChange={event => updatePrompt(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            submit();
          }} />
        {!!prompt && !running && <button type="button" className="workbench-composer-clear" aria-label="清空描述" title="清空描述"
          onClick={() => { updatePrompt(''); input.current?.focus(); }}><img src={assets + 'clear.svg'} alt="" /></button>}
      </div>
      {!running && <button type="button" className="workbench-composer-attach" aria-label="添加图片" title="添加图片"
        onClick={() => pickFiles()}><img src={assets + 'attach.svg'} alt="" /></button>}
      {fileError && <span className="workbench-composer-error" role="alert">{fileError}</span>}
      <BorderBeam className="workbench-composer-action" size="sm" borderRadius={18} active={canSubmit || running || complete}>
        <button type={running ? 'button' : 'submit'} disabled={!running && !canSubmit} aria-label={actionName} title={actionName}
          className="workbench-composer-send" onClick={running ? event => {
            event.preventDefault();
            setStep('stopped');
          } : undefined}>
          {running ? <span className="workbench-composer-stop" aria-hidden="true" /> :
            <img className={complete || canSubmit ? 'is-bright' : undefined}
              src={assets + (complete ? 'composer-complete.svg' : step === 'stopped' ? 'composer-retry.svg' : 'send-idle.svg')} alt="" />}
        </button>
      </BorderBeam>
      <span className="sr-only" role="status">{messages[step]}</span>
    </form>
  </BorderBeam>;
}

