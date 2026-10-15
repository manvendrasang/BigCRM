/**
 * Per-type display configuration for the record screens.
 *
 * The server is the source of truth for which columns are writable, sortable
 * and searchable (`services/records.ts` SPECS). This file only decides how
 * those columns are *presented*: which appear in the list table, which appear
 * on the detail page, and which inputs the create/edit forms offer.
 *
 * Nothing here is a permission. Hiding a field from the form does not prevent
 * a caller from sending it — the server's writable/updatable allowlists do
 * that. This config is presentation, and must never be mistaken for enforcement.
 */
import type { RecordType } from '../lib/records';

export interface ColumnDef {
  key: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  input: 'text' | 'email' | 'tel' | 'url' | 'date' | 'number' | 'textarea' | 'select';
  options?: readonly string[];
  required?: boolean;
}

export interface RecordConfig {
  type: RecordType;
  plural: string;
  singular: string;
  /**
   * Server-side entity name (activities, task relations). Deliberately NOT
   * derived from the display labels: the UI calls deals "Projects" while the
   * API, the activity CHECK and `related_type` still say `deal`.
   */
  entity: string;
  /** Columns in the list table, in order. First column links to the detail. */
  columns: ColumnDef[];
  /** Fields shown on the detail page, in order. */
  detail: ColumnDef[];
  /** Inputs offered by the create form. */
  createFields: FieldDef[];
  /** Inputs offered by the edit form. Defaults to createFields when omitted. */
  editFields?: FieldDef[];
}

const CONTACT_COLUMNS: ColumnDef[] = [
  { key: 'last_name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'job_title', label: 'Title' },
  { key: 'status', label: 'Status' },
];

const CONTACT_DETAIL: ColumnDef[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'secondary_email', label: 'Secondary email' },
  { key: 'phone', label: 'Phone' },
  { key: 'mobile_phone', label: 'Mobile' },
  { key: 'job_title', label: 'Job title' },
  { key: 'department', label: 'Department' },
  { key: 'source', label: 'Source' },
  { key: 'status', label: 'Status' },
  { key: 'lifecycle_stage', label: 'Lifecycle stage' },
];

const CONTACT_FIELDS: FieldDef[] = [
  { key: 'first_name', label: 'First name', input: 'text', required: true },
  { key: 'last_name', label: 'Last name', input: 'text', required: true },
  { key: 'email', label: 'Email', input: 'email' },
  { key: 'phone', label: 'Phone', input: 'tel' },
  { key: 'job_title', label: 'Job title', input: 'text' },
  { key: 'source', label: 'Source', input: 'text' },
];

export const RECORD_CONFIGS: Record<RecordType, RecordConfig> = {
  contacts: {
    type: 'contacts',
    entity: 'contact',
    plural: 'Contacts',
    singular: 'Contact',
    columns: CONTACT_COLUMNS,
    detail: CONTACT_DETAIL,
    createFields: CONTACT_FIELDS,
  },
  companies: {
    type: 'companies',
    entity: 'company',
    plural: 'Companies',
    singular: 'Company',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'domain', label: 'Domain' },
      { key: 'industry', label: 'Industry' },
      { key: 'phone', label: 'Phone' },
      { key: 'status', label: 'Status' },
    ],
    detail: [
      { key: 'name', label: 'Name' },
      { key: 'domain', label: 'Domain' },
      { key: 'industry', label: 'Industry' },
      { key: 'website', label: 'Website' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'employee_count', label: 'Employees' },
      { key: 'status', label: 'Status' },
    ],
    createFields: [
      { key: 'name', label: 'Name', input: 'text', required: true },
      { key: 'domain', label: 'Domain', input: 'text' },
      { key: 'industry', label: 'Industry', input: 'text' },
      { key: 'website', label: 'Website', input: 'url' },
      { key: 'email', label: 'Email', input: 'email' },
      { key: 'phone', label: 'Phone', input: 'tel' },
    ],
  },
  leads: {
    type: 'leads',
    entity: 'lead',
    plural: 'Leads',
    singular: 'Lead',
    columns: [
      { key: 'last_name', label: 'Name' },
      { key: 'company_name', label: 'Company' },
      { key: 'email', label: 'Email' },
      { key: 'status', label: 'Status' },
      { key: 'rating', label: 'Rating' },
    ],
    detail: [
      { key: 'first_name', label: 'First name' },
      { key: 'last_name', label: 'Last name' },
      { key: 'company_name', label: 'Company' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'title', label: 'Title' },
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status' },
      { key: 'rating', label: 'Rating' },
      { key: 'score', label: 'Score' },
    ],
    createFields: [
      { key: 'first_name', label: 'First name', input: 'text' },
      { key: 'last_name', label: 'Last name', input: 'text', required: true },
      { key: 'company_name', label: 'Company', input: 'text' },
      { key: 'email', label: 'Email', input: 'email' },
      { key: 'phone', label: 'Phone', input: 'tel' },
      { key: 'source', label: 'Source', input: 'text' },
    ],
  },
  deals: {
    type: 'deals',
    entity: 'deal',
    plural: 'Projects',
    singular: 'Project',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'value_c', label: 'Value' },
      { key: 'status', label: 'Status' },
      { key: 'expected_close_date', label: 'Expected close' },
    ],
    detail: [
      { key: 'name', label: 'Name' },
      { key: 'value_c', label: 'Value (cents)' },
      { key: 'currency', label: 'Currency' },
      { key: 'probability', label: 'Probability %' },
      { key: 'expected_close_date', label: 'Expected close' },
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status' },
    ],
    createFields: [
      { key: 'name', label: 'Name', input: 'text', required: true },
      { key: 'value_c', label: 'Value (cents)', input: 'number' },
      { key: 'currency', label: 'Currency', input: 'text' },
      { key: 'expected_close_date', label: 'Expected close', input: 'date' },
    ],
  },
  tasks: {
    type: 'tasks',
    entity: 'task',
    plural: 'Tasks',
    singular: 'Task',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'due_date', label: 'Due' },
    ],
    detail: [
      { key: 'title', label: 'Title' },
      { key: 'description', label: 'Description' },
      { key: 'status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'due_date', label: 'Due date' },
    ],
    createFields: [
      { key: 'title', label: 'Title', input: 'text', required: true },
      { key: 'description', label: 'Description', input: 'textarea' },
      {
        key: 'status', label: 'Status', input: 'select',
        options: ['todo', 'in_progress', 'blocked', 'completed', 'cancelled'],
      },
      {
        key: 'priority', label: 'Priority', input: 'select',
        options: ['low', 'medium', 'high', 'urgent'],
      },
      { key: 'due_date', label: 'Due date', input: 'date' },
    ],
  },
};
