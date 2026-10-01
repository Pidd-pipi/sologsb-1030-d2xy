import type {
  ChecklistItem,
  ChecklistProject,
  FlightStage,
  ItemConflict,
  WorkspaceState
} from './types';

const nowIso = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

/** 参与逐项版本核对的字段；updatedAt 只是时间戳，不代表内容变化。 */
const ITEM_FIELDS = ['stageId', 'order', 'challenge', 'response', 'critical', 'preconditionIds', 'abnormalProcedure', 'version'] as const;
const STAGE_FIELDS = ['name', 'order', 'description', 'version'] as const;

type ItemSignature = Pick<ChecklistItem, (typeof ITEM_FIELDS)[number]>;
type StageSignature = Pick<FlightStage, (typeof STAGE_FIELDS)[number]>;

const itemSignature = (item: ChecklistItem): ItemSignature => ({
  stageId: item.stageId,
  order: item.order,
  challenge: item.challenge,
  response: item.response,
  critical: item.critical,
  preconditionIds: item.preconditionIds,
  abnormalProcedure: item.abnormalProcedure,
  version: item.version
});

/** 返回相对基准发生变化的业务字段（version 由写入方递增，不单独参与字段冲突判断）。 */
const ITEM_MERGE_FIELDS = ['stageId', 'order', 'challenge', 'response', 'critical', 'preconditionIds', 'abnormalProcedure'] as const;
type ItemMergeField = (typeof ITEM_MERGE_FIELDS)[number];

function changedItemFields(base: ChecklistItem, current: ChecklistItem): Set<ItemMergeField> {
  const changed = new Set<ItemMergeField>();
  ITEM_MERGE_FIELDS.forEach((field) => {
    if (JSON.stringify(base[field]) !== JSON.stringify(current[field])) changed.add(field);
  });
  return changed;
}

/** 把来源检查项的单个业务字段安全赋值到目标检查项（字段值类型随字段名收窄）。 */
function assignItemField(target: ChecklistItem, field: ItemMergeField, source: ChecklistItem) {
  switch (field) {
    case 'stageId': target.stageId = source.stageId; break;
    case 'order': target.order = source.order; break;
    case 'challenge': target.challenge = source.challenge; break;
    case 'response': target.response = source.response; break;
    case 'critical': target.critical = source.critical; break;
    case 'preconditionIds': target.preconditionIds = clone(source.preconditionIds); break;
    case 'abnormalProcedure': target.abnormalProcedure = source.abnormalProcedure; break;
  }
}

const stageSignature = (stage: FlightStage): StageSignature => ({
  name: stage.name,
  order: stage.order,
  description: stage.description,
  version: stage.version
});

/** 对比项目里会被编辑的内容；时间戳、修订快照列表不参与"本地是否有未合并修改"的判断。 */
interface ProjectContent {
  name: string;
  aircraft: string;
  revision: number;
  status: ChecklistProject['status'];
  reviewNote: string;
  stages: StageSignature[];
  items: ItemSignature[];
  contentVersion: number;
  orderCheckPending: boolean;
  conflicts: ItemConflict[];
}

export const projectContentSignature = (project: ChecklistProject): ProjectContent => ({
  name: project.name,
  aircraft: project.aircraft,
  revision: project.revision,
  status: project.status,
  reviewNote: project.reviewNote,
  stages: project.stages.map(stageSignature),
  items: project.items.map(itemSignature),
  contentVersion: project.contentVersion,
  orderCheckPending: project.orderCheckPending,
  conflicts: project.conflicts
});

/** 判断失租旧页面是否带着未落盘的修改等待重新确认。 */
export function hasPendingEdits(base: ChecklistProject | undefined, local: ChecklistProject): boolean {
  if (!base) return true;
  return JSON.stringify(projectContentSignature(base)) !== JSON.stringify(projectContentSignature(local));
}

export interface MergeOutcome {
  state: WorkspaceState;
  /** 本次合并是否把两页的修改合到了一起（而非原样采用其中一方）。 */
  merged: boolean;
  /** 是否产生了需要人工处理的同项冲突。 */
  hasConflicts: boolean;
}

/**
 * 工作区级三方合并。
 *
 * @param base   本页上次确认时的存储快照
 * @param local  本页当前状态（失租期间可能带着未保存修改）
 * @param remote 存储中他页最新写入的状态
 * @param localHolder / remoteHolder 页面名，写入冲突记录供人工辨认
 */
export function mergeWorkspace(
  base: WorkspaceState | undefined,
  local: WorkspaceState,
  remote: WorkspaceState,
  localHolder: string,
  remoteHolder: string
): MergeOutcome {
  const next = clone(local);
  next.selectedProjectId = local.selectedProjectId || remote.selectedProjectId;

  const remoteById = new Map(remote.projects.map((project) => [project.id, project]));
  const nextProjects: ChecklistProject[] = [];
  let merged = false;
  let hasConflicts = false;

  for (const localProject of next.projects) {
    const remoteProject = remoteById.get(localProject.id);
    if (!remoteProject) {
      nextProjects.push(localProject);
      continue;
    }
    remoteById.delete(localProject.id);
    const baseProject = base?.projects.find((project) => project.id === localProject.id);
    if (!baseProject) {
      nextProjects.push(clone(remoteProject));
      continue;
    }
    const result = mergeProject(baseProject, localProject, remoteProject, localHolder, remoteHolder);
    nextProjects.push(result.project);
    merged = merged || result.merged;
    hasConflicts = hasConflicts || result.hasConflicts;
  }

  // 他页新建的项目直接采用。
  for (const remaining of remoteById.values()) nextProjects.push(clone(remaining));

  next.projects = nextProjects;
  return { state: next, merged, hasConflicts };
}

interface ProjectMergeResult {
  project: ChecklistProject;
  merged: boolean;
  hasConflicts: boolean;
}

function mergeProject(
  base: ChecklistProject,
  local: ChecklistProject,
  remote: ChecklistProject,
  localHolder: string,
  remoteHolder: string
): ProjectMergeResult {
  const project = clone(local);
  let merged = false;
  let hasConflicts = false;
  const localDirty = JSON.stringify(projectContentSignature(base)) !== JSON.stringify(projectContentSignature(local));

  const localChanged = (key: keyof ChecklistProject) => JSON.stringify(local[key]) !== JSON.stringify(base[key]);
  const remoteChanged = (key: keyof ChecklistProject) => JSON.stringify(remote[key]) !== JSON.stringify(base[key]);

  // 标量字段：各改各的直接合入；两页都改同一字段以本页为准并记录合并。
  (['name', 'aircraft', 'reviewNote'] as const).forEach((key) => {
    if (remoteChanged(key) && !localChanged(key)) {
      project[key] = clone(remote[key]);
      merged = true;
    } else if (remoteChanged(key) && localChanged(key) && local[key] !== remote[key]) {
      project[key] = clone(local[key]);
      merged = true;
    }
  });

  // 发布状态：只有本页没动过时才采用他页（工作流迁移只可能发生在持锁页）。
  if (!localChanged('status') && remoteChanged('status')) {
    project.status = remote.status;
    merged = true;
  }
  project.revision = Math.max(local.revision, remote.revision);

  // 冻结快照两边并集。
  const revisionIds = new Set(project.revisions.map((entry) => entry.id));
  for (const entry of remote.revisions) {
    if (!revisionIds.has(entry.id)) {
      project.revisions.push(clone(entry));
      revisionIds.add(entry.id);
    }
  }
  project.revisions.sort((a, b) => b.revision - a.revision);

  // 阶段三方合并。
  const stageResult = mergeStages(base, local, remote);
  project.stages = stageResult.stages;
  merged = merged || stageResult.merged;
  hasConflicts = hasConflicts || stageResult.hasConflicts;

  // 检查项三方合并。
  const itemResult = mergeItems(base, local, remote, localHolder, remoteHolder, project.conflicts, remote.conflicts);
  project.items = itemResult.items;
  project.conflicts = itemResult.conflicts;
  merged = merged || itemResult.merged;
  hasConflicts = hasConflicts || itemResult.hasConflicts;

  // 任何一方的顺序变动都要求重新核对前置条件可达性。
  const orderChanged =
    JSON.stringify(base.items.map((item) => `${item.id}@${item.stageId}#${item.order}`)) !==
      JSON.stringify(remote.items.map((item) => `${item.id}@${item.stageId}#${item.order}`)) ||
    JSON.stringify(base.stages.map((stage) => `${stage.id}#${stage.order}`)) !==
      JSON.stringify(remote.stages.map((stage) => `${stage.id}#${stage.order}`));
  if (orderChanged) project.orderCheckPending = true;

  project.updatedAt = merged || itemResult.hasConflicts || stageResult.hasConflicts ? nowIso() : remote.updatedAt;
  // 本页有未保存内容才代表一次新写入；纯同步采用他页内容时沿用他页版本号。
  project.contentVersion = Math.max(local.contentVersion, remote.contentVersion) + (localDirty ? 1 : 0);
  return { project, merged, hasConflicts };
}

interface StageMergeResult {
  stages: FlightStage[];
  merged: boolean;
  hasConflicts: boolean;
}

function mergeStages(base: ChecklistProject, local: ChecklistProject, remote: ChecklistProject): StageMergeResult {
  const baseById = new Map(base.stages.map((stage) => [stage.id, stage]));
  const localById = new Map(local.stages.map((stage) => [stage.id, stage]));
  const remoteById = new Map(remote.stages.map((stage) => [stage.id, stage]));
  const stages: FlightStage[] = [];
  let merged = false;

  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  const orderedIds = [
    ...local.stages.map((stage) => stage.id),
    ...remote.stages.filter((stage) => !localById.has(stage.id)).map((stage) => stage.id)
  ].filter((id, index, array) => allIds.has(id) && array.indexOf(id) === index);

  for (const id of orderedIds) {
    const localStage = localById.get(id);
    const remoteStage = remoteById.get(id);
    const baseStage = baseById.get(id);

    if (localStage && remoteStage && baseStage) {
      const stage = clone(localStage);
      const lChanged = JSON.stringify(stageSignature(baseStage)) !== JSON.stringify(stageSignature(localStage));
      const rChanged = JSON.stringify(stageSignature(baseStage)) !== JSON.stringify(stageSignature(remoteStage));
      if (rChanged && !lChanged) {
        Object.assign(stage, clone(remoteStage));
        merged = true;
      } else if (rChanged && lChanged) {
        // 两页都改：以本页为准，version 取较大者 +1，顺序冲突交由 orderCheckPending 与人工核对兜底。
        stage.version = Math.max(localStage.version, remoteStage.version) + 1;
        merged = true;
      }
      stages.push(stage);
    } else if (localStage && !remoteStage) {
      const lChanged = baseStage && JSON.stringify(stageSignature(baseStage)) !== JSON.stringify(stageSignature(localStage));
      if (lChanged) {
        // 他页删了阶段、本页改过该阶段：保留本页版本，交由可达性校验与人工处理。
        stages.push(clone(localStage));
        merged = true;
      }
      // 本页没改，则认同他页的删除。
    } else if (!localStage && remoteStage) {
      stages.push(clone(remoteStage!));
      merged = true;
    }
  }
  stages.sort((a, b) => a.order - b.order).forEach((stage, order) => { stage.order = order; });
  return { stages, merged, hasConflicts: false };
}

interface ItemMergeResult {
  items: ChecklistItem[];
  conflicts: ItemConflict[];
  merged: boolean;
  hasConflicts: boolean;
}

function mergeItems(
  base: ChecklistProject,
  local: ChecklistProject,
  remote: ChecklistProject,
  localHolder: string,
  remoteHolder: string,
  existingConflicts: ItemConflict[],
  remoteConflicts: ItemConflict[]
): ItemMergeResult {
  const baseById = new Map(base.items.map((item) => [item.id, item]));
  const localById = new Map(local.items.map((item) => [item.id, item]));
  const remoteById = new Map(remote.items.map((item) => [item.id, item]));

  // 双方待处理冲突取并集（同一项以最新的本地记录为准），任何一方解决过的冲突随之消失。
  const conflicts: ItemConflict[] = clone(existingConflicts);
  const knownIds = new Set(conflicts.map((conflict) => conflict.itemId));
  for (const remoteConflict of remoteConflicts) {
    if (knownIds.has(remoteConflict.itemId)) continue;
    conflicts.push(clone(remoteConflict));
    knownIds.add(remoteConflict.itemId);
  }
  const conflictIds = new Set(conflicts.map((conflict) => conflict.itemId));
  const items: ChecklistItem[] = [];
  let merged = false;
  let hasConflicts = conflicts.length > 0;

  const pushConflict = (conflict: ItemConflict) => {
    const index = conflicts.findIndex((entry) => entry.itemId === conflict.itemId);
    if (index >= 0) conflicts[index] = conflict;
    else conflicts.push(conflict);
    conflictIds.add(conflict.itemId);
    hasConflicts = true;
  };

  const orderedIds = [
    ...local.items.map((item) => item.id),
    ...remote.items.filter((item) => !localById.has(item.id)).map((item) => item.id)
  ].filter((id, index, array) => array.indexOf(id) === index);

  for (const id of orderedIds) {
    const localItem = localById.get(id);
    const remoteItem = remoteById.get(id);
    const baseItem = baseById.get(id);

    if (localItem && remoteItem && baseItem) {
      const lChangedFields = changedItemFields(baseItem, localItem);
      const rChangedFields = changedItemFields(baseItem, remoteItem);
      const lChanged = lChangedFields.size > 0;
      const rChanged = rChangedFields.size > 0;
      if (lChanged && rChanged) {
        // 同一检查项两页都改过：按字段三方合并。
        // 改到不同字段（如甲调顺序、乙改前置条件）自动合入；改到同一字段则互不覆盖、挂起人工处理。
        const overlap = [...lChangedFields].filter((field) => rChangedFields.has(field));
        const mergedItem = clone(localItem);
        let fieldMerged = false;
        for (const field of rChangedFields) {
          if (!lChangedFields.has(field)) {
            assignItemField(mergedItem, field, remoteItem);
            fieldMerged = true;
          }
        }
        if (overlap.length > 0) {
          // 有同字段并发修改：以本页版本为列表内容，他页字段快照保留在冲突记录里供人工选择。
          items.push(clone(mergedItem));
          if (!conflictIds.has(id)) {
            const reason: ItemConflict['reason'] = overlap.every((field) => field === 'order' || field === 'stageId') ? 'order' : 'both-edited';
            pushConflict({
              itemId: id,
              reason,
              localSnapshot: clone(localItem),
              remoteSnapshot: clone(remoteItem),
              localHolder,
              remoteHolder,
              challenge: localItem.challenge || remoteItem.challenge || '未命名检查项',
              createdAt: nowIso()
            });
          }
          if (fieldMerged) merged = true;
        } else {
          // 两页改的字段完全不相交：字段级自动合并，版本取双方较大者 +1。
          mergedItem.version = Math.max(localItem.version, remoteItem.version) + 1;
          mergedItem.updatedAt = nowIso();
          items.push(mergedItem);
          merged = true;
        }
      } else if (rChanged && !lChanged) {
        // 他页改、本页没改：采用他页版本（纯同步）。
        items.push(clone(remoteItem));
        merged = true;
      } else {
        // 本页改过、他页没改；或两边恰好改成一致：直接保留本页。
        items.push(clone(localItem));
      }
    } else if (localItem && !remoteItem && baseItem) {
      const lChanged = changedItemFields(baseItem, localItem).size > 0;
      if (lChanged) {
        // 他页删除、本页改了：保留本页修改并挂起，由人工决定保留还是删除。
        items.push(clone(localItem));
        if (!conflictIds.has(id)) {
          pushConflict({
            itemId: id,
            reason: 'remote-deleted',
            localSnapshot: clone(localItem),
            remoteSnapshot: null,
            localHolder,
            remoteHolder,
            challenge: localItem.challenge || '未命名检查项',
            createdAt: nowIso()
          });
        }
      }
      // 本页没改，则认同他页的删除。
    } else if (!localItem && remoteItem && baseItem) {
      const rChanged = changedItemFields(baseItem, remoteItem).size > 0;
      if (rChanged) {
        // 本页删除、他页改了：以冲突挂起，保留他页快照供人工恢复。
        if (!conflictIds.has(id)) {
          pushConflict({
            itemId: id,
            reason: 'local-deleted',
            localSnapshot: null,
            remoteSnapshot: clone(remoteItem),
            localHolder,
            remoteHolder,
            challenge: remoteItem.challenge || '未命名检查项',
            createdAt: nowIso()
          });
        }
      } else {
        // 两边都删，保持删除。
      }
    } else if (localItem && remoteItem) {
      // 基准里没有：两边各自新建同 id 的情况（理论极少），按同项冲突处理。
      items.push(clone(localItem));
      if (!conflictIds.has(id)) {
        pushConflict({
          itemId: id,
          reason: 'both-edited',
          localSnapshot: clone(localItem),
          remoteSnapshot: clone(remoteItem),
          localHolder,
          remoteHolder,
          challenge: localItem.challenge || remoteItem.challenge || '未命名检查项',
          createdAt: nowIso()
        });
      }
    } else if (localItem) {
      items.push(clone(localItem));
    } else if (remoteItem) {
      items.push(clone(remoteItem));
      merged = true;
    }
  }

  // 顺序整理：各阶段内重新编号，避免合并后出现重复序号。
  items.sort((a, b) => {
    if (a.stageId !== b.stageId) return a.stageId.localeCompare(b.stageId);
    return a.order - b.order;
  });
  const counters = new Map<string, number>();
  items.forEach((item) => {
    const nextOrder = counters.get(item.stageId) ?? 0;
    item.order = nextOrder;
    counters.set(item.stageId, nextOrder + 1);
  });

  return { items, conflicts, merged, hasConflicts };
}
