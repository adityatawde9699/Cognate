export function calcPriority(imp: number, eff: number, dl: string): Promise<'low' | 'medium' | 'high'>;
export function initDb(): Promise<void>;
export function createTask(payload: any): Promise<any>;
export function updateTask(id: string, payload: any): Promise<any>;
export function toggleTask(id: string): Promise<any>;
export function deleteTask(id: string): Promise<void>;
export function softDeleteTask(id: string, when?: string): Promise<void>;
export function restoreTask(id: string): Promise<void>;
export function getTrash(): Promise<any[]>;
export function emptyTrash(): Promise<number>;
export function updateSortOrders(orderedIds: string[]): Promise<void>;
export function addPomodoro(id: string): Promise<any>;
export function getSetting(key: string, defaultVal: string): Promise<string>;
export function setSetting(key: string, val: string): Promise<void>;
export function getStats(): Promise<{ done: number; streak: number; focusHrs: number; urgent: number }>;
export function getAllTasks(filter: string): Promise<any[]>;
export function checkpoint(): Promise<void>;
export function integrityCheck(): Promise<string>;

export function setSchedule(id: string, start: string | null, end: string | null): Promise<void>;
export function clearDaySchedules(date: string): Promise<void>;
export function updateScheduling(id: string, fields: { duration_min?: number; energy?: 'hi' | 'med' | 'lo'; pinned?: boolean }): Promise<void>;

export interface CalendarEvent { id: string; title: string; start: string; end: string; source: string; created_at: string; }
export function getCalendarEvents(): Promise<CalendarEvent[]>;
export function createCalendarEvent(ev: { title?: string; start: string; end: string; source?: string }): Promise<CalendarEvent>;
export function deleteCalendarEvent(id: string): Promise<void>;
export function clearCalendarSource(source: string): Promise<void>;
export function getLocalDateString(date?: Date): string;
export const IS_TAURI: boolean;

import type { Op } from './services/oplog';
export function loadOps(): Promise<Op[]>;
export function appendOps(ops: Op[]): Promise<void>;
export function upsertTaskRaw(task: any): Promise<void>;
export function planDedupe(tasks: any[]): Set<string>;
export function dedupeTasks(): Promise<number>;

export interface Project { id: string; name: string; color: string; created_at: string; sort_order: number; }
export function getProjects(): Promise<Project[]>;
export function createProject(name: string, color?: string): Promise<Project>;
export function updateProject(id: string, data: { name: string; color?: string }): Promise<void>;
export function upsertProjectRaw(p: { id: string; name?: string; color?: string }): Promise<void>;
export function setPinned(id: string, pinned: boolean): Promise<void>;
export function deleteProject(id: string): Promise<void>;

export interface Milestone { id: string; project_id: string | null; name: string; due: string; created_at: string; sort_order: number; }
export function getMilestones(): Promise<Milestone[]>;
export function createMilestone(name: string, projectId?: string | null, due?: string): Promise<Milestone>;
export function updateMilestone(id: string, data: { name: string; due?: string; project_id?: string | null }): Promise<void>;
export function deleteMilestone(id: string): Promise<void>;

export interface Template { id: string; name: string; data: any; created_at: string; }
export function getTemplates(): Promise<Template[]>;
export function createTemplate(name: string, data: any): Promise<Template>;
export function deleteTemplate(id: string): Promise<void>;
