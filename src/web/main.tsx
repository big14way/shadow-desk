import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router';
import { api } from './api';
import { ConfigContext, Logo, type DeskConfig } from './components/ui';
import { Admin } from './pages/Admin';
import { Guide } from './pages/Guide';
import { Maker } from './pages/Maker';
import { NewOffer } from './pages/NewOffer';
import { Offers } from './pages/Offers';
import { Tape } from './pages/Tape';
import { Trade } from './pages/Trade';
import './styles.css';

function Layout({ children, config }: { children: ReactNode; config: DeskConfig | null }) {
  return (
    <>
      {config?.dryRun && <div className="dryrun">DRY RUN: no real funds or signatures</div>}
      <header className="top">
        <div className="wrap">
          <Link to="/" className="brand">
            <Logo /> Shadow Desk
          </Link>
          <nav className="main">
            <NavLink to="/" end>Offers</NavLink>
            <NavLink to="/sell">Sell ZEC</NavLink>
            <NavLink to="/tape">Tape</NavLink>
            <NavLink to="/guide">How it works</NavLink>
          </nav>
          <span className="tagline">The price is public. The participants are not.</span>
        </div>
      </header>
      <main>
        <div className="wrap">{children}</div>
      </main>
      <footer className="bottom">
        <div className="wrap">
          <span>
            Use <strong>Tor Browser</strong> for the best privacy. No accounts, no cookies, no third-party scripts, no IP logs.
          </span>
          <span>
            {config ? (config.dryRun ? 'Dry run' : config.network === 'main' ? 'Zcash Mainnet' : 'Zcash Testnet') : ''} · Hackathon prototype, trades capped at 0.01 ZEC
          </span>
        </div>
      </footer>
    </>
  );
}

function App() {
  const [config, setConfig] = useState<DeskConfig | null>(null);
  useEffect(() => {
    api<DeskConfig>('/config').then(setConfig, () => setConfig(null));
  }, []);
  return (
    <ConfigContext.Provider value={config}>
      <BrowserRouter>
        <Layout config={config}>
          <Routes>
            <Route path="/" element={<Offers />} />
            <Route path="/sell" element={<NewOffer />} />
            <Route path="/o/:id" element={<Maker />} />
            <Route path="/t/:id" element={<Trade />} />
            <Route path="/tape" element={<Tape />} />
            <Route path="/guide" element={<Guide />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<div className="empty">Nothing here.</div>} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </ConfigContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
