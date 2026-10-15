/**
 * Kanban board data: pipelines, their ordered stages, and deals grouped into
 * columns. No server changes were needed — pipelines, stages and filtered
 * deal lists already exist as endpoints; this module is the board's read
 * model plus the one pure function (column grouping) worth unit-testing.
 */
import { api } from './api';
import { advanceDealStage, listRecords, money } from './records';

export interface Pipeline {
  id: string;
  name: string;
}

export interface Stage {
  id: string;
  name: string;
  position: number;
  probability: number;
  is_won: boolean;
  is_lost: boolean;
}

export interface BoardDeal {
  id: string;
  name: string;
  value: string;
  status: string;
  stageId: string;
}

export interface BoardColumn {
  stageId: string | null;
  title: string;
  deals: BoardDeal[];
  totalValue: string;
}

const BOARD_PAGE = 200;

export async function listPipelines(): Promise<Pipeline[]> {
  // The list envelope is `{ data, pageInfo }`; the default unwrap hands back
  // the array, and anything else degrades to no pipelines.
  const body = await api.get<unknown>('/pipelines?limit=100');
  const rows = Array.isArray(body) ? body : [];
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({ id: String(r['id'] ?? ''), name: String(r['name'] ?? '') }))
    .filter((p) => p.id !== '');
}

export async function listStages(pipelineId: string): Promise<Stage[]> {
  const body = await api.get<unknown>(`/pipelines/${encodeURIComponent(pipelineId)}/stages`);
  const rows = Array.isArray(body) ? body : [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r['id'] ?? ''),
    name: String(r['name'] ?? ''),
    position: Number(r['position'] ?? 0),
    probability: Number(r['probability'] ?? 0),
    is_won: r['is_won'] === true,
    is_lost: r['is_lost'] === true,
  })).filter((s) => s.id !== '');
}

export async function listPipelineDeals(pipelineId: string): Promise<BoardDeal[]> {
  const result = await listRecords<Record<string, unknown>>('deals', {
    limit: BOARD_PAGE,
    filters: { pipeline_id: pipelineId },
  });
  return result.data.map((d) => ({
    id: String(d['id'] ?? ''),
    name: String(d['name'] ?? 'Untitled deal'),
    value: money(d['value_c'], d['currency']),
    status: String(d['status'] ?? 'open'),
    stageId: String(d['stage_id'] ?? ''),
  })).filter((d) => d.id !== '');
}

export async function moveDeal(dealId: string, stageId: string): Promise<void> {
  await advanceDealStage(dealId, stageId);
}

/**
 * Groups deals into one column per stage, in stage order. Deals whose stage
 * is not among the columns (a stage deleted out from under them, or moved by
 * another pipeline's page) collect in a trailing "Other stage" bucket rather
 * than vanishing — a card the board cannot show is a deal the business
 * cannot see.
 */
export function groupDealsByStage(deals: BoardDeal[], stages: Stage[]): BoardColumn[] {
  const columns: BoardColumn[] = stages.map((s) => ({
    stageId: s.id,
    title: s.name,
    deals: [],
    totalValue: '',
  }));
  const byStage = new Map(stages.map((s) => [s.id, columns.find((c) => c.stageId === s.id)!]));
  const other: BoardDeal[] = [];
  for (const deal of deals) {
    const column = byStage.get(deal.stageId);
    if (column) column.deals.push(deal);
    else other.push(deal);
  }
  if (other.length > 0) {
    columns.push({ stageId: null, title: 'Other stage', deals: other, totalValue: '' });
  }
  return columns;
}
