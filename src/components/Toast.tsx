import { useState, useEffect, useCallback } from 'react';

let _externalPush: ((msg: string) => void) | null = null;

/**
 * Register the toast push function from the component's closure.
 * Called by `toast()` in `utils/toast.ts`.
 */
export function _registerToastPush(fn: (msg: string) => void) {
  _externalPush = fn;
}

export function _getToastPush() {
  return _externalPush;
}

/**
 * React-managed Toast notification component.
 * Renders in the React tree — no imperative DOM manipulation.
 */
export function Toast() {
  const [message, setMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const push = useCallback((msg: string) => {
    setMessage(msg);
    setVisible(true);
  }, []);

  // Register the push function so the global `toast()` utility can call it
  useEffect(() => {
    _registerToastPush(push);
    return () => {
      _externalPush = null;
    };
  }, [push]);

  // Auto-dismiss after 2.8s
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 2800);
    return () => clearTimeout(timer);
  }, [visible, message]);

  return (
    <div
      className={`toast ${visible ? 'show' : ''}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
