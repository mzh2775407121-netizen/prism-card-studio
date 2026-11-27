import { useEffect, useId, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { EyeOff } from 'lucide-react';
import { AuthShowcase } from './AuthShowcase';
import { accountLink, CommunityRequestError, communityRequest, type Account } from './communityClient';
import { changeWorkspace } from './projects';
import './sign-in.css';

type Entry = 'login' | 'verify' | 'reset';
type Mode = Entry | 'password' | 'recover' | 'new-password' | 'resend';
type Feedback = { intent: 'success' | 'error' | 'notice'; text: string; code?: boolean };
type SignInProps = {
  onDone: (account: Account) => void;
  onClose: () => void;
  onMailLink: () => void;
  initial: Entry;
  token: string;
};

const asset = '/assets/auth/';
const titles: Record<Mode, string> = {
  login: '欢迎登录 Prism',
  password: '密码登录',
  recover: '找回密码',
  'new-password': '设置新密码',
  verify: '验证邮箱',
  reset: '设置新密码',
  resend: '重发验证邮件',
};
const actions: Record<Mode, string> = {
  login: '登录 / 注册',
  password: '登录',
  recover: '下一步',
  'new-password': '保存并登录',
  verify: '验证邮箱',
  reset: '保存密码',
  resend: '重发邮件',
};
const slides: Record<Mode, number> = { login: 0, password: 1, recover: 2, 'new-password': 3, reset: 3, verify: 0, resend: 0 };

function Field({children, className = '', ...props}: InputHTMLAttributes<HTMLInputElement> & {children?: ReactNode}) {
  return <div className={'sign-in-field ' + className}>
    <input {...props}/>
    {children}
  </div>;
}

function PasswordField(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return <Field {...props} type={visible ? 'text' : 'password'}>
    <button type="button" className="sign-in-reveal" aria-label={visible ? '隐藏密码' : '显示密码'}
      aria-pressed={visible} onClick={()=>setVisible(value=>!value)}>
      {visible ? <EyeOff size={16} strokeWidth={1.5} aria-hidden/> : <img src={asset+'eye.svg'} alt="" width={16} height={16}/>}
    </button>
  </Field>;
}

export function SignInDialog({onDone, onClose, onMailLink, initial, token}: SignInProps) {
  const [mode, setMode] = useState<Mode>(initial);
  const [slide, setSlide] = useState(slides[initial]);
  const [paused, setPaused] = useState(false);
  const [email, setEmail] = useState('');
  const [identity, setIdentity] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [feedback, setFeedback] = useState<Feedback>();
  const [providerNotice, setProviderNotice] = useState(false);
  const [busy, setBusy] = useState<'send' | 'submit'>();
  const sends = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now);
  const dialog = useRef<HTMLDialogElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const title = useId(), feedbackId = useId();
  const emailAddress = email.trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress);
  const usesCode = mode === 'login' || mode === 'recover';
  const isLogin = mode === 'login' || mode === 'password';
  const sendKey = (mode === 'recover' ? 'reset:' : 'login:') + emailAddress;
  const deadline = sends.current.get(sendKey);
  const seconds = Math.max(0, Math.ceil(((deadline ?? 0) - now) / 1000));
  const countingDown = seconds>0;

  useEffect(()=>{
    const element = dialog.current;
    const trigger = document.activeElement;
    mounted.current = true;
    element?.showModal();
    element?.focus({preventScroll:true});
    return ()=>{
      mounted.current = false;
      element?.close();
      if(trigger instanceof HTMLElement && trigger.isConnected)trigger.focus({preventScroll:true});
    };
  }, []);

  useEffect(()=>{
    if(initial !== 'login')return;
    const closeForMailLink = ()=>{if(accountLink())onMailLink();};
    closeForMailLink();
    window.addEventListener('hashchange', closeForMailLink);
    return ()=>window.removeEventListener('hashchange', closeForMailLink);
  }, [initial,onMailLink]);

  useEffect(()=>{
    if(!countingDown)return;
    const timer = window.setInterval(()=>setNow(Date.now()), 250);
    return ()=>window.clearInterval(timer);
  }, [countingDown]);

  useEffect(()=>{
    if(paused || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches)return;
    const timer = window.setTimeout(()=>setSlide((slide+1)%4), 6500);
    return ()=>window.clearTimeout(timer);
  }, [paused,slide,mode]);

  function move(next: Mode, notice?: Feedback) {
    if(next==='password' && email) setIdentity(email);
    if((next==='recover'||next==='resend'||next==='login') && (!email||mode==='password') && identity.includes('@'))setEmail(identity);
    setMode(next);
    setSlide(slides[next]);
    setNow(Date.now());
    setCode('');
    setPassword('');
    setRepeated('');
    setFeedback(notice);
    setProviderNotice(false);
    if(next !== 'new-password')setResetToken('');
  }

  async function sendCode() {
    if(pending.current || !validEmail || (deadline ?? 0)>Date.now())return;
    pending.current = true;
    setBusy('send');
    setFeedback(undefined);
    try {
      const response = await communityRequest<{retryAfter:number}>(
        mode==='recover' ? 'request-password-code' : 'request-email-code', {email:emailAddress});
      if(!mounted.current)return;
      const timestamp = Date.now();
      sends.current.set(sendKey, timestamp + response.retryAfter*1000);
      setNow(timestamp);
      setCode('');
      setFeedback({intent:'success',text:'验证码已发送至邮箱'});
    } catch(error) {
      if(mounted.current)setFeedback({intent:'error',text:messageFor(error)});
    } finally {
      pending.current = false;
      if(mounted.current)setBusy(undefined);
      if(mounted.current && sends.current.has(sendKey))requestAnimationFrame(()=>codeInput.current?.focus());
    }
  }

  const canSubmit = usesCode ? validEmail && code.length===6
    : mode==='password' ? Boolean(identity.trim() && password)
    : mode==='verify' ? Boolean(token && password)
    : mode==='resend' ? validEmail
    : Boolean((mode==='reset' ? token : resetToken) && password.length>=8 && repeated);

  function signedIn(account: Account) {
    if(mounted.current)onDone(account);
    else changeWorkspace(account.id);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(pending.current || !canSubmit)return;
    if((mode==='new-password' || mode==='reset') && password!==repeated) {
      setFeedback({intent:'error',text:'两次输入的密码不一致'});
      return;
    }
    pending.current = true;
    setBusy('submit');
    setFeedback(undefined);
    setProviderNotice(false);
    try {
      if(mode==='login') {
        signedIn(await communityRequest<Account>('login-email-code',{email:emailAddress,code}));
      } else if(mode==='password') {
        signedIn(await communityRequest<Account>('login',{identity:identity.trim(),password}));
      } else if(mode==='recover') {
        const result=await communityRequest<{token:string}>('verify-password-code',{email:emailAddress,code});
        if(mounted.current){setResetToken(result.token);move('new-password');}
      } else if(mode==='new-password') {
        signedIn(await communityRequest<Account>('reset-password-code',{token:resetToken,password}));
      } else if(mode==='resend') {
        const result=await communityRequest<{message:string}>('resend-verification',{email:emailAddress});
        if(mounted.current)setFeedback({intent:'notice',text:result.message});
      } else {
        const result=await communityRequest<{message:string}>(mode==='verify'?'verify-email':'reset-password',{token,password});
        if(mode==='reset')changeWorkspace('guest');
        if(mounted.current)move('password',{intent:'success',text:result.message});
      }
    } catch(error) {
      if(mounted.current)setFeedback({intent:'error',text:messageFor(error),
        code: usesCode && error instanceof CommunityRequestError && [400,401,410].includes(error.status)});
    } finally {
      pending.current = false;
      if(mounted.current)setBusy(undefined);
    }
  }

  const emailField = <Field aria-label="邮箱" type="email" autoComplete="email" placeholder="请输入邮箱地址"
    value={email} required maxLength={254} onChange={event=>{setEmail(event.target.value);setNow(Date.now());setCode('');setFeedback(undefined);}}/>;
  const codeField = <div className={'sign-in-field sign-in-code'+(feedback?.code?' is-invalid':'')+(code.length===6?' is-filled':'')}>
    <input ref={codeInput} aria-label="邮箱验证码" type="text" inputMode="numeric" autoComplete="one-time-code"
      placeholder="请输入 6 位验证码" required value={code} aria-invalid={feedback?.code||undefined}
      aria-describedby={feedback ? feedbackId : undefined}
      onChange={event=>{setCode(event.target.value.replace(/[^0-9]/g,'').slice(0,6));if(feedback?.intent==='error')setFeedback(undefined);}}/>
    <button type="button" className="sign-in-send" disabled={!validEmail||!!seconds||!!busy} onClick={()=>void sendCode()}>
      {busy==='send'?'正在发送…':seconds?`${seconds}s 后重发`:deadline?'重新发送':'发送验证码'}
    </button>
  </div>;
  const message = feedback && <p id={feedbackId} role={feedback.intent==='error'?'alert':'status'}
    className={'sign-in-message is-'+feedback.intent}>{feedback.text}</p>;
  return <dialog className="prism-sign-in" ref={dialog} tabIndex={-1} aria-labelledby={title}
    onCancel={event=>{event.preventDefault();if(!pending.current)onClose();}}>
    <div className="sign-in-layout">
      <div className="sign-in-visual" onPointerEnter={()=>setPaused(true)} onPointerLeave={()=>setPaused(false)}
        onFocus={()=>setPaused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setPaused(false);}}>
        <AuthShowcase slide={slide} onSlide={setSlide}/>
      </div>
      <div className="sign-in-panel">
        <button type="button" className="sign-in-close" aria-label="关闭" disabled={!!busy} onClick={onClose}>
          <img src={asset+'close.svg'} width={13} height={13} alt=""/>
        </button>
        <div className="sign-in-main">
          <header className="sign-in-heading">
            {mode==='recover'||mode==='new-password'||mode==='reset'||mode==='resend' ?
              <button type="button" className="sign-in-link sign-in-back" disabled={!!busy}
                onClick={()=>move(mode==='new-password'?'recover':mode==='recover'?'password':'login')}>
                <img src={asset+'back.svg'} width={14} height={14} alt=""/>{mode==='new-password'?'返回上一步':'返回登录'}
              </button> :
              <div className="sign-in-brand"><img src={asset+'brand.svg'} width={24} alt=""/><span>Prism</span></div>}
            <h2 id={title}>{titles[mode]}</h2>
            {mode==='recover' && <p>输入你的注册邮箱，验证身份后即可重设登录密码</p>}
            {mode==='new-password' && <p>为 {emailAddress} 设置新的登录密码</p>}
          </header>
          <form onSubmit={submit} key={mode}>
            <fieldset className="sign-in-fields" disabled={!!busy}>
              {usesCode && <>{emailField}{codeField}</>}
              {mode==='resend' && emailField}
              {mode==='password' && <Field aria-label="邮箱或账号名" autoComplete="username" placeholder="请输入邮箱或账号名"
                value={identity} required maxLength={254} onChange={event=>{setIdentity(event.target.value);setFeedback(undefined);}}/>}
              {(mode==='password'||mode==='verify') && <PasswordField aria-label={mode==='verify'?'账号密码':'密码'}
                autoComplete="current-password" placeholder={mode==='verify'?'请输入账号密码':'请输入密码'} required maxLength={128}
                value={password} onChange={event=>{setPassword(event.target.value);setFeedback(undefined);}}/>}
              {(mode==='reset'||mode==='new-password') && <>
                <PasswordField aria-label="新密码" autoComplete="new-password" placeholder="请输入新密码（至少 8 位）"
                  required minLength={8} maxLength={128} value={password} onChange={event=>setPassword(event.target.value)}/>
                <PasswordField aria-label="确认新密码" autoComplete="new-password" placeholder="请再次输入新密码"
                  required maxLength={128} value={repeated} onChange={event=>setRepeated(event.target.value)}/>
              </>}
              {mode==='login' ? <div className="sign-in-meta">
                {message ?? <span/>}<button type="button" className="sign-in-link" onClick={()=>move('password')}>使用密码登录</button>
              </div> : mode==='password' ? <>
                <div className="sign-in-meta">
                  <button type="button" className="sign-in-link" onClick={()=>move('login')}>验证码登录</button>
                  <button type="button" className="sign-in-link" onClick={()=>move('recover')}>忘记密码？</button>
                </div>{message}
              </> : <>{mode==='verify' && <p className="sign-in-message">验证后，即可使用账号资产和社区功能。</p>}{message}</>}
              <button type="submit" className="sign-in-primary" disabled={!canSubmit||!!busy}>
                {busy==='submit'?'正在处理…':actions[mode]}
              </button>
              {mode==='verify' && <button type="button" className="sign-in-link" onClick={()=>move('resend')}>重发验证邮件</button>}
            </fieldset>
          </form>
          {isLogin && <div className="sign-in-provider">
            <div className="sign-in-divider">其他登录方式</div>
            <button type="button" className="sign-in-google" disabled={!!busy} onClick={()=>setProviderNotice(true)}>
              <img src={asset+'google.svg'} width={18} height={18} alt=""/>使用 Google 账号继续
            </button>
            {providerNotice && <p role="status" className="sign-in-message">Google 登录暂未接入，请使用邮箱或密码。</p>}
          </div>}
        </div>
        <p className="sign-in-footer">
          {isLogin?'未注册邮箱将自动创建账号':mode==='recover'?'未收到邮件？请检查垃圾邮件箱，或 60 秒后重新发送':
            mode==='new-password'?'保存成功后将自动为你登录 Prism 工作台':''}
        </p>
      </div>
    </div>
  </dialog>;
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
