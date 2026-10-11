import { useRef, useSyncExternalStore } from 'react';
import { approveAiRequest, cancelAiRequest, getAiRequest, subscribeAiRequest } from '../services/aiRequests';
import { useFocusTrap } from '../hooks/useFocusTrap';

export function AiRequestReview() {
  const request = useSyncExternalStore(subscribeAiRequest, getAiRequest);
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, !!request);
  if (!request) return null;
  return <div className="ai-review-overlay" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancelAiRequest(); } }}>
    <div ref={panel} className="ai-review-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-review-title">
      <h2 id="ai-review-title">{request.status === 'review' ? 'Review AI request' : 'AI request in progress'}</h2>
      <p>{request.local ? 'This request goes to a loopback server on this device.' : 'The text below will be sent to a remote provider. Review it before sending.'}</p>
      <p><strong>{request.provider} · {request.model || 'Provider default'}</strong><br />{request.endpoint}</p>
      <label htmlFor="ai-request-payload">Data sent</label>
      <textarea id="ai-request-payload" readOnly value={`Instructions:\n${request.system}\n\nRequest:\n${request.prompt}`} />
      <p className="form-hint">Cancelling stops waiting for advice. Data already sent cannot be recalled. Auto-plan continues to work offline.</p>
      <div className="ai-review-actions">
        <button className="btn-ghost" onClick={cancelAiRequest}>Cancel AI request</button>
        {request.status === 'review' && <button className="btn-primary" onClick={approveAiRequest}>Send to provider</button>}
      </div>
    </div>
  </div>;
}
