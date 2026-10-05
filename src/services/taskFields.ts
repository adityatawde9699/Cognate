import type { Task } from '../store';
import type { Json } from './oplog';
export const TASK_FIELDS: (keyof Task)[] = [
  'title', 'description', 'deadline', 'tags', 'importance', 'effort', 'priority',
  'done', 'created_at', 'completed_at', 'pomodoros_spent', 'project_id', 'parent_id',
  'milestone_id', 'recurrence', 'sort_order', 'custom_fields', 'deleted_at',
  'duration_min', 'energy', 'pinned', 'scheduled_start', 'scheduled_end', 'min_block', 'max_block',
];
export function taskRecord(task: Task): Record<string, Json> {
  return Object.fromEntries(TASK_FIELDS.filter(key => task[key] !== undefined).map(key => [key, task[key]])) as Record<string, Json>;
}
