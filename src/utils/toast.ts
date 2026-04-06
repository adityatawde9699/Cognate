/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/utils/toast.ts — Toast notifications
   React-managed: calls into the Toast component
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { _getToastPush } from '../components/Toast';

export function toast(msg: string): void {
  const push = _getToastPush();
  if (push) {
    push(msg);
  } else {
    // Fallback if Toast component hasn't mounted yet
    console.warn('[toast]', msg);
  }
}
