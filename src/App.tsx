import { useState, useEffect } from 'react';
import { request, json } from './api';
import { Logo, message } from './components/ui';
import Home from './Home';
import Workspace from './Workspace';
export default function App() {
  const [ready, setReady] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    void request('/session', json('POST'))
      .then(() => setReady(true))
      .catch((e) => setError(message(e)));
  }, []);
  const id = location.pathname.match(/^\/b\/([\w-]+)/)?.[1];
  if (!ready)
    return (
      <div className="startup">
        <Logo />
        <p>{error || 'Открываем пространство…'}</p>
        {error && (
          <button className="button primary" onClick={() => location.reload()}>
            Повторить
          </button>
        )}
      </div>
    );
  return id ? <Workspace id={id} /> : <Home />;
}
