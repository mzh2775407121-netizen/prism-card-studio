import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { accountLink } from './communityClient';

const pageOrder = { home: 0, assets: 1, community: 2 };
type WorkbenchView = { route: string; archived: boolean };
type MotionDirection = 'up' | 'down' | 'left' | 'right';

function workbenchPage(hash: string) {
  if (/^#\/community\/library(?:\/|$)/.test(hash)) return 'assets';
  if (/^#\/community(?:\/|$)/.test(hash)) return 'community';
  return /^#\/assets(?:\?|$)/.test(hash) ? 'assets' : 'home';
}

function motionDirection(from: WorkbenchView, to: WorkbenchView): MotionDirection | null {
  const previous = workbenchPage(from.route);
  const next = workbenchPage(to.route);
  const wasArchive = previous === 'home' && from.archived;
  if (next === 'home') {
    if (to.archived && !wasArchive) return 'left';
    if (!to.archived && wasArchive) return 'right';
  }
  if (next === previous) return null;
  return pageOrder[next] > pageOrder[previous] ? 'up' : 'down';
}

function stop(animations: Animation[]) {
  animations.forEach(animation => animation.cancel());
}

function animateContent(region: HTMLElement, entering: boolean, direction: MotionDirection) {
  if (typeof region.animate !== 'function') return [];
  const groups = Array.from(region.querySelectorAll<HTMLElement>('[data-workbench-motion]')).filter(group => {
    const bounds = group.getBoundingClientRect();
    return bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
  });
  const reverse = direction === 'up' || direction === 'left';
  const horizontal = direction === 'left' || direction === 'right';
  if (reverse) groups.reverse();
  const offset = reverse ? -14 : 14;
  const translate = (distance: number) => horizontal ? `${distance}px 0` : `0 ${distance}px`;
  const frames = groups.map(group => {
    if (entering) return [{ opacity: 0, translate: translate(-offset) }, { opacity: 1, translate: 'none' }];
    const style = getComputedStyle(group);
    return [{ opacity: style.opacity, translate: style.translate }, { opacity: 0, translate: translate(offset) }];
  });
  return groups.map((group, i) => group.animate(frames[i], {
    duration: entering ? 300 : 130,
    delay: i * (entering ? 70 : Math.min(25, 40 / Math.max(1, groups.length - 1))),
    easing: entering ? 'cubic-bezier(.22, 1, .36, 1)' : 'cubic-bezier(.4, 0, 1, 1)',
    fill: entering ? 'backwards' : 'both',
  }));
}

export function useWorkbenchNavigation(archived: boolean, setArchived: (value: boolean) => void, onNavigate: () => void) {
  const [route, setRoute] = useState(() => accountLink()?'':location.hash);
  const [activePage, setActivePage] = useState(() => workbenchPage(route));
  const content = useRef<HTMLDivElement>(null);
  const rendered = useRef<WorkbenchView>({ route, archived });
  const requested = useRef(rendered.current);
  const navigate = useRef<(view: WorkbenchView) => void>(() => {});
  const arrivalDirection = useRef<MotionDirection | null>(null);
  const moveFocus = useRef(false);
  const departure = useRef<{ animations: Animation[]; direction: MotionDirection } | null>(null);
  const arrival = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const region = content.current;
    if (!region || (rendered.current.route === route && rendered.current.archived === archived)) return;
    rendered.current = { route, archived };
    stop(departure.current?.animations ?? []);
    departure.current = null;
    region.inert = false;
    window.scrollTo(0, 0);
    const direction = arrivalDirection.current;
    arrivalDirection.current = null;
    if (direction && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      arrival.current = animateContent(region, true, direction);
    }
    if (moveFocus.current) region.querySelector<HTMLElement>('[data-workbench-title]')?.focus({ preventScroll: true });
    moveFocus.current = false;
    return () => {
      stop(arrival.current);
      arrival.current = [];
    };
  }, [route, archived]);

  useEffect(() => {
    const region = content.current;
    if (!region) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const cancelDeparture = () => {
      stop(departure.current?.animations ?? []);
      departure.current = null;
      region.inert = false;
    };
    const commit = (direction: MotionDirection | null) => {
      arrivalDirection.current = direction;
      setRoute(requested.current.route);
      setArchived(requested.current.archived);
    };
    const changeView = (next: WorkbenchView) => {
      requested.current = next;
      const direction = motionDirection(rendered.current, next);
      onNavigate();
      setActivePage(workbenchPage(next.route));
      if (!departure.current) moveFocus.current = !!direction && region.contains(document.activeElement);
      if (!direction || reducedMotion.matches || region.querySelector('dialog[open]')) {
        cancelDeparture();
        commit(null);
        return;
      }
      if (departure.current?.direction === direction) return;

      const animations = animateContent(region, false, direction);
      cancelDeparture();
      stop(arrival.current);
      arrival.current = [];
      if (!animations.length) {
        commit(direction);
        return;
      }
      const leaving = { animations, direction };
      departure.current = leaving;
      region.inert = true;
      void Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (departure.current === leaving) commit(direction);
      }, () => {});
    };
    navigate.current = changeView;
    const changeRoute = () => {
      if (!accountLink() && location.hash !== requested.current.route) {
        changeView({ route: location.hash, archived: rendered.current.archived });
      }
    };
    const changePreference = () => {
      if (!reducedMotion.matches) return;
      stop(arrival.current);
      if (departure.current) {
        cancelDeparture();
        commit(null);
      }
    };
    window.addEventListener('hashchange', changeRoute);
    reducedMotion.addEventListener('change', changePreference);
    return () => {
      cancelDeparture();
      window.removeEventListener('hashchange', changeRoute);
      reducedMotion.removeEventListener('change', changePreference);
    };
  }, [onNavigate, setArchived]);

  const showHome = (archived: boolean) => {
    if (location.hash) location.hash = '';
    navigate.current({ route: location.hash, archived });
  };

  return { route, page: workbenchPage(route), activePage, content, showHome,
    toggleArchive: () => showHome(!requested.current.archived) };
}
