/**
 * Deal board: one pipeline's deals grouped into stage columns.
 *
 * Movement goes through the existing `POST /deals/:id/stage`, which applies
 * won/lost server-side -- the board never computes status itself. Two move
 * paths because pointer dragging is not universal: HTML5 drag-and-drop for
 * the mouse, and a per-card stage menu for keyboard, touch and screen
 * readers. Viewers get a read-only board; the server enforces `deals.advance`
 * regardless of what the UI offers.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  groupDealsByStage,
  listPipelineDeals,
  listPipelines,
  listStages,
  moveDeal,
} from '../lib/kanban';
import type { BoardColumn, Pipeline, Stage } from '../lib/kanban';
import { EmptyState, Skeleton } from '../components/ui';

export function DealBoard(): JSX.Element {
  const { actor } = useAuth();
  const canMove = actor?.role !== 'viewer';

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [stages, setStages] = useState<Stage[]>([]);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pipes = await listPipelines();
        if (cancelled) return;
        setPipelines(pipes);
        if (pipes.length > 0 && pipes[0]) setPipelineId((prev) => prev || pipes[0]!.id);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load pipelines.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!pipelineId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const [fetchedStages, deals] = await Promise.all([
        listStages(pipelineId),
        listPipelineDeals(pipelineId),
      ]);
      setStages(fetchedStages);
      setColumns(groupDealsByStage(deals, fetchedStages));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the board.');
    } finally {
      setIsLoading(false);
    }
  }, [pipelineId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(dealId: string, stageId: string | null): Promise<void> {
    if (!stageId || movingId) return;
    setMovingId(dealId);
    setError(null);
    try {
      await moveDeal(dealId, stageId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move the project.');
    } finally {
      setMovingId(null);
      setDropStage(null);
    }
  }

  return (
    <div className="enter">
    <p>
    <Link to="/deals">&larr; Back to projects</Link>
    </p>
    <h1>Project board</h1>

    {error && (
    <p className="alert alert-error" role="alert">
    {error}
    </p>
    )}

    <div className="toolbar">
    <label>
    Pipeline:{' '}
    <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} aria-label="Pipeline">
    {pipelines.map((p) => (
    <option key={p.id} value={p.id}>
    {p.name}
    </option>
    ))}
    </select>
    </label>
    </div>

    {isLoading ? (
    <div className="grid stagger">
    <div className="card section enter-fast">
    <Skeleton variant="title" />
    <Skeleton variant="line" />
    <Skeleton variant="line" />
    <Skeleton variant="line" />
    </div>
    </div>
    ) : pipelines.length === 0 ? (
    <EmptyState message="No pipelines yet." />
    ) : columns.length === 0 ? (
    <EmptyState message="This pipeline has no stages yet." />
    ) : (
    <div className="board" role="list" aria-label="Deal stages">
    {columns.map((column) => (
    <section
    key={column.stageId ?? 'other'}
    role="listitem"
    aria-label={column.title}
    className={`board-column${dropStage === column.stageId ? ' board-drop' : ''}`}
    onDragOver={canMove && column.stageId ? (e) => { e.preventDefault(); setDropStage(column.stageId); } : undefined}
    onDragLeave={() => setDropStage(null)}
    onDrop={
    canMove && column.stageId
    ? (e) => {
    e.preventDefault();
    const dealId = e.dataTransfer.getData('text/plain');
    if (dealId) void move(dealId, column.stageId);
    }
    : undefined
    }
    >
    <h2>
    {column.title} <span className="muted">({column.deals.length})</span>
    </h2>
    {column.deals.length === 0 ? (
    <p className="muted">No projects.</p>
    ) : (
    <ol className="board-cards">
    {column.deals.map((deal) => (
    <li
    key={deal.id}
    className="card board-card"
    draggable={canMove && movingId !== deal.id}
    onDragStart={(e) => e.dataTransfer.setData('text/plain', deal.id)}
    >
    <Link to={`/deals/${deal.id}`}>{deal.name}</Link>
    <p className="stat-value">{deal.value}</p>
    <p className="muted">{deal.status}</p>
    {canMove && column.stageId && (
    <label className="board-move">
    <span className="muted">Move to</span>{' '}
    <select
    value={column.stageId}
    disabled={movingId !== null}
    onChange={(e) => { void move(deal.id, e.target.value || null); }}
    aria-label={`Move ${deal.name} to another stage`}
    >
    {stages.map((s) => (
    <option key={s.id} value={s.id}>
    {s.name}
    </option>
    ))}
    {column.stageId === null && <option value="">Other stage</option>}
    </select>
    </label>
    )}
    </li>
    ))}
    </ol>
    )}
    </section>
    ))}
    </div>
    )}
    </div>
    );
}

export default DealBoard;
