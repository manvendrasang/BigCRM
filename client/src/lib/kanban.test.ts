/**
 * Kanban grouping tests.
 *
 * Column assignment is the one piece of board logic that can silently lose
 * work: a deal whose stage is missing must land somewhere visible, column
 * order must follow stage position, and an empty board must still render its
 * columns.
 */
import { describe, expect, it } from 'vitest';
import { groupDealsByStage } from './kanban';
import type { BoardDeal, Stage } from './kanban';

const stages: Stage[] = [
 { id: 's1', name: 'New', position: 0, probability: 10, is_won: false, is_lost: false },
 { id: 's2', name: 'Won', position: 1, probability: 100, is_won: true, is_lost: false },
];

const deal = (id: string, stageId: string): BoardDeal => ({
 id, name: id, value: '$0', status: 'open', stageId,
});

describe('groupDealsByStage', () => {
 it('places deals in their stage columns in order', () => {
 const columns = groupDealsByStage([deal('d2', 's2'), deal('d1', 's1')], stages);

 expect(columns.map((c) => c.title)).toEqual(['New', 'Won']);
 expect(columns[0]!.deals.map((d) => d.id)).toEqual(['d1']);
 expect(columns[1]!.deals.map((d) => d.id)).toEqual(['d2']);
 });

 it('collects unknown stages in a trailing bucket instead of dropping them', () => {
 const columns = groupDealsByStage([deal('d1', 's9')], stages);

 expect(columns).toHaveLength(3);
 expect(columns[2]!.title).toBe('Other stage');
 expect(columns[2]!.deals.map((d) => d.id)).toEqual(['d1']);
 });

 it('omits the bucket when every deal has a column', () => {
 const columns = groupDealsByStage([deal('d1', 's1')], stages);

 expect(columns).toHaveLength(2);
 });

 it('renders empty columns for an empty pipeline', () => {
 const columns = groupDealsByStage([], stages);

 expect(columns).toHaveLength(2);
 expect(columns.every((c) => c.deals.length === 0)).toBe(true);
 });
});
