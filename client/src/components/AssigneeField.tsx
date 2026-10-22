/**
 * Task assignee picker.
 *
 * Rendered only for the roles that may assign (owner and manager). The options
 * come from `GET /tasks/assignees`, which applies the very rule the write path
 * enforces -- the owner may pick anybody, a manager everybody except the owner
 * -- so the picker cannot offer a target the save would refuse.
 *
 * The hook is separate from the control so a page can load the directory once
 * and render the select in both the create form and the inline edit form.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { listTaskAssignees } from '../lib/records';
import type { TaskAssignee } from '../lib/records';

export interface AssignableMembers {
  members: TaskAssignee[];
  error: string | null;
}

export function useAssignableMembers(enabled: boolean): AssignableMembers {
  const [members, setMembers] = useState<TaskAssignee[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setMembers([]);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await listTaskAssignees();
        if (!cancelled) setMembers(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load members.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { members, error };
}

/** Does this role hold assignment authority? Admins deliberately do not. */
export const canAssignTasks = (role: string | undefined): boolean =>
  role === 'owner' || role === 'manager';

export function AssigneeSelect({
  members,
  value,
  onChange,
  disabled = false,
}: {
  members: TaskAssignee[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">-- Unassigned --</option>
      {/* A task can outlive the assignee's membership. Keep the current value
          selectable so saving an unrelated edit cannot silently clear it. */}
      {value && !members.some((m) => m.id === value) && (
        <option value={value}>(former member)</option>
      )}
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name || m.email}
          {m.name ? ` (${m.email})` : ''}
        </option>
      ))}
    </select>
  );
}
