/* Custom field definitions — stored as a JSON setting, applied per-task
   via the task.custom_fields map. */
import { getSetting, setSetting } from '../db';
import { useStore, CustomFieldDef } from '../store';

export async function loadCustomFieldDefs(): Promise<void> {
  try {
    const raw = await getSetting('custom_field_defs', '[]');
    let defs;
    try {
      defs = JSON.parse(raw || '[]');
    } catch (e) {
      console.warn('[customFields.ts] JSON parse error:', e, 'Raw:', raw);
      defs = [];
    }
    useStore.getState().setCustomFieldDefs(Array.isArray(defs) ? defs : []);
  } catch {
    useStore.getState().setCustomFieldDefs([]);
  }
}

export async function saveCustomFieldDefs(defs: CustomFieldDef[]): Promise<void> {
  await setSetting('custom_field_defs', JSON.stringify(defs));
  useStore.getState().setCustomFieldDefs(defs);
}
