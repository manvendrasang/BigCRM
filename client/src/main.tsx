import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import './styles/tokens.css';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Root container #root is missing from index.html');

// StrictMode double-invokes effects in development, which is deliberate: it
// surfaces missing cleanup in the session bootstrap and unmounted updates.
createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);