import type { ChecklistItem, ChecklistProject, FlightStage, WorkspaceState } from './types';

const stages: FlightStage[] = [
  { id: 'stage-preflight', name: '飞行前检查', order: 0, description: '驾驶舱准备与飞机状态核对。' },
  { id: 'stage-start', name: '发动机启动', order: 1, description: '启动前风险确认与发动机监控。' },
  { id: 'stage-taxi', name: '滑行', order: 2, description: '滑行许可、航向和障碍物监控。' },
  { id: 'stage-takeoff', name: '起飞', order: 3, description: '起飞构型与跑道状态确认。' },
  { id: 'stage-climb', name: '爬升', order: 4, description: '爬升推力、航向和增压确认。' },
  { id: 'stage-approach', name: '进近', order: 5, description: '进近简令、最低高度和复飞准备。' },
  { id: 'stage-landing', name: '着陆', order: 6, description: '着陆构型、风况和跑道核对。' }
];

const item = (
  id: string,
  stageId: string,
  order: number,
  challenge: string,
  response: string,
  critical = false,
  preconditionIds: string[] = [],
  abnormalProcedure = ''
): ChecklistItem => ({
  id,
  stageId,
  order,
  challenge,
  response,
  critical,
  preconditionIds,
  abnormalProcedure,
  updatedAt: '2026-09-25T00:00:00.000Z'
});

const items: ChecklistItem[] = [
  item('item-battery', 'stage-preflight', 0, '电瓶', 'ON', true, [], '若电瓶电压低于 24V，停止启动并联系机务。'),
  item('item-fuel', 'stage-preflight', 1, '燃油量', 'CHECKED', true, [], '燃油不可用或存在水分时，停止任务。'),
  item('item-altimeter', 'stage-preflight', 2, '高度表', 'SET', false, [], '核对场压并交叉检查左右高度表。'),
  item('item-beacon', 'stage-start', 0, '防撞灯', 'ON', false, ['item-battery'], '灯不亮时关闭发动机并排故。'),
  item('item-start-clear', 'stage-start', 1, '启动区域', 'CLEAR', true, ['item-beacon'], '发现人员或设备进入螺旋桨区域时立即中止启动。'),
  item('item-taxi-clearance', 'stage-taxi', 0, '滑行许可', 'RECEIVED', true, [], '许可不清楚时停止滑行并要求重复。'),
  item('item-taxi-instruments', 'stage-taxi', 1, '飞行仪表', 'CHECKED', false, ['item-battery'], '姿态或航向指示异常时返回停机位。'),
  item('item-runway', 'stage-takeoff', 0, '跑道', 'CONFIRMED', true, ['item-taxi-clearance'], '跑道占用或标识不清时禁止起飞。'),
  item('item-flaps', 'stage-takeoff', 1, '襟翼', '', true, [], '构型不一致时执行中断起飞程序。'),
  item('item-climb-power', 'stage-climb', 0, '爬升功率', 'SET', false, ['item-runway'], '推力异常时保持航向并执行检查单。'),
  item('item-pressurization', 'stage-climb', 1, '增压', 'CHECKED', false, ['item-climb-power'], '增压异常时下降低于 10,000 英尺。'),
  item('item-approach-brief', 'stage-approach', 0, '进近简令', 'COMPLETE', false, [], '条件变化后重新完成简令。'),
  item('item-minimums', 'stage-approach', 1, '最低高度', 'SET', true, ['item-altimeter'], '低于最低高度前必须建立目视参考或复飞。'),
  item('item-landing-gear', 'stage-landing', 0, '起落架', 'DOWN', true, ['item-minimums'], '未三绿时立即复飞。'),
  item('item-landing-clear', 'stage-landing', 1, '着陆跑道', 'CLEAR', true, ['item-runway'], '跑道不安全时执行复飞。')
];

const project: ChecklistProject = {
  id: 'project-c172',
  name: 'C172 标准操作检查单',
  aircraft: 'Cessna 172S / B-1028',
  revision: 3,
  status: 'draft',
  updatedAt: '2026-09-25T00:12:00.000Z',
  reviewNote: '',
  stages: structuredClone(stages),
  items: structuredClone(items),
  revisions: [
    {
      id: 'revision-2',
      revision: 2,
      status: 'frozen',
      createdAt: '2026-09-20T04:20:00.000Z',
      note: '训练飞行前发布版本',
      stages: structuredClone(stages),
      items: structuredClone(items.filter((entry) => entry.id !== 'item-pressurization').map((entry) => entry.id === 'item-flaps' ? { ...entry, response: 'CHECKED' } : entry))
    },
    {
      id: 'revision-1',
      revision: 1,
      status: 'frozen',
      createdAt: '2026-09-12T07:30:00.000Z',
      note: '初始基线',
      stages: structuredClone(stages.slice(0, 5)),
      items: structuredClone(items.filter((entry) => entry.id !== 'item-pressurization' && entry.id !== 'item-landing-clear'))
    }
  ]
};

export const createInitialState = (): WorkspaceState => ({
  schemaVersion: 1,
  selectedProjectId: project.id,
  projects: [project]
});
