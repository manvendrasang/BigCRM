/**
 * Reports (item 7).
 *
 * Aggregations over tenant-scoped records: pipeline value by stage, lead
 * funnel by status, task load by status. Every query carries
 * `organization_id = $1` through `TenantScope`, so a report can never include
 * another tenant's rows -- the same guarantee as the list endpoints, applied to
 * `GROUP BY` rather than `SELECT ... LIMIT`.
 *
 *  Why a dedicated endpoint rather than client-side aggregation 
 *
 * The list endpoints paginate (max 200 rows). A pipeline report computed from
 * the first page would silently omit every deal past it, and fetching all
 * pages to aggregate in the browser is N requests for one number. Aggregation
 * in SQL is one indexed query per report. The client renders; it does not
 * count.
 *
 *  Centralised metric definitions (RULE 152) 
 *
 * Each report names exactly what it counts, so two consumers cannot disagree:
 * "open deal value" means `status NOT IN ('won','lost')` summed in cents,
 * "lead funnel" counts by `status`, "task load" counts non-deleted tasks by
 * `status` and `priority`. If the definition changes, it changes here once.
 */
import { TenantScope } from '../repositories/base.ts';
import type { ActorRef } from './records.ts';

export type ReportName = 'pipeline' | 'lead-funnel' | 'task-load' | 'overview';

export type PipelineRow = {
 pipelineId: string;
 pipelineName: string;
 stageId: string;
 stageName: string;
 position: number;
 dealCount: number;
 totalValueC: number;
 isWon: boolean;
 isLost: boolean;
};

export type FunnelRow = {
 status: string;
 count: number;
};

export type TaskLoadRow = {
 status: string;
 priority: string;
 count: number;
};

export type Overview = {
 contacts: number;
 companies: number;
 leads: number;
 openDeals: number;
 openDealValueC: number;
 openTasks: number;
};

/** Pipeline value by stage: the report a sales standup actually reads. */
export async function pipelineReport(actor: ActorRef): Promise<PipelineRow[]> {
 const scope = new TenantScope(actor.organizationId);
 return scope.query<PipelineRow>(
 `SELECT p.id AS "pipelineId", p.name AS "pipelineName",
 s.id AS "stageId", s.name AS "stageName", s.position,
 s.is_won AS "isWon", s.is_lost AS "isLost",
 COUNT(d.id)::int AS "dealCount",
 COALESCE(SUM(d.value_c), 0)::bigint AS "totalValueC"
 FROM pipelines p
 JOIN pipeline_stages s ON s.pipeline_id = p.id AND s.deleted_at IS NULL
 LEFT JOIN deals d ON d.stage_id = s.id
 AND d.organization_id = p.organization_id
 AND d.deleted_at IS NULL
 WHERE p.organization_id = $1 AND p.deleted_at IS NULL
 GROUP BY p.id, p.name, s.id, s.name, s.position, s.is_won, s.is_lost
 ORDER BY p.name, s.position`,
 [actor.organizationId],
 );
};

/** Lead funnel: count by status. */
export async function leadFunnelReport(actor: ActorRef): Promise<FunnelRow[]> {
 const scope = new TenantScope(actor.organizationId);
 return scope.query<FunnelRow>(
 `SELECT status, COUNT(*)::int AS count
 FROM leads WHERE organization_id = $1 AND deleted_at IS NULL
 GROUP BY status ORDER BY count DESC`,
 [actor.organizationId],
 );
};

/** Task load: count by status and priority. */
export async function taskLoadReport(actor: ActorRef): Promise<TaskLoadRow[]> {
 const scope = new TenantScope(actor.organizationId);
 return scope.query<TaskLoadRow>(
 `SELECT status, priority, COUNT(*)::int AS count
 FROM tasks WHERE organization_id = $1 AND deleted_at IS NULL
 GROUP BY status, priority ORDER BY status, priority`,
 [actor.organizationId],
 );
};

/**
 * Overview: the six numbers the dashboard renders.
 *
 * Six `COUNT(*)` queries rather than one clever query: each hits a different
 * table with a different predicate, and six indexed counts are cheaper than
 * any join that produces them together. "Open deal value" is the one
 * definition that matters here -- see the module doc.
 */
export async function overviewReport(actor: ActorRef): Promise<Overview> {
 const scope = new TenantScope(actor.organizationId);
 const one = async (sql: string): Promise<number> => {
 const rows = await scope.query<{ n: number }>(sql, [actor.organizationId]);
 return Number(rows[0]?.n ?? 0);
 };
 const [contacts, companies, leads, openDeals, openDealValueC, openTasks] = await Promise.all([
 one(`SELECT COUNT(*)::int AS n FROM contacts WHERE organization_id = $1 AND deleted_at IS NULL`),
 one(`SELECT COUNT(*)::int AS n FROM companies WHERE organization_id = $1 AND deleted_at IS NULL`),
 one(`SELECT COUNT(*)::int AS n FROM leads WHERE organization_id = $1 AND deleted_at IS NULL`),
 one(`SELECT COUNT(*)::int AS n FROM deals WHERE organization_id = $1 AND deleted_at IS NULL AND status NOT IN ('won','lost')`),
 one(`SELECT COALESCE(SUM(value_c),0)::bigint AS n FROM deals WHERE organization_id = $1 AND deleted_at IS NULL AND status NOT IN ('won','lost')`),
 one(`SELECT COUNT(*)::int AS n FROM tasks WHERE organization_id = $1 AND deleted_at IS NULL AND status NOT IN ('completed','cancelled')`),
 ]);
 return { contacts, companies, leads, openDeals, openDealValueC, openTasks };
}
