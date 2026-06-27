/* Templates — snapshot a set of tasks and re-create them later.
   Deadlines are stored as day-offsets from the save date so applying a
   template produces fresh, forward-dated deadlines. */
import { Task } from '../store';
import { getTemplates as dbGetTemplates, createTemplate as dbCreateTemplate, deleteTemplate as dbDeleteTemplate, getLocalDateString } from '../db';
import { addTask } from './taskService';

const DAY = 86400000;

export interface TemplateTaskDraft {
  title: string;
  description: string;
  tags: string[];
  importance: number;
  effort: number;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  offset: number | null; // days from apply-date, or null for no deadline
}
export interface TemplateData { tasks: TemplateTaskDraft[] }
export interface Template { id: string; name: string; data: TemplateData; created_at: string }

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function getTemplates(): Promise<Template[]> {
  return (await dbGetTemplates()) as any;
}

/** Save the given tasks as a reusable template. */
export async function saveTemplate(name: string, tasks: Task[]): Promise<void> {
  const today = startOfToday();
  const data: TemplateData = {
    tasks: tasks.map((t) => ({
      title: t.title,
      description: t.description,
      tags: t.tags,
      importance: t.importance,
      effort: t.effort,
      recurrence: t.recurrence,
      offset: t.deadline ? Math.round((new Date(t.deadline + 'T00:00:00').getTime() - today) / DAY) : null,
    })),
  };
  await dbCreateTemplate(name, data);
}

/** Apply a template, creating its tasks (optionally into a project). */
export async function applyTemplate(tpl: Template, projectId: string | null = null): Promise<number> {
  const today = startOfToday();
  const drafts = tpl.data?.tasks || [];
  for (const d of drafts) {
    const deadline = d.offset != null ? getLocalDateString(new Date(today + d.offset * DAY)) : '';
    await addTask({
      title: d.title,
      description: d.description,
      deadline,
      tags: d.tags || [],
      importance: d.importance,
      effort: d.effort,
      recurrence: d.recurrence || 'none',
      project_id: projectId,
    });
  }
  return drafts.length;
}

export async function removeTemplate(id: string): Promise<void> {
  await dbDeleteTemplate(id);
}
