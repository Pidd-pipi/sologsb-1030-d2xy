export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType = 'duplicate' | 'missing-response' | 'unreachable-precondition' | 'stage-order' | 'orphan-stage';

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
  /** 阶段级版本号，任一页面修改后递增，用于三方合并比对。 */
  version: number;
}

export interface ChecklistItem {
  id: string;
  stageId: string;
  order: number;
  challenge: string;
  response: string;
  critical: boolean;
  preconditionIds: string[];
  abnormalProcedure: string;
  updatedAt: string;
  /** 检查项级版本号，保存前逐项核对，判断两页是否改过同一项。 */
  version: number;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

/** 同一检查项被两个页面同时修改时挂起的人工处理记录。 */
export type ConflictReason = 'both-edited' | 'remote-deleted' | 'local-deleted' | 'order';

export interface ItemConflict {
  itemId: string;
  reason: ConflictReason;
  /** 触发合并的本页面对应的检查项快照；若本页已删除则为 null。 */
  localSnapshot: ChecklistItem | null;
  /** 另一页面对应的检查项快照；若对方已删除则为 null。 */
  remoteSnapshot: ChecklistItem | null;
  localHolder: string;
  remoteHolder: string;
  challenge: string;
  createdAt: string;
}

/** 编辑租约：同一检查单同一时刻只允许一个页面写入。 */
export interface EditLease {
  projectId: string;
  holderId: string;
  holderName: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export type SaveStatus = 'saved' | 'uptodate' | 'merged' | 'synced' | 'conflicts' | 'readonly' | 'lease-lost' | 'blocked';

export interface SaveResult {
  status: SaveStatus;
  detail?: string;
}

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
  /** 项目内容版本号，每次写入递增；保存前与存储中的版本核对。 */
  contentVersion: number;
  /** 顺序（含跨页同步过来的顺序）变化后置为 true，重新核对可达性前禁止复核/冻结。 */
  orderCheckPending: boolean;
  /** 待人工处理的同项并发修改；未清空之前不能提交复核或冻结。 */
  conflicts: ItemConflict[];
}

export interface WorkspaceState {
  schemaVersion: 1;
  selectedProjectId: string;
  projects: ChecklistProject[];
}

export interface ValidationIssue {
  id: string;
  type: IssueType;
  level: IssueLevel;
  stageId?: string;
  itemId?: string;
  title: string;
  detail: string;
}

export interface VersionOption {
  id: string;
  label: string;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'changed' | 'stage';
  key: string;
  stage: string;
  before: string;
  after: string;
}
