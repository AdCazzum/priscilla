import React, { useState } from 'react';
import { Routes, Route, BrowserRouter } from 'react-router-dom';
import { CalimeroProvider, AppMode } from '@calimero-network/calimero-client';
import { ToastProvider } from '@calimero-network/mero-ui';

import HomePage from './pages/home';
import Authenticate from './pages/login/Authenticate';

const APPLICATION_ID = 'Aj8HuHA1g3Z5G5N67zehxBG3Swqiojmeicy2FqDrFzKs';

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
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </CalimeroProvider>
  );
}
