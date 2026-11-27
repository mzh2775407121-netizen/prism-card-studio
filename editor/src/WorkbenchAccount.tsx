import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccountForm } from './AccountForm';
import { accountName, communityRequest, type Account } from './communityClient';
import { accountWorkspace, changeWorkspace } from './projects';
import { browserRuntime } from './runtime';
import './workbench-account.css';

const assets = '/assets/workbench/';
const help = 'https://github.com/mzh2775407121-netizen/prism-card-studio#readme';
const icon = (name: string) => <img className="account-menu-icon" src={assets + 'account-menu/' + name + '.svg'} width={16} height={16} alt=""/>;

function AccountRow({ name, value, children }: { name: string; value?: string; children: ReactNode }) {
  return <>{icon(name)}<span className="account-menu-row-label">{children}</span>
    {value && <span className="account-menu-row-value">{value}</span>}
    {name !== 'logout' && icon('chevron')}</>;
}

export default function WorkbenchAccount({onArchive, archiveAvailable, archived, onNotice, workspace, requireAccount}:{
  onArchive: () => void;
  archiveAvailable: boolean;
  archived: boolean;
  onNotice: (message: string) => void;
  workspace: string;
  requireAccount: (action: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<'login'|'settings'>();
  const [account, setAccount] = useState<Account | null>();
  const [leaving, setLeaving] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const currentAccount=account?.id===workspace?account:null;
  const loading=accountWorkspace(workspace)&&account===undefined;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({preventScroll:true});
  }

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !group.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({preventScroll:true});
    };
    const moved = () => setOpen(false);
    const changed = () => { setOpen(false); setAccount(undefined); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape);
    window.addEventListener('hashchange', moved);
    window.addEventListener('prism-workspace-changed', changed);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', moved);
      window.removeEventListener('prism-workspace-changed', changed);
    };
  }, [open]);

  useEffect(() => {
    if(accountWorkspace(workspace))setAuth(mode=>mode==='login'?undefined:mode);
  },[workspace]);

  useEffect(() => {
    if (!open || browserRuntime || !accountWorkspace(workspace)) return;
    let current = true;
    communityRequest<Account | null>('session').then(
      user => { if (current) setAccount(user); },
      () => { if (current) setAccount(null); },
    );
    return () => { current = false; };
  }, [open,workspace]);

  async function leaveAccount() {
    if (leaving) return;
    setLeaving(true);
    try {
      await communityRequest('logout', {});
      setAccount(null);
      close(true);
      changeWorkspace('guest');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '退出失败，请重试');
    } finally {
      setLeaving(false);
    }
  }

  function startLogin() {
    close(true);
    if (browserRuntime) {
      onNotice('当前站点未连接账号服务');
      return;
    }
    setAuth('login');
  }

  const avatar = assets + 'local-avatar.png';
  return <div className="workbench-account-area" ref={group} onBlur={event=>{
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    <button ref={trigger} type="button" className="workbench-tool workbench-avatar-trigger"
      aria-label="账户" title="账户" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={()=>setOpen(value=>!value)}>
      <img src={avatar} alt="" className="workbench-avatar"/>
    </button>
    {open && <div className="account-menu" id={id} role="dialog" aria-label="账户菜单">
      <div className="account-menu-identity">
        <img src={avatar} width={40} height={40} alt=""/>
        <div className="account-menu-name">
          <strong title={accountName(currentAccount)}>{accountName(currentAccount) || 'Prism 账号'}</strong>
          <small>{currentAccount ? '已登录' : loading ? '正在读取…' : workspace==='lan' ? '局域网接力' : '未登录'}</small>
        </div>
        {currentAccount&&<button className="account-menu-small account-menu-library" type="button" onClick={()=>{close(true);setAuth('settings');}}>
          账号设置{icon('account-chevron')}
        </button>}
      </div>
      <div className="account-menu-credits">
        <div><span>积分余额</span><strong aria-label="余额暂不可用">{icon('points')}—</strong></div>
        <button className="account-menu-small account-menu-credit-link" type="button"
          onClick={()=>{ close(true); requireAccount(()=>onNotice('积分明细正在开发')); }}>积分明细{icon('account-chevron')}</button>
      </div>
      <div className="account-menu-pages">
        <a className="account-menu-row" href="#/assets" onClick={()=>close()}><AccountRow name="assets">我的资产</AccountRow></a>
        <button className="account-menu-row" type="button" disabled={!archiveAvailable} onClick={()=>{close(true);onArchive();}}>
          <AccountRow name="archive">{archived?'退出归档':'已归档项目'}</AccountRow>
        </button>
        <button className="account-menu-row" type="button" onClick={()=>{close(true);onNotice('主题切换正在开发');}}>
          <AccountRow name="appearance" value="深色">外观</AccountRow>
        </button>
        <button className="account-menu-row" type="button" onClick={()=>{close(true);onNotice('语言切换正在开发');}}>
          <AccountRow name="language" value="简体中文">界面语言</AccountRow>
        </button>
        <a className="account-menu-row" href={help} target="_blank" rel="noreferrer" onClick={()=>close(true)}>
          <AccountRow name="guide">产品更新与教程</AccountRow>
        </a>
      </div>
      <div className="account-menu-session">
        <button type="button" className="account-menu-row" disabled={leaving||loading}
          onClick={()=>currentAccount ? void leaveAccount() : startLogin()}>
          <AccountRow name="logout">{leaving ? '正在退出…' : currentAccount ? '退出登录' : '登录'}</AccountRow>
        </button>
      </div>
    </div>}
    {auth && <AccountForm initial={auth} account={currentAccount} onDone={user=>{setAuth(undefined);setAccount(user);changeWorkspace(user.id);}}
      onClose={()=>{setAuth(undefined);trigger.current?.focus({preventScroll:true});}}/>}
  </div>;
}
