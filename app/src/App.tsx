import React, { useState } from 'react';
import { Routes, Route, BrowserRouter } from 'react-router-dom';
import { CalimeroProvider, AppMode } from '@calimero-network/calimero-client';
import { ToastProvider } from '@calimero-network/mero-ui';

import HomePage from './pages/home';
import Authenticate from './pages/login/Authenticate';
import AdminPage from './pages/admin';
import PlayerOnePage from './pages/player-one';
import PlayerTwoPage from './pages/player-two';

const APPLICATION_ID = '76cT78ndWahL6yRf2hHk3CYNZsWV8LoEbJ2bmgY6Qgqq';

export default function App() {
  const [clientAppId] = useState<string>(APPLICATION_ID);

  return (
    <CalimeroProvider
      clientApplicationId={clientAppId}
      applicationPath={window.location.pathname || '/'}
      mode={AppMode.MultiContext}
    >
      <ToastProvider>
        <BrowserRouter basename="/">
          <Routes>
            <Route path="/" element={<Authenticate />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/p-admin" element={<AdminPage />} />
            <Route path="/player-one" element={<PlayerOnePage />} />
            <Route path="/player-two" element={<PlayerTwoPage />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </CalimeroProvider>
  );
}
