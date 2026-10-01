import { build } from 'esbuild';
import { writeFileSync } from 'fs';

const result = await build({
  entryPoints: ['/workspace/src/merge.ts'],
  bundle: true, format: 'esm', write: false, platform: 'node'
});
writeFileSync('/tmp/merge-bundle.mjs', result.outputFiles[0].text);
const { mergeWorkspace, hasPendingEdits } = await import('/tmp/merge-bundle.mjs');

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };

const item = (id, stageId, order, challenge, response, extra = {}) => ({
  id, stageId, order, challenge, response, critical: false, preconditionIds: [],
  abnormalProcedure: '', updatedAt: '2026-01-01T00:00:00Z', version: 1, ...extra
});
const stage = (id, order, name) => ({ id, name, order, description: '', version: 1 });

const makeProject = (items, overrides = {}) => ({
  id: 'p1', name: 'C172', aircraft: 'C172', revision: 3, status: 'draft',
  updatedAt: '2026-01-01T00:00:00Z', reviewNote: '',
  stages: [stage('s1', 0, '飞行前检查')],
  items, revisions: [], contentVersion: 1, orderCheckPending: false, conflicts: [],
  ...overrides
});
const workspace = (project) => ({ schemaVersion: 1, selectedProjectId: 'p1', projects: [project] });

// 场景1：甲拖动顺序，乙改 B 的前置条件（同项不同字段）-> 自动字段级合并，无冲突
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油', 'CHECKED'), item('C', 's1', 2, '襟翼', 'SET')]));
  const localP = makeProject([
    item('B', 's1', 0, '燃油', 'CHECKED', { version: 2 }),
    item('C', 's1', 1, '襟翼', 'SET', { version: 2 }),
    item('A', 's1', 2, '电瓶', 'ON', { version: 2 })
  ], { contentVersion: 2, orderCheckPending: true });
  const local = workspace(localP);
  const remoteP = makeProject([
    item('A', 's1', 0, '电瓶', 'ON'),
    item('B', 's1', 1, '燃油', 'CHECKED', { preconditionIds: ['A'], version: 2 }),
    item('C', 's1', 2, '襟翼', 'SET')
  ], { contentVersion: 3 });
  const remote = workspace(remoteP);
  const { state, merged, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  const p = state.projects[0];
  assert(merged === true, '场景1: 应发生自动合并');
  assert(hasConflicts === false, '场景1: 甲改顺序/乙改前置（不同字段）应自动合并不冲突');
  const A = p.items.find(i => i.id === 'A');
  const B = p.items.find(i => i.id === 'B');
  assert(A.order === 2, '场景1: 甲的顺序保留（A 在 order 2）');
  assert(JSON.stringify(B.preconditionIds) === JSON.stringify(['A']), '场景1: 乙的前置条件修改合入 B');
  assert(p.orderCheckPending === true, '场景1: 顺序变化标记重算可达性');
}

// 场景1b：甲乙都调整了 B 的顺序（同一字段）-> order 冲突
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油', 'CHECKED'), item('C', 's1', 2, '襟翼', 'SET')]));
  const local = workspace(makeProject([
    item('B', 's1', 0, '燃油', 'CHECKED', { version: 2 }),
    item('A', 's1', 1, '电瓶', 'ON', { version: 2 }),
    item('C', 's1', 2, '襟翼', 'SET')
  ], { contentVersion: 2 }));
  const remote = workspace(makeProject([
    item('A', 's1', 0, '电瓶', 'ON'),
    item('C', 's1', 1, '襟翼', 'SET', { version: 2 }),
    item('B', 's1', 2, '燃油', 'CHECKED', { version: 3 })
  ], { contentVersion: 3 }));
  const { state, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  assert(hasConflicts === true, '场景1b: 两页都调顺序应冲突');
  const orderConflicts = state.projects[0].conflicts.filter(c => c.reason === 'order');
  assert(orderConflicts.length >= 1, '场景1b: 至少一个 order 冲突');
}

// 场景2：甲改 A，乙改 B（完全不同项），应无冲突合并
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油', 'CHECKED')]));
  const local = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON CHECK', 'ON', { version: 2 }), item('B', 's1', 1, '燃油', 'CHECKED')], { contentVersion: 2 }));
  const remote = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油量', 'CHECKED', { version: 2 })], { contentVersion: 3 }));
  const { state, merged, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  const p = state.projects[0];
  assert(hasConflicts === false, '场景2: 改不同项不应有冲突');
  assert(merged === true, '场景2: 应标记合并');
  const A = p.items.find(i => i.id === 'A');
  const B = p.items.find(i => i.id === 'B');
  assert(A.response === 'ON CHECK', '场景2: 甲对A的修改保留');
  assert(B.challenge === '燃油量', '场景2: 乙对B的修改合入');
  assert(p.orderCheckPending === false, '场景2: 顺序没变不应要求重算');
}

// 场景3：同一检查项两页改同一字段 -> 冲突挂起，保留双方快照，不覆盖
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON')]));
  const local = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON（甲改）', 'ON', { version: 2 })], { contentVersion: 2 }));
  const remote = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON（乙改）', 'ON', { version: 3 })], { contentVersion: 3 }));
  const { state, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  const p = state.projects[0];
  assert(hasConflicts === true, '场景3: 同项两页都改同一字段应有冲突');
  assert(p.conflicts.length === 1, '场景3: 恰好 1 个冲突');
  const c = p.conflicts[0];
  assert(c.itemId === 'A' && c.reason === 'both-edited', '场景3: both-edited');
  assert(c.localSnapshot.response === 'ON（甲改）', '场景3: 保留甲快照');
  assert(c.remoteSnapshot.response === 'ON（乙改）', '场景3: 保留乙快照');
  assert(c.localHolder === '甲' && c.remoteHolder === '乙', '场景3: 记录双方页面名');
  assert(p.items[0].response === 'ON（甲改）', '场景3: 列表为本页版本，互不覆盖');
}

// 场景4：甲改 A，乙删 A -> 冲突
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油', 'CHECKED')]));
  const local = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON!', 'ON', { version: 2 }), item('B', 's1', 1, '燃油', 'CHECKED')], { contentVersion: 2 }));
  const remote = workspace(makeProject([item('B', 's1', 0, '燃油', 'CHECKED')], { contentVersion: 3 }));
  const { state, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  const p = state.projects[0];
  assert(hasConflicts === true, '场景4: 他删我改应有冲突');
  assert(p.conflicts[0].reason === 'remote-deleted', '场景4: remote-deleted');
  assert(p.conflicts[0].remoteSnapshot === null, '场景4: 他页快照为 null');
  assert(p.items.some(i => i.id === 'A'), '场景4: 甲的修改保留待裁决');
}

// 场景5：甲没改，乙改了 -> 纯同步
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON')]));
  const local = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON')]));
  const remote = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON', { critical: true, version: 2 })], { contentVersion: 5 }));
  const { state, merged, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  const p = state.projects[0];
  assert(hasConflicts === false && merged === true, '场景5: 纯同步应 merged 且无冲突');
  assert(p.items[0].critical === true, '场景5: 采用他页修改');
  assert(p.contentVersion === 5, '场景5: 本页无新写入，版本沿用他页');
}

// 场景6：仅顺序变化触发 orderCheckPending
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油', 'CHECKED')]));
  const local = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON'), item('B', 's1', 1, '燃油', 'CHECKED')]));
  const remote = workspace(makeProject([item('B', 's1', 0, '燃油', 'CHECKED', { version: 2 }), item('A', 's1', 1, '电瓶', 'ON', { version: 2 })], { contentVersion: 4, orderCheckPending: true }));
  const { state } = mergeWorkspace(base, local, remote, '甲', '乙');
  assert(state.projects[0].orderCheckPending === true, '场景6: 他页顺序变化必须要求重新核对可达性');
}

// 场景7：hasPendingEdits
{
  const base = makeProject([item('A', 's1', 0, '电瓶', 'ON')]);
  assert(hasPendingEdits(base, makeProject([item('A', 's1', 0, '电瓶', 'ON')])) === false, '场景7: 内容一致无待存');
  assert(hasPendingEdits(base, makeProject([item('A', 's1', 0, '电瓶', 'ON', 'ON', { version: 2 })], { contentVersion: 2 })) === true, '场景7: 版本变化算待存');
  assert(hasPendingEdits(undefined, makeProject([])) === true, '场景7: 无基准视为待存');
}

// 场景8：冲突解决后他页不再有冲突 -> 合并时冲突消失
{
  const base = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON')]));
  const local = workspace(makeProject([item('A', 's1', 0, '电瓶', '甲', 'ON', { version: 2 })], {
    contentVersion: 2,
    conflicts: [{ itemId: 'A', reason: 'both-edited', localSnapshot: item('A', 's1', 0, '电瓶', '甲', 'ON', { version: 2 }), remoteSnapshot: item('A', 's1', 0, '电瓶', '乙', 'ON', { version: 2 }), localHolder: '甲', remoteHolder: '乙', challenge: '电瓶', createdAt: '2026-01-02' }]
  }));
  const remote = workspace(makeProject([item('A', 's1', 0, '乙解决', 'ON', { version: 5 })], { contentVersion: 6, conflicts: [] }));
  const { state, hasConflicts } = mergeWorkspace(base, local, remote, '甲', '乙');
  // 他页已解决冲突且又有改动：本页仍有本地冲突记录，但同项都改 -> 重新挂冲突（保守）。这里验证远程冲突并集逻辑：
  // 若本页没带冲突，则不应凭空出现冲突
  const local2 = workspace(makeProject([item('A', 's1', 0, '电瓶', 'ON', 'ON')], { contentVersion: 1, conflicts: [] }));
  const r2 = mergeWorkspace(base, local2, remote, '甲', '乙');
  assert(r2.hasConflicts === false, '场景8: 双方都无待处理冲突时不应凭空产生');
  assert(r2.state.projects[0].items[0].challenge === '乙解决', '场景8: 采用他页已解决后的版本');
  void hasConflicts; void state;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
