import { describe, it, expect } from 'vitest';

export function calcPriority(importance, effort, deadline) {
    const imp = (importance / 5) * 4;
    let deadl = 0;
    if (deadline) {
        const daysLeft = Math.round(
            (new Date(deadline + 'T00:00:00') - new Date(new Date().toDateString())) / 86_400_000
        );
        deadl = daysLeft <= 0 ? 4 : daysLeft <= 14 ? 4 * (1 - daysLeft / 14) : 0;
    }
    const eff = ((6 - effort) / 5) * 2;
    const total = imp + deadl + eff;
    return total >= 6.5 ? 'high' : total >= 3.5 ? 'medium' : 'low';
}

describe('calcPriority (JS Fallback logic)', () => {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const past = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    it('returns high for high importance, low effort, past deadline', () => {
        expect(calcPriority(5, 1, past)).toBe('high');
    });

    it('returns medium for average params', () => {
        expect(calcPriority(3, 3, null)).toBe('medium');
    });

    it('returns low for low importance, high effort, no deadline', () => {
        expect(calcPriority(1, 5, null)).toBe('low');
    });

    it('bumps priority if deadline is today', () => {
        // Normally (1, 5, null) is low. With today deadline it gets +4 points.
        expect(calcPriority(1, 5, today)).toBe('medium');
    });
});
