import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { accountLink, accountName, communityRequest, type Account } from './communityClient';
import { changeWorkspace } from './projects';
import { SignInDialog } from './SignInDialog';
import './community.css';

type AccountFormProps = {
  onDone: (user: Account) => void;
  onClose: () => void;
  onMailLink?: () => void;
  initial?: 'login' | 'verify' | 'reset' | 'settings';
  token?: string;
  account?: Account | null;
};

export function AccountForm({onDone,onClose,onMailLink=onClose,initial='login',token='',account}: AccountFormProps) {
  return initial==='settings' ?
    <AccountSettings onDone={onDone} onClose={onClose} onMailLink={onMailLink} account={account}/> :
    <SignInDialog onDone={onDone} onClose={onClose} onMailLink={onMailLink} initial={initial} token={token}/>;
}

const settings = {
  settings:{title:'账号设置',action:'保存昵称'},
  bind:{title:'绑定邮箱',action:'发送确认邮件'},
  password:{title:'修改密码',action:'保存密码'},
};

function AccountSettings({onDone,onClose,onMailLink,account}: Pick<AccountFormProps,'onDone'|'onClose'|'onMailLink'|'account'>) {
  const [mode,setMode]=useState<keyof typeof settings>('settings');
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const focusField=useRef<HTMLInputElement>(null);
  const pending=useRef(false);
  const mounted=useRef(false);
  const title=useId();
  useEffect(()=>{
    mounted.current=true;
    const element=dialog.current;
    const prior=document.activeElement;
    element?.showModal();
    return ()=>{mounted.current=false;element?.close();if(prior instanceof HTMLElement&&prior.isConnected)prior.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{focusField.current?.focus({preventScroll:true});},[mode]);
  useEffect(()=>{
    const closeForMailLink=()=>{if(accountLink())onMailLink?.();};
    closeForMailLink();
    window.addEventListener('hashchange',closeForMailLink);
    return ()=>window.removeEventListener('hashchange',closeForMailLink);
  },[onMailLink]);

  function move(next:keyof typeof settings) {
    setMode(next);setError('');setMessage('');
  }

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(pending.current)return;
    const fields=Object.fromEntries(new FormData(event.currentTarget));
    pending.current=true;setBusy(true);setError('');setMessage('');
    try {
      if(mode==='settings') {
        const saved=await communityRequest<Account>('profile',fields);
        if(mounted.current)onDone(saved);
        return;
      }
      const response=await communityRequest<{message?:string}>(mode==='bind'?'bind-email':'change-password',fields);
      if(mode==='password')changeWorkspace('guest');
      if(mounted.current)setMessage(response.message||'操作已完成');
    } catch (exception) {
      if(mounted.current)setError(exception instanceof Error?exception.message:'操作未完成，请重试。');
    } finally {
      pending.current=false;if(mounted.current)setBusy(false);
    }
  }

  return <dialog ref={dialog} className="community-auth" aria-labelledby={title} onCancel={event=>{event.preventDefault();if(!pending.current)onClose();}}>
    <form onSubmit={submit}>
      <div className="community-heading"><h2 id={title}>{settings[mode].title}</h2><button type="button" className="cm-icon" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16}/></button></div>
      <fieldset disabled={busy} className="account-form-fields" key={mode}>
        {mode==='settings'&&<>
          <label>公开昵称<input ref={focusField} required name="displayName" minLength={2} maxLength={32} autoComplete="nickname" defaultValue={accountName(account)}/></label>
          <p className="cm-muted">{account?.email??'尚未绑定邮箱'}</p>
        </>}
        {mode==='bind'&&<label>邮箱<input ref={focusField} required type="email" name="email" maxLength={254} autoComplete="email"/></label>}
        {mode!=='settings'&&<label>当前密码<input required type="password" name={mode==='password'?'currentPassword':'password'} maxLength={128} autoComplete="current-password"/></label>}
        {mode==='password'&&<label>新密码<input required type="password" name="newPassword" minLength={8} maxLength={128} placeholder="至少 8 位" autoComplete="new-password"/></label>}
      </fieldset>
      {message&&<p className="account-form-notice" role="status">{message}</p>}
      {error&&<p className="cm-error" role="alert">{error}</p>}
      <div className="cm-actions account-form-actions">
        <div className="account-form-links">
          {mode==='settings' ?
            <button type="button" className="cm-link" disabled={busy} onClick={()=>move(account?.email?'password':'bind')}>{account?.email?'修改密码':'绑定邮箱'}</button> :
            <button type="button" className="cm-link" disabled={busy} onClick={()=>move('settings')}>返回设置</button>}
        </div>
        <button disabled={busy} className="cm-btn primary">{busy?'正在处理…':settings[mode].action}</button>
      </div>
    </form>
  </dialog>;
}
