import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { About, CommandPalette, Wordmark } from './components';
import { useGameTheme } from './gameTheme';
import { useHotkeys } from './hotkeys';
import { Air } from './layout/Air';
import { Rail } from './layout/Rail';
import { StatusBar } from './layout/StatusBar';
import { currentPack, useStore } from './store';
import { Show } from './views/Show';
import { Match } from './views/Match';
import { Graphics } from './views/Graphics';
import { Data } from './views/Data';
import { Rundown } from './views/Rundown';
import { Preflight } from './views/Preflight';
import { Setup } from './views/Setup';
import { isSampleState } from './types';

const SAMPLE_DISMISS_KEY = 'cta.sampleBannerDismissed';

/** The factory sample event (COMMUNITY CUP, invented teams, a prize) is on the
 *  desk. Preflight blocks CLEAR TO AIR on it too; this says so where the
 *  operator is looking. Dismissible for the session. */
function SampleBanner() {
  const state = useStore((s) => s.state);
  const setTab = useStore((s) => s.setTab);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(SAMPLE_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || !isSampleState(state)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(SAMPLE_DISMISS_KEY, '1');
    } catch {
      /* private mode: dismiss for this render only */
    }
  };
  return (
    <div role="status" className="sample-banner mb-4 flex items-center gap-3 rounded-[10px] px-4 py-3">
      <span className="w-2 h-2 rounded-full flex-none" style={{ background: 'var(--warn)' }} />
      <div className="flex-1 min-w-0 text-[13px] text-ink">
        <b className="font-semibold">Sample data is loaded.</b>{' '}
        <span className="text-ink-2">The event, teams, prize and talent are the built-in demo. Set your event and teams in Setup, or hold New event there.</span>
      </div>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setTab('setup')}>
        Open Setup
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={dismiss} aria-label="Dismiss the sample data notice">
        Dismiss
      </button>
    </div>
  );
}

function Workspace() {
  const tab = useStore((s) => s.tab);
  const state = useStore((s) => s.state);
  const connected = useStore((s) => s.connected);

  if (!state) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
        <Wordmark state="unknown" height={34} className="text-ink splash-wordmark" />
        <div className="display text-[22px] text-ink mt-3">{connected ? 'Waiting for state' : 'Connecting to the agent'}</div>
        <div className="text-[13px] text-ink-3 max-w-[44ch]">
          {connected
            ? 'The agent is up but has not sent a state yet. It should arrive in a moment.'
            : 'Start the agent with Clear to Air.cmd, or run npm start in the project folder. This page reconnects by itself.'}
        </div>
      </div>
    );
  }

  switch (tab) {
    case 'show':
      return <Show />;
    case 'match':
      return <Match />;
    case 'graphics':
      return <Graphics />;
    case 'data':
      return <Data />;
    case 'rundown':
      return <Rundown />;
    case 'preflight':
      return <Preflight />;
    case 'setup':
      return <Setup />;
    default:
      return null;
  }
}

export default function App() {
  const boot = useStore((s) => s.boot);
  const tab = useStore((s) => s.tab);
  const packs = useStore((s) => s.packs);
  const state = useStore((s) => s.state);
  useEffect(() => boot(), [boot]);
  useHotkeys();
  // Re-skins the chrome whenever the show changes title.
  useGameTheme(currentPack(packs, state));

  return (
    <div className="app">
      <Rail />
      <main className="work">
        <div key={tab} className="fade-in p-4 min-h-full">
          <SampleBanner />
          <Workspace />
        </div>
      </main>
      <Air />
      <StatusBar />
      <CommandPalette />
      <About />
      <Toaster position="bottom-right" duration={2000} gap={8} offset={40} visibleToasts={4} />
    </div>
  );
}
