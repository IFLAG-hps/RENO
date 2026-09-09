import { useEffect } from 'react';
import MainPage from './migrated/main.jsx';
import AgentPage from './migrated/agent.jsx';
import RevenuePage from './migrated/revenue.jsx';
import MockupPage from './migrated/mockup.jsx';
import DesktopQrDock from './DesktopQrDock.jsx';
import './migrated/main.css';

const pages = {
  '/pages/agent.html': AgentPage,
  '/pages/agent': AgentPage,
  '/pages/revenue.html': RevenuePage,
  '/pages/revenue': RevenuePage,
  '/pages/mockup.html': MockupPage,
  '/pages/mockup': MockupPage,
};

export default function App() {
  const Page = pages[window.location.pathname] ?? MainPage;

  useEffect(() => {
    if (Page === AgentPage) import('./migrated/agent.css');
    if (Page === RevenuePage) import('./migrated/revenue.css');
    if (Page === MockupPage) import('./migrated/mockup.css');

    if (Page === MainPage) {
      import('./migrated/main-runtime.js').then(() => {
        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
        window.dispatchEvent(new Event('load'));
      });
    }
  }, [Page]);

  return <>
    <Page />
    {Page === MainPage && <DesktopQrDock />}
  </>;
}
