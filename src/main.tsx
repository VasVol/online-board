import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
  '/excalidraw-assets/';
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="startup">
        <h1>Не удалось отобразить доску</h1>
        <p>Локальные изменения остаются в браузере. Обновите страницу.</p>
        <button onClick={() => location.reload()}>Обновить</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
