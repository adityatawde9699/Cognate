/** Opt-in, title-free busy times signed as a member's self-declared availability. */
export interface TeamAvailability {version:1;date:string;published_at:string;work_start_min:number;work_end_min:number;busy:Array<{start_min:number;end_min:number}>}
export function validAvailability(value:unknown): value is TeamAvailability {
 if(!value || typeof value!=='object') return false;
 const v=value as TeamAvailability;
 return v.version===1 && typeof v.date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date) && Number.isFinite(Date.parse(v.date+'T00:00:00Z')) && new Date(v.date+'T00:00:00Z').toISOString().slice(0,10)===v.date && typeof v.published_at==='string' && Number.isFinite(Date.parse(v.published_at)) && Number.isInteger(v.work_start_min) && Number.isInteger(v.work_end_min) && v.work_start_min>=0 && v.work_end_min<=1440 && v.work_end_min>v.work_start_min && Array.isArray(v.busy) && v.busy.length<=500 && v.busy.every(b=>b && Number.isInteger(b.start_min) && Number.isInteger(b.end_min) && b.start_min>=0 && b.end_min<=1440 && b.end_min>b.start_min);
}
export function availabilityStatus(value:unknown,date:string,now=Date.now()):'known'|'unknown'|'stale' {
 if(!validAvailability(value) || value.date!==date) return 'unknown';
 const age=now-Date.parse(value.published_at);
 return age< -5*60_000 || age>15*60_000 ? 'stale':'known';
}
