import {it,expect} from 'vitest';
import {availabilityStatus,validAvailability} from './teamAvailability';
const a={version:1,date:'2026-10-09',published_at:'2026-10-09T09:00:00Z',work_start_min:540,work_end_min:1020,busy:[{start_min:600,end_min:660}]};
it('bounds and dates availability and expires it instead of assuming free time',()=>{
 expect(validAvailability(a)).toBe(true);
 expect(availabilityStatus(a,a.date,Date.parse('2026-10-09T09:10:00Z'))).toBe('known');
 expect(availabilityStatus(a,a.date,Date.parse('2026-10-09T09:16:00Z'))).toBe('stale');
 expect(availabilityStatus(a,'2026-10-10',Date.parse(a.published_at))).toBe('unknown');
 for(const bad of [{...a,date:'2026-99-99'},{...a,busy:[{start_min:60,end_min:30}]},{...a,busy:new Array(501).fill(a.busy[0])},{...a,work_end_min:1500}]) expect(validAvailability(bad)).toBe(false);
});
